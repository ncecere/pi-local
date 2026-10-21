package templates

import (
	"reflect"
	"testing"

	"github.com/ncecere/pi-local/internal/agents"
)

func TestTemplateMailToolRestrictions(t *testing.T) {
	c := agents.Config{Name: "Reader", Kind: "assistant", MCP: []agents.MCPChoice{
		{Server: "mail", Tools: []string{"list-mail-messages", "get-mail-message"}},
		{Server: "other"},
	}}
	tp := FromAgent("reader", c)
	parsed, err := Parse(Marshal(tp))
	if err != nil {
		t.Fatal(err)
	}
	var restored agents.Config
	parsed.Apply(&restored)
	if !reflect.DeepEqual(restored.MCP, c.MCP) {
		t.Fatalf("tool selections widened: %+v", restored.MCP)
	}
	restored.MCP[0].Tools[0] = "changed"
	if c.MCP[0].Tools[0] != "list-mail-messages" || parsed.MCPTools["mail"][0] != "list-mail-messages" {
		t.Fatal("tool selections share mutable storage")
	}
	for _, raw := range []string{
		"id: bad\nname: Bad\nmcp: [mail]\nmcpTools: {mail: []}\n",
		"id: bad\nname: Bad\nmcp: [mail]\nmcpTools: {other: [send-mail]}\n",
	} {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Fatal("ignored/empty tool restriction accepted")
		}
	}
}

func TestInboxBuiltinSafeDefaults(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tp, err := store.Get("inbox-helper")
	if err != nil {
		t.Fatal(err)
	}
	if !tp.Builtin || tp.Schedule != nil || len(tp.MCP) != 0 || len(tp.MCPTools) != 0 {
		t.Fatalf("unresolved builtin: %+v", tp)
	}
	var c agents.Config
	tp.Apply(&c)
	if c.Approvals.Profile != "careful" || c.Web.Search || c.Web.Fetch || len(c.Workspace.Tools) != 0 || c.Schedules.AgentMade || c.Builder || len(c.MCP) != 0 {
		t.Fatalf("unsafe defaults: %+v", c)
	}
}
