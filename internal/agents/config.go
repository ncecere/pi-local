package agents

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// Kinds are the runtime's built-in agents (runtime/src/kinds): AGENT_KIND.
var Kinds = []KindInfo{
	{ID: "assistant", Name: "Assistant", Description: "A general assistant that answers in the conversation."},
	{ID: "researcher", Name: "Researcher", Description: "Plans research, gathers sources, and writes up what it found."},
	{ID: "coding", Name: "Coding", Description: "Works in a project folder like the pi coding agent: reads, edits and writes files and runs commands."},
}

// retiredKinds still run (an agent made with one keeps working) but aren't offered for new agents.
var retiredKinds = []string{"triage"}

// KindDefaults is what a new agent of a kind starts with when the request doesn't say.
func KindDefaults(kind string, c *Config) {
	if kind != "coding" {
		return
	}
	if c.Workspace.Tools == nil {
		// pi's own tools.
		c.Workspace.Tools = []string{"read", "write", "edit", "bash"}
	}
	// Commands ask first: they run as the person, in their real project folder, unconfined. A person can turn that
	// off on the Tools tab (pi itself doesn't ask), or say otherwise when making the agent.
	if c.Approvals.Tools == nil && slices.Contains(c.Workspace.Tools, "bash") {
		c.Approvals.Tools = []string{"bash"}
	}
}

// KindInfo describes a kind for the catalog.
type KindInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func knownKind(kind string) bool {
	for _, k := range Kinds {
		if k.ID == kind {
			return true
		}
	}
	return slices.Contains(retiredKinds, kind)
}

// ModelRef names a model: a provider configured in the app and the model's ID at that provider.
type ModelRef struct {
	Provider string `yaml:"provider" json:"provider"`
	ID       string `yaml:"id" json:"id"`
}

// String is the model's "provider/id" form.
func (m ModelRef) String() string { return m.Provider + "/" + m.ID }

// DemoModel is the runtime's scripted model, which needs no provider or key.
var DemoModel = ModelRef{Provider: "demo", ID: "demo-1"}

// Config is an agent's agent.yaml: everything that makes the agent what it is, portable with its folder, never a
// secret. Later phases add workspace tools, MCP servers, approvals and schedules.
type Config struct {
	Name         string         `yaml:"name"`
	Description  string         `yaml:"description,omitempty"`
	Kind         string         `yaml:"kind"`
	KindSettings map[string]any `yaml:"kindSettings,omitempty"`
	Model        ModelRef       `yaml:"model"`
	Instructions string         `yaml:"instructions,omitempty"`
	// CanCall lists the agents (by ID) this agent may ask with ask_agent, besides what its teams allow.
	CanCall []string `yaml:"canCall,omitempty"`
	// Workspace: the file and shell tools the agent has, working in its workspace folder.
	Workspace Workspace `yaml:"workspace,omitempty"`
	// Approvals: the tools that wait for a person's approval before they run.
	Approvals Approvals `yaml:"approvals,omitempty"`
	// MCP: the MCP servers it uses (from the app's catalog), with all their tools or some.
	MCP []MCPChoice `yaml:"mcp,omitempty"`
	// Schedules: whether it may set its own reminders and recurring work (its schedule tools).
	Schedules AgentSchedules `yaml:"schedules,omitempty"`
	// Web: searching the web (through the search service in Settings) and reading pages.
	Web WebTools `yaml:"web,omitempty"`
}

// WebTools are an agent's web tools (read-only: they change nothing).
type WebTools struct {
	Search bool `yaml:"search,omitempty" json:"search"`
	Fetch  bool `yaml:"fetch,omitempty" json:"fetch"`
}

// AgentSchedules is what an agent may do with schedules.
type AgentSchedules struct {
	AgentMade bool `yaml:"agentMade,omitempty" json:"agentMade"`
}

// MCPChoice is one MCP server an agent uses; Tools nil means every tool it offers the model.
type MCPChoice struct {
	Server string   `yaml:"server" json:"server"`
	Tools  []string `yaml:"tools,omitempty" json:"tools"`
}

// Workspace is an agent's workspace tools, and where they work.
type Workspace struct {
	Tools []string `yaml:"tools,omitempty" json:"tools"`
	// Folder is a project folder on this computer the tools work in (absolute). Empty: the agent's own workspace/.
	Folder string `yaml:"folder,omitempty" json:"folder"`
}

// Approvals says which tools ask first (names, or patterns with *) and how long a request waits.
type Approvals struct {
	Tools          []string `yaml:"tools,omitempty" json:"tools"`
	TimeoutSeconds int      `yaml:"timeoutSeconds,omitempty" json:"timeoutSeconds"`
}

// WorkspaceTools are the tools an agent's workspace may give it.
var WorkspaceTools = []string{"read", "write", "edit", "bash"}

// DefaultApprovalTimeout is how long a request waits when an agent doesn't say (24 hours).
const DefaultApprovalTimeout = 24 * 60 * 60

// Timeout is the request's wait in seconds, the default filled in.
func (a Approvals) Timeout() int {
	if a.TimeoutSeconds == 0 {
		return DefaultApprovalTimeout
	}
	return a.TimeoutSeconds
}

var approvalPattern = regexp.MustCompile(`^[A-Za-z0-9_.*-]{1,200}$`)

// Limits on what a config may hold.
const (
	MaxNameChars         = 60
	MaxDescriptionChars  = 500
	MaxInstructionsChars = 20_000
	MaxKindSettingsBytes = 16 * 1024
)

// ErrInvalid wraps every validation failure; its message is for people.
var ErrInvalid = errors.New("invalid agent configuration")

// InvalidError is a validation failure with a code for the API.
type InvalidError struct {
	Code    string
	Message string
}

func (e *InvalidError) Error() string { return e.Message }
func (e *InvalidError) Unwrap() error { return ErrInvalid }

func invalid(code, format string, args ...any) error {
	return &InvalidError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Normalize trims what people type and fills defaults.
func (c *Config) Normalize() {
	c.Name = strings.TrimSpace(c.Name)
	c.Description = strings.TrimSpace(c.Description)
	c.Instructions = strings.TrimSpace(c.Instructions)
	if c.Kind == "" {
		c.Kind = "assistant"
	}
	if c.Model.Provider == "" && c.Model.ID == "" {
		c.Model = DemoModel
	}
}

// Validate checks a normalized config.
func (c *Config) Validate() error {
	if c.Name == "" || utf8.RuneCountInString(c.Name) > MaxNameChars || strings.ContainsAny(c.Name, "\r\n") {
		return invalid("invalid_name", "Give the agent a name of 1 to %d characters, on one line.", MaxNameChars)
	}
	if utf8.RuneCountInString(c.Description) > MaxDescriptionChars {
		return invalid("invalid_description", "A description is at most %d characters.", MaxDescriptionChars)
	}
	if utf8.RuneCountInString(c.Instructions) > MaxInstructionsChars {
		return invalid("invalid_instructions", "Instructions are at most %d characters.", MaxInstructionsChars)
	}
	if !knownKind(c.Kind) {
		return invalid("invalid_template", "Unknown kind %q: choose assistant, researcher or coding.", c.Kind)
	}
	if c.KindSettings != nil {
		raw, err := json.Marshal(c.KindSettings)
		if err != nil || len(raw) > MaxKindSettingsBytes {
			return invalid("invalid_kind_settings", "Kind settings must be a JSON object of at most %d bytes.", MaxKindSettingsBytes)
		}
	}
	seen := map[string]bool{}
	var tools []string
	for _, t := range c.Workspace.Tools {
		if !slices.Contains(WorkspaceTools, t) {
			return invalid("invalid_workspace_tools", "Unknown workspace tool %q: use read, write, edit or bash.", t)
		}
		if !seen[t] {
			seen[t] = true
			tools = append(tools, t)
		}
	}
	c.Workspace.Tools = tools
	if err := c.Workspace.checkFolder(); err != nil {
		return err
	}
	if len(c.Approvals.Tools) > 100 {
		return invalid("invalid_approval_tools", "At most 100 tools or patterns ask first.")
	}
	for _, t := range c.Approvals.Tools {
		if !approvalPattern.MatchString(t) {
			return invalid("invalid_approval_tools", "%q isn't a tool name or pattern (letters, digits, _ . - and *).", t)
		}
	}
	if t := c.Approvals.TimeoutSeconds; t != 0 && (t < 60 || t > 30*24*60*60) {
		return invalid("invalid_approval_timeout", "A request waits from 1 minute to 30 days.")
	}
	seenServer := map[string]bool{}
	if len(c.MCP) > 50 {
		return invalid("invalid_mcp", "An agent uses at most 50 MCP servers.")
	}
	for _, m := range c.MCP {
		if m.Server == "" || seenServer[m.Server] {
			return invalid("invalid_mcp", "Each MCP server is named once.")
		}
		seenServer[m.Server] = true
		if m.Tools != nil && len(m.Tools) == 0 {
			return invalid("invalid_mcp", "Choose at least one tool of %s, or all of them.", m.Server)
		}
		if len(m.Tools) > 500 {
			return invalid("invalid_mcp", "At most 500 tools per server.")
		}
	}
	if c.Model.Provider == "" || c.Model.ID == "" || strings.ContainsAny(c.Model.Provider, "/ ") {
		return invalid("invalid_model", "Choose one of the models offered.")
	}
	return nil
}

const configFile = "agent.yaml"

func readConfig(dir string) (Config, error) {
	raw, err := os.ReadFile(filepath.Join(dir, configFile))
	if err != nil {
		return Config{}, err
	}
	c, err := ParseConfig(raw)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", filepath.Join(dir, configFile), err)
	}
	return c, nil
}

// ParseConfig reads agent.yaml text: unknown fields are errors (a typo shouldn't be silently ignored).
func ParseConfig(raw []byte) (Config, error) {
	if len(raw) > 256<<10 {
		return Config{}, invalid("invalid_yaml", "agent.yaml is at most 256 KiB.")
	}
	var c Config
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return Config{}, &InvalidError{Code: "invalid_yaml", Message: "agent.yaml: " + yamlProblem(err)}
	}
	c.Normalize()
	return c, nil
}

// writeConfig replaces agent.yaml atomically (a reader never sees half a file).
func writeConfig(dir string, c Config) error {
	var buf bytes.Buffer
	buf.WriteString("# Pi Local agent. Edit in the app, or here while the app is closed.\n")
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(c); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".agent.yaml.*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(buf.Bytes()); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, configFile))
}

// checkFolder cleans the project folder and checks it is one: absolute, an existing directory, and not the whole disk
// or the home folder itself (the file tools would reach everything).
func (w *Workspace) checkFolder() error {
	w.Folder = strings.TrimSpace(w.Folder)
	if w.Folder == "" {
		return nil
	}
	if strings.HasPrefix(w.Folder, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			w.Folder = filepath.Join(home, w.Folder[2:])
		}
	}
	if !filepath.IsAbs(w.Folder) {
		return invalid("invalid_workspace_folder", "Choose the project folder by its full path, like /Users/you/code/project.")
	}
	w.Folder = filepath.Clean(w.Folder)
	info, err := os.Stat(w.Folder)
	if err != nil || !info.IsDir() {
		return invalid("invalid_workspace_folder", "%s isn't a folder on this computer.", w.Folder)
	}
	home, _ := os.UserHomeDir()
	if w.Folder == "/" || w.Folder == filepath.Clean(home) || w.Folder == "/Users" || w.Folder == "/System" {
		return invalid("invalid_workspace_folder", "Choose a project folder, not %s: the agent's tools would reach everything in it.", w.Folder)
	}
	return nil
}

// unknownField is the YAML decoder's "line N: field X not found in type agents.Config".
var unknownField = regexp.MustCompile(`line (\d+): field (\S+) not found in type \S+`)

// yamlProblem says what is wrong with agent.yaml in people's words (no Go type names).
func yamlProblem(err error) string {
	msg := strings.TrimPrefix(err.Error(), "yaml: ")
	msg = strings.TrimPrefix(msg, "unmarshal errors:\n")
	var lines []string
	for _, line := range strings.Split(msg, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if m := unknownField.FindStringSubmatch(line); m != nil {
			line = fmt.Sprintf("line %s: there is no setting %q", m[1], m[2])
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "; ")
}
