package app

import (
	"encoding/json"
	"strings"
	"testing"
)

// The builder's preparation path must honor the same capability gate as the dialog, including when updating an
// owned agent from a template. This exercises the integration of the builder and connections workstreams.
func TestBuilderCannotApplyAnUnavailableConnectionTemplate(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	builder := h.agentOn("Builder", "demo/demo-1", map[string]any{"templateId": "agent-builder"})
	child := h.createAgent("Owned")
	if _, err := h.app.DB.Exec(`INSERT INTO agent_creators (agent_id, creator_id, request_key) VALUES (?, ?, ?)`, child, builder, "original"); err != nil {
		t.Fatal(err)
	}
	before, err := h.app.Agents.Get(child)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"create_agent", "update_agent"} {
		t.Run(tool, func(t *testing.T) {
			configuration := map[string]any{"name": "Unavailable", "templateId": "meeting-helper"}
			if tool == "update_agent" {
				configuration["agent"] = child
			}
			raw, err := json.Marshal(map[string]any{"key": tool, "approvalId": "ap_" + tool, "tool": tool, "configuration": configuration})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw); err == nil || !strings.Contains(strings.ToLower(err.Error()), "connect") {
				t.Fatalf("unavailable template was not refused: %v", err)
			}
		})
	}
	after, err := h.app.Agents.Get(child)
	if err != nil || after.Revision != before.Revision || after.Config.Name != before.Config.Name {
		t.Fatalf("template refusal changed the agent: %+v, %v", after, err)
	}
	var proposals int
	if err := h.app.DB.QueryRow(`SELECT COUNT(*) FROM builder_requests WHERE caller = ?`, builder).Scan(&proposals); err != nil || proposals != 0 {
		t.Fatalf("unavailable template produced proposals: %d, %v", proposals, err)
	}
}
