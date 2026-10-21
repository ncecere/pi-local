package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuilderRejectsIncompleteApprovalAndStaleUpdate(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	builder := h.agentOn("Builder", "script/s1", map[string]any{"templateId": "agent-builder"})
	req, _ := h.say(builder, "match", builderCallText("create_agent", map[string]any{"name": "Exact"}))
	if req == nil {
		t.Fatal("no approval")
	}
	var target struct {
		AgentID string `json:"agentId"`
	}
	json.Unmarshal(req.Arguments, &target)
	// A partial/redacted report cannot authorize configuration fields the person did not see.
	h.app.DB.Exec(`UPDATE approvals SET arguments = '{}' WHERE agent_id = ? AND id = ?`, builder, req.ID)
	reply := h.settle(builder, "match", req, "approve")
	if !strings.Contains(reply, "does not match") || len(h.app.Agents.List()) != 1 {
		t.Fatalf("incomplete approval applied: %s", reply)
	}
	h.app.DB.Exec(`UPDATE approvals SET arguments = ? WHERE agent_id = ? AND id = ?`, string(req.Arguments), builder, req.ID)
	var key string
	h.app.DB.QueryRow(`SELECT request_key FROM builder_requests WHERE caller = ?`, builder).Scan(&key)
	raw, _ := json.Marshal(map[string]string{"key": key})
	if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", raw); err != nil {
		t.Fatal(err)
	}
	req, _ = h.say(builder, "stale", builderCallText("update_agent", map[string]any{"agent": target.AgentID, "name": "Old proposal"}))
	if req == nil {
		t.Fatal("no update approval")
	}
	h.mustDo("PATCH", "/api/agents/"+target.AgentID, map[string]string{"name": "Person's latest edit"}, 200)
	before, err := os.Stat(filepath.Join(h.app.cfg.DataDir, "agents", target.AgentID, "agent.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	reply = h.settle(builder, "stale", req, "approve")
	if !strings.Contains(reply, "changed after this proposal") {
		t.Fatalf("stale update applied: %s", reply)
	}
	child, _ := h.app.Agents.Get(target.AgentID)
	text, _ := h.app.Agents.ConfigText(target.AgentID)
	after, err := os.Stat(filepath.Join(child.Dir, "agent.yaml"))
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("stale approval replaced live file, even temporarily: %v", err)
	}
	if child.Config.Name != "Person's latest edit" || strings.Contains(string(text), "Old proposal") {
		t.Fatal("stale update changed config on disk or in memory")
	}
}
