package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuilderCreationRollsBackScheduleFailureAndRetriesOnce(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	builder := h.agentOn("Builder", "script/s1", map[string]any{"templateId": "agent-builder"})
	req, _ := h.say(builder, "atomic", builderCallText("create_agent", map[string]any{"name": "Atomic", "schedule": map[string]any{"cron": "0 9 * * *", "message": "Hello", "paused": true}}))
	if req == nil {
		t.Fatal("no approval")
	}
	var proposal struct {
		AgentID string `json:"agentId"`
	}
	json.Unmarshal(req.Arguments, &proposal)
	var key string
	h.app.DB.QueryRow(`SELECT request_key FROM builder_requests WHERE caller = ?`, builder).Scan(&key)
	raw, _ := json.Marshal(map[string]string{"key": key})
	if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", raw); err == nil {
		t.Fatal("pending proposal applied without a human")
	}
	if _, err := h.app.DB.Exec(`CREATE TRIGGER reject_builder_schedule BEFORE INSERT ON schedules BEGIN SELECT RAISE(ABORT, 'schedule failed'); END`); err != nil {
		t.Fatal(err)
	}
	reply := h.settle(builder, "atomic", req, "approve")
	if !strings.Contains(reply, "Nothing was saved") {
		t.Fatalf("failure not explained: %s", reply)
	}
	if len(h.app.Agents.List()) != 1 {
		t.Fatal("partial agent remained")
	}
	var owned int
	h.app.DB.QueryRow(`SELECT COUNT(*) FROM agent_creators`).Scan(&owned)
	if owned != 0 {
		t.Fatal("partial ownership remained")
	}
	if _, err := os.Stat(filepath.Join(h.app.cfg.DataDir, "agents", proposal.AgentID)); !os.IsNotExist(err) {
		t.Fatalf("partial folder remained: %v", err)
	}
	h.app.DB.Exec(`DROP TRIGGER reject_builder_schedule`)
	for range 2 {
		if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", raw); err != nil {
			t.Fatal(err)
		}
	}
	if len(h.app.Agents.List()) != 2 {
		t.Fatal("retry created multiple agents")
	}
	list, _ := h.app.Schedules.List(t.Context(), proposal.AgentID)
	if len(list) != 1 {
		t.Fatal("retry created multiple schedules")
	}
	// Reusing a durable key with changed input cannot turn one approval into another creation.
	conflict, _ := json.Marshal(map[string]any{"key": key, "approvalId": req.ID, "tool": "create_agent", "configuration": map[string]string{"name": "Different"}})
	if _, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", conflict); err == nil {
		t.Fatal("key accepted a different configuration")
	}
}
