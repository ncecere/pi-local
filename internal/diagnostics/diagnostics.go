// Package diagnostics writes the zip a person can send when something goes wrong: versions, the computer, settings and
// agent configurations without secrets, the end of every log, and the recent errors. Everything free-form goes
// through the redaction rules approvals use (agents.RedactText); conversations, memory and files are never included.
package diagnostics

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/ncecere/pi-local/internal/agents"
)

// LogLines is how many lines of each log go in.
const LogLines = 2000

// Agent is what diagnostics say of one agent.
type Agent struct {
	ID        string
	Name      string
	Kind      string
	Model     string
	Status    string
	LastError string
	PiDurable string
	Revision  int
	// StorageBytes is the size of its conversations file.
	StorageBytes int64
	// ConfigYAML is its agent.yaml (instructions already left out).
	ConfigYAML string
	// LogPath is its runtime log.
	LogPath string
}

// Input is everything a bundle is made of.
type Input struct {
	Now               time.Time
	Version           string
	DataDir           string
	Node              string
	PiDurable         string
	Contract          int
	SecretsInKeychain bool
	// Settings are app.db's settings rows (JSON values, mostly). Personal ones are left out here.
	Settings map[string]string
	// Providers and MCPServers are listed without secret values (their names only).
	Providers  any
	MCPServers any
	Agents     []Agent
	AppLog     []string
	// ServiceErrors include catalog errors (for example MCP probe failures), even when no log line was written.
	ServiceErrors []string
}

// personalSettings are settings that describe the person, not the app.
var personalSettings = map[string]bool{"about_me": true}

// Name is the bundle's file name.
func Name(now time.Time) string {
	return "pi-local-diagnostics-" + now.Format("2006-01-02-150405") + ".zip"
}

// Write writes the bundle.
func Write(w io.Writer, in Input) error {
	home, _ := os.UserHomeDir()
	clean := func(text string) string {
		text = agents.RedactText(text)
		if home != "" && home != "/" {
			text = strings.ReplaceAll(text, home, "~")
		}
		return text
	}
	zw := zip.NewWriter(w)
	add := func(name, text string) error {
		f, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: in.Now})
		if err != nil {
			return err
		}
		_, err = io.WriteString(f, text)
		return err
	}
	addJSON := func(name string, v any) error {
		var decoded any
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &decoded); err != nil {
			return err
		}
		pretty, _ := json.MarshalIndent(agents.RedactValue(decoded), "", "  ")
		return add(name, clean(string(pretty))+"\n")
	}

	if err := add("README.txt", readme); err != nil {
		return err
	}
	about := map[string]any{
		"app": "Pi Local", "version": in.Version, "createdAt": in.Now.Format(time.RFC3339),
		"os": runtime.GOOS, "arch": runtime.GOARCH, "osVersion": osVersion(), "go": runtime.Version(),
		"node": in.Node, "piDurable": in.PiDurable, "contractVersion": in.Contract,
		"dataDir": in.DataDir, "secretsInKeychain": in.SecretsInKeychain, "agents": len(in.Agents),
	}
	if err := addJSON("about.json", about); err != nil {
		return err
	}
	settings := map[string]any{}
	for k, v := range in.Settings {
		if personalSettings[k] {
			continue
		}
		var decoded any
		if json.Unmarshal([]byte(v), &decoded) == nil {
			settings[k] = decoded
		} else {
			settings[k] = v
		}
	}
	if err := addJSON("settings.json", settings); err != nil {
		return err
	}
	if err := addJSON("providers.json", in.Providers); err != nil {
		return err
	}
	if err := addJSON("mcp-servers.json", in.MCPServers); err != nil {
		return err
	}
	summary := []map[string]any{}
	for _, ag := range in.Agents {
		summary = append(summary, map[string]any{
			"id": ag.ID, "name": ag.Name, "kind": ag.Kind, "model": ag.Model, "status": ag.Status, "lastError": ag.LastError,
			"piDurableVersion": ag.PiDurable, "revision": ag.Revision, "storageBytes": ag.StorageBytes,
		})
	}
	if err := addJSON("agents.json", summary); err != nil {
		return err
	}

	var errorsText strings.Builder
	for _, message := range in.ServiceErrors {
		fmt.Fprintln(&errorsText, message)
	}
	noteErrors := func(source string, lines []string) {
		found := ErrorLines(lines)
		for _, line := range found[max(0, len(found)-100):] {
			fmt.Fprintf(&errorsText, "[%s] %s\n", source, line)
		}
	}
	for _, ag := range in.Agents {
		if ag.LastError != "" {
			fmt.Fprintf(&errorsText, "[%s] the agent's status is %q: %s\n", ag.Name, ag.Status, ag.LastError)
		}
	}
	noteErrors("app", in.AppLog)
	if err := add("app.log", clean(strings.Join(tail(in.AppLog, LogLines), "\n"))+"\n"); err != nil {
		return err
	}
	for _, ag := range in.Agents {
		dir := "agents/" + ag.ID + "/"
		if err := add(dir+"agent.yaml", clean(ag.ConfigYAML)); err != nil {
			return err
		}
		lines, err := TailFile(ag.LogPath, LogLines)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			lines = []string{"(the log couldn't be read: " + err.Error() + ")"}
		}
		noteErrors(ag.Name, lines)
		if err := add(dir+"runtime.log", clean(strings.Join(lines, "\n"))+"\n"); err != nil {
			return err
		}
	}
	if errorsText.Len() == 0 {
		errorsText.WriteString("No errors in the recent logs.\n")
	}
	if err := add("recent-errors.txt", clean(errorsText.String())); err != nil {
		return err
	}
	return zw.Close()
}

const readme = `Pi Local diagnostics

What is in this bundle:
- about.json: Pi Local, Node and pi-durable versions, this computer's OS, the data folder's path.
- settings.json, providers.json, mcp-servers.json: how Pi Local is set up. Only the names of keys, headers and
  variables are listed, never their values.
- agents.json and agents/<id>/agent.yaml: each agent's settings. Its instructions are left out.
- app.log and agents/<id>/runtime.log: the last 2,000 lines of each log.
- recent-errors.txt: the errors found in them.

Keys, tokens, passwords and anything that looks like one are replaced with [redacted, N characters] in every file.
Conversations, memory, files, and what you told Pi Local about yourself are not included.
`

var errorWord = regexp.MustCompile(`(?i)\b(error|errors|failed|failure|panic|fatal|exception|unhandled|level=(?:warn|error))\b`)

// ErrorLines are the lines of a log that report a problem.
func ErrorLines(lines []string) []string {
	var out []string
	for _, line := range lines {
		if errorWord.MatchString(line) {
			out = append(out, line)
		}
	}
	return out
}

func tail(lines []string, n int) []string {
	if len(lines) > n {
		return lines[len(lines)-n:]
	}
	return lines
}

// TailFile reads the last n lines of a file, from at most its last 4 MiB.
func TailFile(path string, n int) ([]string, error) {
	if path == "" {
		return nil, os.ErrNotExist
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	const window = 4 << 20
	offset := max(info.Size()-window, 0)
	buf := make([]byte, info.Size()-offset)
	if _, err := f.ReadAt(buf, offset); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	text := strings.TrimRight(string(buf), "\n")
	if text == "" {
		return nil, nil
	}
	lines := strings.Split(text, "\n")
	if offset > 0 && len(lines) > 1 {
		lines = lines[1:] // the first was cut by the window
	}
	return tail(lines, n), nil
}

func osVersion() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	out, err := exec.Command("sw_vers", "-productVersion").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
