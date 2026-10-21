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
