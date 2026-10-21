package agents

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestAgentYAMLProblemsAreSaidPlainly(t *testing.T) {
	_, err := ParseConfig([]byte("name: A\nkind: assistant\nunknownKey: 1\n"))
	if err == nil || !strings.Contains(err.Error(), `line 3: there is no setting "unknownKey"`) || strings.Contains(err.Error(), "agents.Config") {
		t.Fatalf("unknown key: %v", err)
	}
	if _, err := ParseConfig([]byte("name: [unclosed\n")); err == nil || !strings.HasPrefix(err.Error(), "agent.yaml: ") {
		t.Fatalf("broken YAML: %v", err)
	}
}

func TestABudgetIsReadableInAgentYAMLAndChecked(t *testing.T) {
	c, err := ParseConfig([]byte("name: Hardac\nbudget:\n  monthlyUsd: 20\n  onExceed: warn\n"))
	if err != nil || c.Budget == nil || c.Budget.MonthlyUSD != 20 || c.Budget.OnExceed != "warn" {
		t.Fatalf("parsed: %+v %v", c.Budget, err)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	// No mode: stop, written out so the file says what happens.
	c, _ = ParseConfig([]byte("name: Hardac\nbudget:\n  monthlyUsd: 12.345\n"))
	if err := c.Validate(); err != nil || c.Budget.OnExceed != "stop" || c.Budget.MonthlyUSD != 12.35 {
		t.Fatalf("defaults: %+v %v", c.Budget, err)
	}
	var out bytes.Buffer
	enc := yaml.NewEncoder(&out)
	enc.SetIndent(2)
	enc.Encode(c)
	if !strings.Contains(out.String(), "budget:\n  monthlyUsd: 12.35\n  onExceed: stop\n") {
		t.Fatalf("yaml:\n%s", out.String())
	}
	// No budget leaves no trace.
	c, _ = ParseConfig([]byte("name: Plain\n"))
	out.Reset()
	yaml.NewEncoder(&out).Encode(c)
	if strings.Contains(out.String(), "budget") {
		t.Fatalf("yaml without a budget:\n%s", out.String())
	}
	for _, bad := range []string{"monthlyUsd: 0", "monthlyUsd: -1", "monthlyUsd: 5\n  onExceed: boom", "monthlyUsd: 2000000", "monthlyUsd: .nan"} {
		c, err := ParseConfig([]byte("name: X\nbudget:\n  " + bad + "\n"))
		if err == nil {
			err = c.Validate()
		}
		var inv *InvalidError
		if !errors.As(err, &inv) || inv.Code != "invalid_budget" {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func TestApprovalsKeepTheirMeaningAcrossProfiles(t *testing.T) {
	// An agent.yaml with only `tools` is the custom profile and carries its list to the runtime, as before.
	c, err := ParseConfig([]byte("name: A\nkind: assistant\napprovals:\n  tools: [bash]\n"))
	if err != nil || c.Approvals.Profile != "" || c.Approvals.EffectiveProfile() != ProfileCustom {
		t.Fatalf("a legacy config: %+v %v", c.Approvals, err)
	}
	policy := c.Approvals.Policy()
	if policy["profile"] != "custom" || len(policy["tools"].([]string)) != 1 || len(policy["builtin"].([]ApprovalRule)) != len(BuiltinRules) {
		t.Fatalf("the policy: %+v", policy)
	}
	// Other profiles don't send the list (it belongs to custom).
	c.Approvals.Profile = ProfileBalanced
	if _, has := c.Approvals.Policy()["tools"]; has {
		t.Fatal("a profile's policy carried the tools list")
	}

	// New agents are balanced unless approvals were chosen.
	fresh := Config{}
	KindDefaults("assistant", &fresh)
	chosen := Config{Approvals: Approvals{Tools: []string{}}}
	KindDefaults("coding", &chosen)
	if fresh.Approvals.Profile != ProfileBalanced || chosen.Approvals.Profile != "" {
		t.Fatalf("defaults: %+v %+v", fresh.Approvals, chosen.Approvals)
	}
}

func TestApprovalRulesAreValidatedAndGetStableIDs(t *testing.T) {
	good := func() Config {
		c := Config{Name: "A", Kind: "assistant", Model: DemoModel}
		c.Approvals.Rules = []ApprovalRule{{Tool: "bash", Args: map[string]string{"command": "git status*"}, Action: "allow"}, {Tool: "mcp__gh__*", Action: "deny"}}
		return c
	}
	c := good()
	if err := c.Validate(); err != nil || c.Approvals.Rules[0].ID == "" || c.Approvals.Rules[0].ID == c.Approvals.Rules[1].ID {
		t.Fatalf("good rules: %v %+v", err, c.Approvals.Rules)
	}
	// A hand-written rule gets the same ID every time it is read.
	yaml := "name: A\nkind: assistant\napprovals:\n  rules:\n    - {tool: bash, action: ask}\n"
	a, _ := ParseConfig([]byte(yaml))
	b, _ := ParseConfig([]byte(yaml))
	if a.Approvals.Rules[0].ID == "" || a.Approvals.Rules[0].ID != b.Approvals.Rules[0].ID {
		t.Fatalf("ids: %q %q", a.Approvals.Rules[0].ID, b.Approvals.Rules[0].ID)
	}
	for name, mutate := range map[string]func(*Config){
		"action":     func(c *Config) { c.Approvals.Rules[0].Action = "maybe" },
		"tool":       func(c *Config) { c.Approvals.Rules[0].Tool = "has space" },
		"arg name":   func(c *Config) { c.Approvals.Rules[0].Args = map[string]string{"bad name": "x"} },
		"empty glob": func(c *Config) { c.Approvals.Rules[0].Args = map[string]string{"command": ""} },
		"rule ID":    func(c *Config) { c.Approvals.Rules[0].ID = "nope" },
		"profile":    func(c *Config) { c.Approvals.Profile = "reckless" },
	} {
		c := good()
		mutate(&c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestTheShellSandboxIsASettingOfTheWorkspace(t *testing.T) {
	// An agent made before the sandbox has no setting: off, network on. Nothing is added behind its back.
	old, err := ParseConfig([]byte("name: Old\nworkspace:\n  tools: [read, bash]\n"))
	if err != nil || old.Validate() != nil || old.Workspace.SandboxOn() || !old.Workspace.NetworkOn() || old.Workspace.Sandbox != "" {
		t.Fatalf("an agent without the setting: %+v %v", old.Workspace, err)
	}
	// Written by hand as YAML writes it: on and off, as words or booleans.
	for yamlText, want := range map[string]struct{ sandbox, network string }{
		"sandbox: on\n  network: off": {"on", "off"},
		"sandbox: true":               {"on", ""},
		"sandbox: \"Off\"":            {"off", ""},
		"sandbox: no\n  network: yes": {"off", "on"},
	} {
		c, err := ParseConfig([]byte("name: A\nworkspace:\n  tools: [bash]\n  " + yamlText + "\n"))
		if err != nil || c.Validate() != nil || c.Workspace.Sandbox != want.sandbox || c.Workspace.Network != want.network {
			t.Errorf("%q: %+v %v", yamlText, c.Workspace, err)
		}
	}
	for _, bad := range []string{"sandbox: maybe", "network: sometimes"} {
		c, err := ParseConfig([]byte("name: A\nworkspace:\n  " + bad + "\n"))
		if err == nil {
			err = c.Validate()
		}
		var inv *InvalidError
		if !errors.As(err, &inv) || !strings.HasPrefix(inv.Code, "invalid_workspace_") {
			t.Errorf("%q: %v", bad, err)
		}
	}
	// Written back as the words the file is documented with.
	var out bytes.Buffer
	c, _ := ParseConfig([]byte("name: A\nworkspace:\n  tools: [bash]\n  sandbox: on\n  network: off\n"))
	yaml.NewEncoder(&out).Encode(c)
	if !strings.Contains(out.String(), "sandbox:") || !strings.Contains(out.String(), "network:") {
		t.Fatalf("yaml:\n%s", out.String())
	}
	again, err := ParseConfig(out.Bytes())
	if err != nil || !again.Workspace.SandboxOn() || again.Workspace.NetworkOn() {
		t.Fatalf("round trip: %+v %v", again.Workspace, err)
	}
}

func TestNewAgentsWithAShellGetTheSandboxWhereThereIsOne(t *testing.T) {
	was := SandboxSupported
	defer func() { SandboxSupported = was }()

	SandboxSupported = true
	withBash := Config{Workspace: Workspace{Tools: []string{"read", "bash"}}}
	KindDefaults("assistant", &withBash)
	coding := Config{}
	KindDefaults("coding", &coding)
	noShell := Config{Workspace: Workspace{Tools: []string{"read"}}}
	KindDefaults("assistant", &noShell)
	chosen := Config{Workspace: Workspace{Tools: []string{"bash"}, Sandbox: "off"}}
	KindDefaults("coding", &chosen)
	if !withBash.Workspace.SandboxOn() || !coding.Workspace.SandboxOn() || noShell.Workspace.Sandbox != "" || chosen.Workspace.Sandbox != "off" {
		t.Fatalf("defaults: %+v %+v %+v %+v", withBash.Workspace, coding.Workspace, noShell.Workspace, chosen.Workspace)
	}
	if coding.Workspace.Network != "" || !coding.Workspace.NetworkOn() {
		t.Fatalf("the network is on by default: %+v", coding.Workspace)
	}

	// Where there is no sandbox yet, the shell is left as it was: never a default that makes it refuse.
	SandboxSupported = false
	elsewhere := Config{}
	KindDefaults("coding", &elsewhere)
	if elsewhere.Workspace.Sandbox != "" {
		t.Fatalf("without a sandbox on this OS: %+v", elsewhere.Workspace)
	}
}

func TestTheApprovalPolicyKnowsWhenTheShellIsSandboxed(t *testing.T) {
	c := Config{Workspace: Workspace{Tools: []string{"bash"}, Sandbox: "on"}, Approvals: Approvals{Profile: ProfileBalanced}}
	if c.ApprovalPolicy()["sandboxed"] != true {
		t.Fatalf("sandboxed: %+v", c.ApprovalPolicy())
	}
	c.Workspace.Sandbox = "off"
	if _, has := c.ApprovalPolicy()["sandboxed"]; has {
		t.Fatal("an unsandboxed shell was reported as sandboxed")
	}
	// A sandbox without a shell protects nothing: the flag is for bash.
	c.Workspace = Workspace{Tools: []string{"read"}, Sandbox: "on"}
	if _, has := c.ApprovalPolicy()["sandboxed"]; has {
		t.Fatal("sandboxed without bash")
	}
	if _, has := c.Approvals.Policy()["sandboxed"]; has {
		t.Fatal("the approvals alone know nothing of the sandbox")
	}
}

func TestSharedSkillsAreNamesInAgentYAML(t *testing.T) {
	c, err := ParseConfig([]byte("name: A\nskills:\n  - release-notes\n  - pdf-tools\n  - release-notes\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if len(c.Skills) != 2 || c.Skills[0] != "release-notes" || c.Skills[1] != "pdf-tools" {
		t.Fatalf("each once, in order: %v", c.Skills)
	}
	for _, bad := range []string{"Release Notes", "../etc", "a_b", "", strings.Repeat("a", 65)} {
		c := Config{Name: "A", Model: DemoModel, Skills: []string{bad}}
		c.Normalize()
		var inv *InvalidError
		if err := c.Validate(); !errors.As(err, &inv) || inv.Code != "invalid_skills" {
			t.Errorf("%q: %v", bad, err)
		}
	}
	many := Config{Name: "A", Model: DemoModel}
	for i := 0; i <= MaxSkills; i++ {
		many.Skills = append(many.Skills, "s"+strings.Repeat("a", i%5)+string(rune('a'+i%26))+string(rune('a'+i/26)))
	}
	many.Normalize()
	if err := many.Validate(); err == nil {
		t.Error("more than the limit was accepted")
	}
	// Without skills nothing is written.
	var out bytes.Buffer
	yaml.NewEncoder(&out).Encode(Config{Name: "A"})
	if strings.Contains(out.String(), "skills") {
		t.Fatalf("yaml:\n%s", out.String())
	}
}
