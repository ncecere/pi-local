package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuilderCommittedUpdateMaterializationFailureAndReplay(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	builder := h.agentOn("Builder", "demo/demo-1", map[string]any{"templateId": "agent-builder"})
	child := h.createAgent("Child")
	if _, err := h.app.DB.Exec(`INSERT INTO agent_creators (agent_id,creator_id,request_key) VALUES (?,?,'fixture')`, child, builder); err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(`{"key":"update","approvalId":"ap_update","tool":"update_agent","configuration":{"agent":"` + child + `","name":"Saved edit","schedule":{"cron":"@daily","message":"Hello","paused":true}}}`)
	result, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw)
	if err != nil {
		t.Fatal(err)
	}
	proposal, _ := json.Marshal(result)
	if _, err := h.app.DB.Exec(`INSERT INTO approvals (agent_id,id,tool,arguments,status,requested_at,expires_at) VALUES (?,?,'update_agent',?,'approved',0,0)`, builder, "ap_update", string(proposal)); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(h.app.cfg.DataDir, "agents", child)
	backup := dir + ".backup"
	if err := os.Rename(dir, backup); err != nil {
		t.Fatal(err)
	}
	apply := json.RawMessage(`{"key":"update"}`)
	if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", apply); err == nil || strings.Contains(err.Error(), "Nothing was saved") || !strings.Contains(err.Error(), "change was saved") {
		t.Fatalf("committed change was not reported honestly: %v", err)
	}
	var state string
	if err := h.app.DB.QueryRow(`SELECT state FROM builder_requests WHERE caller = ? AND request_key = 'update'`, builder).Scan(&state); err != nil || state != "done" {
		t.Fatalf("committed request: %s %v", state, err)
	}
	if err := os.Rename(backup, dir); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", apply); err != nil {
			t.Fatal(err)
		}
	}
	current, err := h.app.Agents.Get(child)
	text, readErr := h.app.Agents.ConfigText(child)
	if err != nil || readErr != nil || current.Revision != 2 || current.Config.Name != "Saved edit" || !strings.Contains(string(text), "Saved edit") {
		t.Fatalf("retry did not materialize original commit: %+v %v %v", current, err, readErr)
	}
	list, err := h.app.Schedules.List(t.Context(), child)
	if err != nil || len(list) != 1 {
		t.Fatalf("retry duplicated/lost transactional schedule: %+v %v", list, err)
	}
}
