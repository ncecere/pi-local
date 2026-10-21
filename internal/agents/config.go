package agents

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"slices"
	"sort"
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
	if kind == "coding" && c.Workspace.Tools == nil {
		// pi's own tools.
		c.Workspace.Tools = []string{"read", "write", "edit", "bash"}
	}
	// New agents with a shell run it in the sandbox where this computer has one. Agents made before the sandbox have no
	// setting and keep running their shell as they did (off): never changed behind someone's back.
	if c.Workspace.Sandbox == "" && slices.Contains(c.Workspace.Tools, "bash") && SandboxSupported {
		c.Workspace.Sandbox = SwitchOn
	}
	// New agents get the balanced profile (commands, and MCP tools that change things, ask first) unless the request or
	// its template chose how approvals work. Agents made before profiles have no profile: they keep their `tools` as
	// the custom profile (Approvals.EffectiveProfile).
	if c.Approvals.Profile == "" && c.Approvals.Tools == nil && len(c.Approvals.Rules) == 0 {
		c.Approvals.Profile = ProfileBalanced
	}
}

// SandboxSupported says whether the shell sandbox exists on this OS (runtime/src/lib/sandbox: macOS first). New agents
// get the sandbox on only where it does.
var SandboxSupported = goruntime.GOOS == "darwin"

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
	// Builder explicitly grants create_agent and ownership-scoped update_agent. Both always ask a person.
	Builder      bool           `yaml:"builder,omitempty" json:"builder"`
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
	// Memory: what it knows about the person (the basics, and the categories it shares) and its own notes.
	Memory MemorySettings `yaml:"memory,omitempty"`
	// Budget: a monthly limit on what the agent may spend on its model (nil: none).
	Budget *Budget `yaml:"budget,omitempty"`
	// Security: whether what its tools return is cleaned of secrets before the model sees it and before it is saved.
	Security Security `yaml:"security,omitempty"`
}

// Security is an agent's secret handling. `scrubSecrets` (on unless false) replaces what looks like a credential in
// the output of its tools, and the secret values the app gave it (its model key, its MCP servers' keys), with
// "[redacted secret]" before the model sees them and before they are saved. Turn it off for an agent that has to
// handle tokens. Logs are cleaned either way. The default isn't written to agent.yaml.
type Security struct {
	ScrubSecrets *bool `yaml:"scrubSecrets,omitempty" json:"scrubSecrets"`
}

// Scrub reports whether tool output is scrubbed of secrets (the default).
func (s Security) Scrub() bool { return s.ScrubSecrets == nil || *s.ScrubSecrets }

// Budget is an agent's monthly spending limit, counted from the usage and prices in the app (this calendar month, priced
// models only). OnExceed says what happens at the limit: "stop" refuses the agent's new work until the next month or a
// higher limit, "warn" only says so.
type Budget struct {
	MonthlyUSD float64 `yaml:"monthlyUsd" json:"monthlyUsd"`
	OnExceed   string  `yaml:"onExceed" json:"onExceed"`
}

// Budget modes.
const (
	BudgetStop = "stop"
	BudgetWarn = "warn"
)

// MaxBudgetUSD is the largest monthly budget that can be set.
const MaxBudgetUSD = 1_000_000

// CheckBudget fills the default mode (stop) and checks the amount: more than zero, at most a million dollars, whole
// cents.
func (b *Budget) CheckBudget() error {
	if b.OnExceed == "" {
		b.OnExceed = BudgetStop
	}
	if b.OnExceed != BudgetStop && b.OnExceed != BudgetWarn {
		return invalid("invalid_budget", "A budget either stops the agent or only warns: use stop or warn.")
	}
	if !(b.MonthlyUSD >= 0.01 && b.MonthlyUSD <= MaxBudgetUSD) {
		return invalid("invalid_budget", "A monthly budget is from $0.01 to $1,000,000.")
	}
	b.MonthlyUSD = math.Round(b.MonthlyUSD*100) / 100
	return nil
}

// WebTools are an agent's web tools (read-only: they change nothing).
type WebTools struct {
	Search bool `yaml:"search,omitempty" json:"search"`
	Fetch  bool `yaml:"fetch,omitempty" json:"fetch"`
}

// MemorySettings: memory is on unless Off; the agent sees the person's basics and preferences, plus Share's categories.
type MemorySettings struct {
	Off   bool     `yaml:"off,omitempty" json:"off"`
	Share []string `yaml:"share,omitempty" json:"share"`
}

// ShareableMemory are the categories of the person's memory an agent sees only when shared with it.
var ShareableMemory = []string{"people", "projects", "work", "health", "family", "finances", "home", "interests"}

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
	// Sandbox: "on" runs the agent's `bash` in an OS sandbox (reads anywhere but credentials and other agents' data;
	// writes only the workspace and temporary folders); "off" or empty (an agent made before the sandbox) runs it
	// with everything the person can reach. Only `bash` is affected: the file tools stay inside the workspace always.
	Sandbox string `yaml:"sandbox,omitempty" json:"sandbox,omitempty"`
	// Network: "off" blocks the sandboxed shell's network; "on" or empty allows it. No effect without the sandbox.
	Network string `yaml:"network,omitempty" json:"network,omitempty"`
}

// Switch values for Workspace.Sandbox and Workspace.Network.
const (
	SwitchOn  = "on"
	SwitchOff = "off"
)

// SandboxOn: the shell runs sandboxed.
func (w Workspace) SandboxOn() bool { return w.Sandbox == SwitchOn }

// NetworkOn: the sandboxed shell may use the network (the default).
func (w Workspace) NetworkOn() bool { return w.Network != SwitchOff }

// normalizeSwitch reads what people write for an on/off setting (YAML's `on` and `off` may come as booleans).
func normalizeSwitch(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "on", "true", "yes":
		return SwitchOn
	case "off", "false", "no":
		return SwitchOff
	case "":
		return ""
	}
	return "?" + v
}

// Permission profiles: how much an agent asks before it acts.
const (
	ProfileCareful  = "careful"  // everything that can change something asks
	ProfileBalanced = "balanced" // commands, and MCP tools that change things, ask
	ProfileTrusting = "trusting" // nothing asks (but the built-in rules)
	ProfileCustom   = "custom"   // the `tools` list asks, as before profiles
)

// Profiles are the profiles a config may name.
var Profiles = []string{ProfileCareful, ProfileBalanced, ProfileTrusting, ProfileCustom}

// Rule actions.
const (
	ActionAllow = "allow"
	ActionAsk   = "ask"
	ActionDeny  = "deny"
)

// ApprovalRule is one rule: a tool name or pattern (`*` any characters) and, optionally, globs its arguments must all
// match; the first rule that matches a call decides (runtime approval-rules.ts).
type ApprovalRule struct {
	ID     string            `yaml:"id,omitempty" json:"id"`
	Tool   string            `yaml:"tool" json:"tool"`
	Args   map[string]string `yaml:"args,omitempty" json:"args,omitempty"`
	Action string            `yaml:"action" json:"action"`
}

// BuiltinRules apply to every profile, ask whatever the rules above them say, and can't be removed.
var BuiltinRules = []ApprovalRule{
	{ID: "builtin-rm-rf", Tool: "bash", Args: map[string]string{"command": "rm -rf*"}, Action: ActionAsk},
	{ID: "builtin-sudo", Tool: "bash", Args: map[string]string{"command": "sudo *"}, Action: ActionAsk},
	{ID: "builtin-git-push-force", Tool: "bash", Args: map[string]string{"command": "git push --force*"}, Action: ActionAsk},
	{ID: "builtin-pipe-sh", Tool: "bash", Args: map[string]string{"command": "* | sh"}, Action: ActionAsk},
	{ID: "builtin-curl-sh", Tool: "bash", Args: map[string]string{"command": "curl * | *sh"}, Action: ActionAsk},
}

// Approvals says what asks first: a profile, rules (first match wins, before the profile), and for the custom profile
// the tools (names, or patterns with *) that ask; and how long a request waits.
type Approvals struct {
	// Profile: careful, balanced, trusting or custom. Empty (an agent made before profiles) is custom.
	Profile        string         `yaml:"profile,omitempty" json:"profile"`
	Tools          []string       `yaml:"tools,omitempty" json:"tools"`
	Rules          []ApprovalRule `yaml:"rules,omitempty" json:"rules"`
	TimeoutSeconds int            `yaml:"timeoutSeconds,omitempty" json:"timeoutSeconds"`
}

// EffectiveProfile is the profile in force: an agent with none keeps its `tools` as custom.
func (a Approvals) EffectiveProfile() string {
	if a.Profile == "" {
		return ProfileCustom
	}
	return a.Profile
}

// Policy is what the runtime gets as TOOL_APPROVALS (and POST /approvals/policy when the rules change): the profile,
// the `tools` list (custom only), the rules and the built-in rules, and how long a request waits.
func (a Approvals) Policy() map[string]any {
	return a.policy(false)
}

// ApprovalPolicy is the policy for this agent: its approvals, and whether its shell is sandboxed (the balanced profile
// stops asking for plain commands then; the built-in rules still ask).
func (c Config) ApprovalPolicy() map[string]any {
	return c.Approvals.policy(c.Workspace.SandboxOn() && slices.Contains(c.Workspace.Tools, "bash"))
}

func (a Approvals) policy(sandboxed bool) map[string]any {
	p := map[string]any{"profile": a.EffectiveProfile(), "rules": nonNilRules(a.Rules), "builtin": BuiltinRules, "timeoutSeconds": a.Timeout()}
	if a.EffectiveProfile() == ProfileCustom {
		p["tools"] = a.Tools
	}
	if sandboxed {
		p["sandboxed"] = true
	}
	return p
}

func nonNilRules(r []ApprovalRule) []ApprovalRule {
	if r == nil {
		return []ApprovalRule{}
	}
	return r
}

// Copy is a deep copy.
func (r ApprovalRule) Copy() ApprovalRule {
	if r.Args != nil {
		args := make(map[string]string, len(r.Args))
		for k, v := range r.Args {
			args[k] = v
		}
		r.Args = args
	}
	return r
}

// SameAs reports whether two rules say the same thing (everything but the ID).
func (r ApprovalRule) SameAs(o ApprovalRule) bool {
	if r.Tool != o.Tool || r.Action != o.Action || len(r.Args) != len(o.Args) {
		return false
	}
	for k, v := range r.Args {
		if got, ok := o.Args[k]; !ok || got != v {
			return false
		}
	}
	return true
}

// NewRuleID makes the ID of a rule made now.
func NewRuleID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return "r_" + hex.EncodeToString(b)
}

// ruleID is the ID a rule without one gets (hand-edited agent.yaml): the same on every load, so it can be removed by it.
func ruleID(i int, r ApprovalRule) string {
	keys := make([]string, 0, len(r.Args))
	for k := range r.Args {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	h := sha256.New()
	fmt.Fprintf(h, "%d\x00%s\x00%s", i, r.Tool, r.Action)
	for _, k := range keys {
		fmt.Fprintf(h, "\x00%s=%s", k, r.Args[k])
	}
	return "r_" + hex.EncodeToString(h.Sum(nil))[:12]
}

// Limits on rules.
const (
	MaxApprovalRules   = 200
	MaxRuleArgs        = 10
	MaxRuleArgGlobSize = 500
)

var (
	ruleIDPattern  = regexp.MustCompile(`^r_[a-z0-9]{6,32}$`)
	ruleArgPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
)

// checkRules validates the rules and gives each an ID.
func (a *Approvals) checkRules() error {
	if len(a.Rules) > MaxApprovalRules {
		return invalid("invalid_approval_rules", "At most %d approval rules.", MaxApprovalRules)
	}
	seen := map[string]bool{}
	for i := range a.Rules {
		r := &a.Rules[i]
		r.Tool = strings.TrimSpace(r.Tool)
		if !approvalPattern.MatchString(r.Tool) {
			return invalid("invalid_approval_rules", "%q isn't a tool name or pattern (letters, digits, _ . - and *).", r.Tool)
		}
		if r.Action != ActionAllow && r.Action != ActionAsk && r.Action != ActionDeny {
			return invalid("invalid_approval_rules", "A rule allows, asks or denies; %q is none of those.", r.Action)
		}
		if len(r.Args) > MaxRuleArgs {
			return invalid("invalid_approval_rules", "A rule matches at most %d arguments.", MaxRuleArgs)
		}
		for k, v := range r.Args {
			if !ruleArgPattern.MatchString(k) {
				return invalid("invalid_approval_rules", "%q isn't an argument name (letters, digits, _ . and -).", k)
			}
			if v == "" || utf8.RuneCountInString(v) > MaxRuleArgGlobSize {
				return invalid("invalid_approval_rules", "The pattern for %s is 1 to %d characters.", k, MaxRuleArgGlobSize)
			}
		}
		if len(r.Args) == 0 {
			r.Args = nil
		}
		if r.ID == "" {
			r.ID = ruleID(i, *r)
		}
		if !ruleIDPattern.MatchString(r.ID) {
			return invalid("invalid_approval_rules", "%q isn't a rule ID.", r.ID)
		}
		if seen[r.ID] {
			r.ID = NewRuleID()
		}
		seen[r.ID] = true
	}
	return nil
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
	c.Workspace.Sandbox = normalizeSwitch(c.Workspace.Sandbox)
	c.Workspace.Network = normalizeSwitch(c.Workspace.Network)
	if c.Kind == "" {
		c.Kind = "assistant"
	}
	// Scrubbing is the default: `scrubSecrets: true` written by hand is the same as nothing.
	if c.Security.Scrub() {
		c.Security.ScrubSecrets = nil
	}
	// Rules written by hand have no ID yet; they get the same one on every load.
	for i := range c.Approvals.Rules {
		if r := &c.Approvals.Rules[i]; r.ID == "" {
			r.ID = ruleID(i, *r)
		}
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
	if s := c.Workspace.Sandbox; s != "" && s != SwitchOn && s != SwitchOff {
		return invalid("invalid_workspace_sandbox", "The shell sandbox is on or off.")
	}
	if n := c.Workspace.Network; n != "" && n != SwitchOn && n != SwitchOff {
		return invalid("invalid_workspace_network", "The shell's network is on or off.")
	}
	var share []string
	for _, cat := range c.Memory.Share {
		if !slices.Contains(ShareableMemory, cat) {
			return invalid("invalid_memory", "Unknown memory category %q: use %s.", cat, strings.Join(ShareableMemory, ", "))
		}
		if !slices.Contains(share, cat) {
			share = append(share, cat)
		}
	}
	c.Memory.Share = share
	if err := c.Workspace.checkFolder(); err != nil {
		return err
	}
	if c.Budget != nil {
		if err := c.Budget.CheckBudget(); err != nil {
			return err
		}
	}
	if len(c.Approvals.Tools) > 100 {
		return invalid("invalid_approval_tools", "At most 100 tools or patterns ask first.")
	}
	for _, t := range c.Approvals.Tools {
		if !approvalPattern.MatchString(t) {
			return invalid("invalid_approval_tools", "%q isn't a tool name or pattern (letters, digits, _ . - and *).", t)
		}
	}
	if c.Approvals.Profile != "" && !slices.Contains(Profiles, c.Approvals.Profile) {
		return invalid("invalid_approval_profile", "Unknown approval profile %q: use careful, balanced, trusting or custom.", c.Approvals.Profile)
	}
	if err := c.Approvals.checkRules(); err != nil {
		return err
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
