package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/mcp"
	"github.com/ncecere/pi-local/internal/templates"
	"gopkg.in/yaml.v3"
)

// Seed only catalog metadata in the temporary database. Never launch a mail/Apple
// server, perform sign-in, read real records or touch the keychain.
func seedMailMetadata(t *testing.T, h *harness, slug string) {
	t.Helper()
	tools, _ := json.Marshal([]mcp.Tool{
		{Name: "get-mail-message", ModelVisible: true, Annotations: json.RawMessage(`{"readOnlyHint":true,"destructiveHint":false}`)},
		{Name: "send-mail", ModelVisible: true, Annotations: json.RawMessage(`{"readOnlyHint":false}`)},
		{Name: "list-mail-messages", ModelVisible: true, Annotations: json.RawMessage(`{"readOnlyHint":true}`)},
		{Name: "graph-batch", ModelVisible: true},
	})
	_, err := h.app.DB.Exec(`INSERT INTO mcp_servers (slug,name,transport,url,enabled,tools,tested_at,created_at,updated_at) VALUES (?,?,'http','http://127.0.0.1:1/mcp',1,?,1,1,1)`, slug, slug, string(tools))
	if err != nil {
		t.Fatal(err)
	}
}

func inboxTemplate(t *testing.T, h *harness, path string) *templates.Template {
	t.Helper()
	list := decodeInto[struct{ Templates []templates.Template }](t, h.mustDo("GET", path, nil, 200)).Templates
	for i := range list {
		if list[i].ID == "inbox-helper" {
			return &list[i]
		}
	}
	return nil
}

func assertInboxConfig(t *testing.T, c agents.Config) {
	t.Helper()
	want := []agents.MCPChoice{{Server: "a_mail", Tools: []string{"list-mail-messages", "get-mail-message"}}}
	if !reflect.DeepEqual(c.MCP, want) || c.Approvals.Profile != "careful" || c.Web.Search || c.Web.Fetch || len(c.Workspace.Tools) != 0 || c.Schedules.AgentMade || c.Builder || len(c.CanCall) != 0 {
		t.Fatalf("unsafe inbox configuration: %+v", c)
	}
	for _, text := range []string{"untrusted", "IN CHAT", "stop", "background", "Never send mail"} {
		if !strings.Contains(c.Instructions, text) {
			t.Fatalf("missing instruction %q", text)
		}
	}
}

func TestInboxTemplateGalleryDialogAndBuilder(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	for _, path := range []string{"/api/templates", "/api/agents/catalog"} {
		if inboxTemplate(t, h, path) != nil {
			t.Fatal("unconnected inbox offered")
		}
	}
	h.mustDo("POST", "/api/agents", map[string]any{"name": "Inbox", "templateId": "inbox-helper"}, 409)
	seedMailMetadata(t, h, "z_mail")
	seedMailMetadata(t, h, "a_mail")
	for _, path := range []string{"/api/templates", "/api/agents/catalog"} {
		tp := inboxTemplate(t, h, path)
		if tp == nil || tp.Schedule != nil {
			t.Fatal("missing inbox or unexpected first schedule")
		}
		var c agents.Config
		tp.Apply(&c)
		assertInboxConfig(t, c)
	}
	stored, err := h.app.Templates.Get("inbox-helper")
	if err != nil || len(stored.MCP) != 0 || len(stored.MCPTools) != 0 {
		t.Fatalf("shared template mutated: %+v %v", stored, err)
	}
	id := decodeInto[struct{ ID string }](t, h.mustDo("POST", "/api/agents", map[string]any{"name": "Inbox", "templateId": "inbox-helper", "instructions": ""}, 201)).ID
	ag, _ := h.app.Agents.Get(id)
	assertInboxConfig(t, ag.Config)
	if list, err := h.app.Schedules.List(t.Context(), id); err != nil || len(list) != 0 {
		t.Fatalf("schedule: %v %v", list, err)
	}
	// A non-template agent keeps its independent selection, including write tools.
	ordinary := h.agentOn("Custom", "demo/demo-1", map[string]any{"mcp": []agents.MCPChoice{{Server: "z_mail", Tools: []string{"send-mail"}}}})
	h.mustDo("PATCH", "/api/agents/"+ordinary, map[string]any{"description": "My selection"}, 200)
	custom, _ := h.app.Agents.Get(ordinary)
	if !reflect.DeepEqual(custom.Config.MCP, []agents.MCPChoice{{Server: "z_mail", Tools: []string{"send-mail"}}}) {
		t.Fatal("ordinary selection changed")
	}
	// Ordinary edits must retain the person's existing per-tool selection.
	h.mustDo("PATCH", "/api/agents/"+id, map[string]any{"name": "Renamed"}, 200)
	ag, _ = h.app.Agents.Get(id)
	assertInboxConfig(t, ag.Config)
	// Saving/exporting this helper must not widen its access to the entire server.
	roundtrip, err := templates.Parse(templates.Marshal(templates.FromAgent("saved-inbox", ag.Config)))
	if err != nil {
		t.Fatal(err)
	}
	var restored agents.Config
	roundtrip.Apply(&restored)
	assertInboxConfig(t, restored)

	builder := h.agentOn("Builder", "demo/demo-1", map[string]any{"templateId": "agent-builder"})
	if _, err := h.app.DB.Exec(`INSERT INTO agent_creators (agent_id,creator_id,request_key) VALUES (?,?,?)`, id, builder, "original"); err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"create_agent", "update_agent"} {
		configuration := map[string]any{"name": "Built inbox", "templateId": "inbox-helper"}
		if tool == "update_agent" {
			configuration["agent"] = id
		}
		raw, _ := json.Marshal(map[string]any{"key": tool, "approvalId": "ap_" + tool, "tool": tool, "configuration": configuration})
		proposal, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw)
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(proposal)
		var p struct{ YAML string }
		json.Unmarshal(encoded, &p)
		var cfg agents.Config
		if err := yaml.Unmarshal([]byte(p.YAML), &cfg); err != nil {
			t.Fatal(err)
		}
		assertInboxConfig(t, cfg)
		// The exact synthetic approval is applied through the durable builder path.
		if _, err := h.app.DB.Exec(`INSERT INTO approvals (agent_id,id,tool,arguments,status,requested_at,expires_at) VALUES (?,?,?,?,'approved',0,0)`, builder, "ap_"+tool, tool, string(encoded)); err != nil {
			t.Fatal(err)
		}
		apply, _ := json.Marshal(map[string]string{"key": tool})
		// Losing the selected connection must fail even after approval; selecting a
		// different qualifying mailbox must not silently replace the reviewed one.
		if _, err := h.app.DB.Exec(`UPDATE mcp_servers SET enabled=0 WHERE slug='a_mail'`); err != nil {
			t.Fatal(err)
		}
		if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", apply); err == nil {
			t.Fatal("stale inbox approval bypassed the gate")
		}
		if _, err := h.app.DB.Exec(`UPDATE mcp_servers SET enabled=0 WHERE slug='z_mail'`); err != nil {
			t.Fatal(err)
		}
		if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", apply); err == nil {
			t.Fatal("disconnected approval bypassed the gate")
		}
		if _, err := h.app.DB.Exec(`UPDATE mcp_servers SET enabled=1`); err != nil {
			t.Fatal(err)
		}
		if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", apply); err != nil {
			t.Fatal(err)
		}
		var applied struct{ AgentID string }
		json.Unmarshal(encoded, &applied)
		child, err := h.app.Agents.Get(applied.AgentID)
		if err != nil {
			t.Fatal(err)
		}
		assertInboxConfig(t, child.Config)
	}
}

func TestInboxTemplateFailsClosed(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	seedMailMetadata(t, h, "a_mail")
	builder := h.agentOn("Builder", "demo/demo-1", map[string]any{"templateId": "agent-builder"})
	child := h.createAgent("Owned")
	if _, err := h.app.DB.Exec(`INSERT INTO agent_creators (agent_id,creator_id,request_key) VALUES (?,?,?)`, child, builder, "original"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, patch string }{
		{"untested", "tested_at = NULL"},
		{"disabled", "enabled = 0"},
		{"disconnected", "last_error = 'offline'"},
		{"signed out", "oauth = 1"},
		{"impostor", `name = 'Microsoft 365 mail', tools = '[]'`},
		{"write only", `tools = '[{"name":"send-mail","modelVisible":true}]'`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Restore the same inert fixture after each case.
			var enabled, oauth int
			var tested any
			var tools, name string
			if err := h.app.DB.QueryRow(`SELECT enabled,oauth,tested_at,tools,name FROM mcp_servers WHERE slug='a_mail'`).Scan(&enabled, &oauth, &tested, &tools, &name); err != nil {
				t.Fatal(err)
			}
			if _, err := h.app.DB.Exec(`UPDATE mcp_servers SET ` + tc.patch + ` WHERE slug='a_mail'`); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := h.app.DB.Exec(`UPDATE mcp_servers SET enabled=?,oauth=?,tested_at=?,tools=?,name=?,last_error=NULL WHERE slug='a_mail'`, enabled, oauth, tested, tools, name); err != nil {
					t.Error(err)
				}
			}()
			for _, path := range []string{"/api/templates", "/api/agents/catalog"} {
				if inboxTemplate(t, h, path) != nil {
					t.Fatal("unavailable helper offered")
				}
			}
			body := h.mustDo("POST", "/api/agents", map[string]any{"name": "No inbox", "templateId": "inbox-helper"}, 409)
			if !strings.Contains(string(body), "custom mail connection") {
				t.Fatal(string(body))
			}
			for _, tool := range []string{"create_agent", "update_agent"} {
				configuration := map[string]any{"name": "No inbox", "templateId": "inbox-helper"}
				if tool == "update_agent" {
					configuration["agent"] = child
				}
				raw, _ := json.Marshal(map[string]any{"key": tc.name + tool, "approvalId": "ap_inbox", "tool": tool, "configuration": configuration})
				if _, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw); err == nil {
					t.Fatal("builder bypassed the mail gate")
				}
			}
		})
	}
}
