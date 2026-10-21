package agents

import (
	"strings"
	"testing"
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
