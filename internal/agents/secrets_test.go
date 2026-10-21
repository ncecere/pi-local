package agents

import (
	"slices"
	"strings"
	"testing"
)

func TestRuntimeSecretsAndLogLines(t *testing.T) {
	env := map[string]string{
		"MODEL_API_KEY": "pdpm.agent.ABCDEFGH1234", "PLATFORM_KEY": "pl.ag_x.0123456789abcdef", "AGENT_NAME": "Hardac", "TOOL_APPROVALS": "{}",
		"MCP_SERVERS": `[{"slug":"gh","headers":{"Authorization":"Bearer tok_live_zzzz1111"}},{"slug":"fs","env":{"PORT":"8080","ROOT":"/Users/ann/work","DB":"postgres://app:pa55-w0rd@db.local/x","NOTE":"hello there"}}]`,
	}
	got := RuntimeSecrets(env)
	for _, want := range []string{"pdpm.agent.ABCDEFGH1234", "pl.ag_x.0123456789abcdef", "tok_live_zzzz1111", "Bearer tok_live_zzzz1111", "pa55-w0rd", "hello there"} {
		if !slices.Contains(got, want) {
			t.Errorf("missing %q in the secrets", want)
		}
	}
	for _, not := range []string{"Hardac", "{}", "8080", "/Users/ann/work"} {
		if slices.Contains(got, not) {
			t.Errorf("%q is no secret", not)
		}
	}
	line := LogRedactor(env)("[agent x] ok Hardac sent pl.ag_x.0123456789abcdef to pdpm.agent.ABCDEFGH1234 and ghp_abcdefghijklmnopqrstuvwxyz0123456789; Authorization: Bearer tok_live_zzzz1111")
	for _, gone := range []string{"0123456789abcdef", "tok_live", "ABCDEFGH1234", "ghp_abc"} {
		if strings.Contains(line, gone) {
			t.Errorf("the log line still has %q: %s", gone, line)
		}
	}
	if !strings.Contains(line, "ok Hardac sent") {
		t.Errorf("the rest of the line should stay: %s", line)
	}
}

func TestScrubSecretsIsOnUnlessTurnedOff(t *testing.T) {
	c, err := ParseConfig([]byte("name: A\nmodel: {provider: demo, id: demo-1}\n"))
	if err != nil || !c.Security.Scrub() || c.Security.ScrubSecrets != nil {
		t.Fatalf("default: %+v %v", c.Security, err)
	}
	c, _ = ParseConfig([]byte("name: A\nmodel: {provider: demo, id: demo-1}\nsecurity: {scrubSecrets: true}\n"))
	if !c.Security.Scrub() || c.Security.ScrubSecrets != nil {
		t.Fatalf("explicit true is the default and isn't kept: %+v", c.Security)
	}
	c, _ = ParseConfig([]byte("name: A\nmodel: {provider: demo, id: demo-1}\nsecurity: {scrubSecrets: false}\n"))
	if c.Security.Scrub() {
		t.Fatal("scrubSecrets: false should turn it off")
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseConfig([]byte("name: A\nsecurity: {scrub: false}\n")); err == nil {
		t.Fatal("a misspelled setting should be an error")
	}
}
