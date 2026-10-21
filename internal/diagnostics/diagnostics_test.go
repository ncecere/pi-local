package diagnostics

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func readZip(t *testing.T, data []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		raw, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = string(raw)
	}
	return out
}

func TestDiagnosticsHaveNoSecretsAndNoConversations(t *testing.T) {
	dir := t.TempDir()
	home, _ := os.UserHomeDir()
	log := filepath.Join(dir, "runtime.log")
	var lines []string
	for i := 0; i < 2500; i++ {
		lines = append(lines, "starting runtime line")
	}
	lines = append(lines,
		"[pi-local] model call failed: 401 with Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123",
		"MCP_SERVERS={\"github\":{\"env\":{\"GITHUB_TOKEN\":\"ghp_abcdefghijklmnopqrstuvwxyz0123456789\"}}}",
		"opened "+filepath.Join(home, "Library", "Pi Local", "agents", "ag_x", "workspace"),
		"uncaught exception: something broke",
	)
	os.WriteFile(log, []byte(strings.Join(lines, "\n")+"\n"), 0o600)

	var buf bytes.Buffer
	err := Write(&buf, Input{
		Now: time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC), Version: "0.3.0", DataDir: filepath.Join(home, "Library", "Pi Local"),
		Node: "v22.19.0", PiDurable: "1.3.0", Contract: 3,
		Settings: map[string]string{
			"default_model": "openai/gpt-5", "about_me": `{"name":"Ann Example","role":"nurse"}`,
			"judgments":      `{"enabled":true,"url":"https://api.typesafe.ai","apiKey":"tsk-should-not-be-here-1234567890abcdef"}`,
			"web_search_url": "https://user:hunter2@search.example/q?api_key=abc123",
		},
		Providers:  []map[string]any{{"id": "openai", "name": "OpenAI", "hasKey": true, "headerNames": []string{"OpenAI-Organization"}, "apiKey": "sk-leaked-abcdefghijklmnopqrstuv"}},
		MCPServers: []map[string]any{{"slug": "github", "args": []string{"--token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"}, "url": "https://mcp.example/sse?token=secrettoken123"}},
		Agents: []Agent{{
			ID: "ag_aaaaaaaaaaaaaaaa", Name: "Helper", Kind: "assistant", Model: "openai/gpt-5", Status: "error", LastError: "the key sk-abcdefghijklmnopqrstuvwxyz0123 was refused",
			ConfigYAML: "name: Helper\ninstructions: '[omitted, 40 characters]'\napprovals:\n  tools: [bash]\n", LogPath: log,
		}},
		AppLog:        []string{"time=2026-10-21T09:00:00Z level=INFO msg=started", "time=2026-10-21T09:00:01Z level=WARN msg=\"a backup failed\" err=\"disk full\""},
		ServiceErrors: []string{"[MCP: Broken connection] probe refused the key sk-abcdefghijklmnopqrstuvwxyz0123"},
	})
	if err != nil {
		t.Fatal(err)
	}
	files := readZip(t, buf.Bytes())
	var names []string
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	got := strings.Join(names, ",")
	if got != "README.txt,about.json,agents.json,agents/ag_aaaaaaaaaaaaaaaa/agent.yaml,agents/ag_aaaaaaaaaaaaaaaa/runtime.log,app.log,mcp-servers.json,providers.json,recent-errors.txt,settings.json" {
		t.Fatalf("files: %s", got)
	}
	all := ""
	for _, text := range files {
		all += text
	}
	for _, secret := range []string{"sk-abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "hunter2", "abc123&", "secrettoken123", "sk-leaked", "tsk-should-not", "Ann Example", "nurse"} {
		if strings.Contains(all, secret) {
			t.Errorf("%q is in the bundle", secret)
		}
	}
	if strings.Contains(all, home) && home != "/" {
		t.Error("the home folder's path (the person's user name) is in the bundle")
	}
	// What helps is there: names of keys, versions, the status, the last 2,000 log lines, the errors.
	if !strings.Contains(files["providers.json"], "OpenAI-Organization") || !strings.Contains(files["about.json"], `"piDurable": "1.3.0"`) {
		t.Errorf("providers: %s about: %s", files["providers.json"], files["about.json"])
	}
	runtimeLog := files["agents/ag_aaaaaaaaaaaaaaaa/runtime.log"]
	if n := strings.Count(runtimeLog, "\n"); n != LogLines {
		t.Errorf("the log has %d lines", n)
	}
	if !strings.Contains(runtimeLog, "Authorization: [redacted") || !strings.Contains(runtimeLog, "~/Library/Pi Local") {
		t.Errorf("log: …%s", runtimeLog[len(runtimeLog)-500:])
	}
	errs := files["recent-errors.txt"]
	for _, want := range []string{"[MCP: Broken connection] probe refused the key [redacted", "[Helper] the agent's status is \"error\"", "[Helper] [pi-local] model call failed", "uncaught exception", "[app] time=2026-10-21T09:00:01Z level=WARN"} {
		if !strings.Contains(errs, want) {
			t.Errorf("recent errors lack %q:\n%s", want, errs)
		}
	}
	if strings.Contains(errs, "starting runtime line") || strings.Contains(errs, "level=INFO") {
		t.Errorf("recent errors hold ordinary lines:\n%s", errs)
	}
	if strings.Contains(files["settings.json"], "about_me") {
		t.Error("the About me card is in the bundle")
	}
}
