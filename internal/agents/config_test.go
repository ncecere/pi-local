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
