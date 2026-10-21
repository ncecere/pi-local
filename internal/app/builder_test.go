package app

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/templates"
)

func builderCallText(tool string, cfg any) string {
	raw, _ := json.Marshal(cfg)
	return "CALL:" + tool + ":" + string(raw)
}

func TestBuilderApprovedCreationOwnershipAndReplay(t *testing.T) {
	data := t.TempDir()
	h := start(t, data, Config{})
	scripted(t, h)
	builder := h.agentOn("Builder", "script/s1", map[string]any{"templateId": "agent-builder", "approvals": map[string]any{"profile": "trusting", "rules": []map[string]any{{"tool": "*", "action": "allow"}}}})
	unrelated := h.createAgent("Unrelated")
	full := strings.Repeat("instruction line\n", 1100) + "THE END"
	input := map[string]any{"templateId": "assistant", "name": "Made", "description": "Created together", "instructions": full, "modelId": "demo/demo-1", "workspace": map[string]any{"tools": []string{"read"}}, "schedule": map[string]any{"cron": "0 9 * * *", "message": "Review the day", "paused": true}}
	req, reply := h.say(builder, "make", builderCallText("create_agent", input))
	if req == nil {
		t.Fatalf("Trusting plus allow must still ask: %s", reply)
	}
	var proposal struct {
		YAML     string         `json:"yaml"`
		AgentID  string         `json:"agentId"`
		Schedule map[string]any `json:"schedule"`
	}
	if err := json.Unmarshal(req.Arguments, &proposal); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(proposal.YAML, "THE END") || !strings.Contains(proposal.YAML, "approvals:") || proposal.Schedule["missedPolicy"] != "run_once" {
		t.Fatalf("approval omitted fields: %.200s", req.Arguments)
	}
	if len(h.app.Agents.List()) != 2 {
		t.Fatal("creation happened before approval")
	}
	// Hibernation during approval resumes the same durable request and prepared configuration.
	h.app.Sup.Stop(builder)
	h.settle(builder, "make", req, "approve")
	child, err := h.app.Agents.Get(proposal.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if child.Config.Instructions != full || child.Config.Builder {
		t.Fatalf("wrong approved config: %+v", child.Config)
	}
	var owner, key string
	if err := h.app.DB.QueryRow(`SELECT creator_id,request_key FROM agent_creators WHERE agent_id = ?`, child.ID).Scan(&owner, &key); err != nil || owner != builder {
		t.Fatalf("ownership: %s %v", owner, err)
	}
	scheds, _ := h.app.Schedules.List(t.Context(), child.ID)
	if len(scheds) != 1 || !scheds[0].Paused {
		t.Fatalf("first schedule: %+v", scheds)
	}
	// Reopen the whole app: replay uses app.db, not a process cache.
	h.close()
	h = start(t, data, Config{})
	raw, _ := json.Marshal(map[string]any{"key": key})
	for range 3 {
		if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", raw); err != nil {
			t.Fatal(err)
		}
	}
	if len(h.app.Agents.List()) != 3 {
		t.Fatal("replay duplicated creation")
	}
	scheds, _ = h.app.Schedules.List(t.Context(), child.ID)
	if len(scheds) != 1 {
		t.Fatal("replay duplicated schedule")
	}

	update := map[string]any{"agent": child.ID, "name": "Made better"}
	req, _ = h.say(builder, "update", builderCallText("update_agent", update))
	if req == nil {
		t.Fatal("update did not ask")
	}
	h.settle(builder, "update", req, "approve")
	changed, _ := h.app.Agents.Get(child.ID)
	if changed.Config.Name != "Made better" || changed.Config.Instructions != full {
		t.Fatal("update lost fields")
	}
	for name, id := range map[string]string{"self": builder, "unrelated": unrelated} {
		req, reply = h.say(builder, name, builderCallText("update_agent", map[string]any{"agent": id, "name": "Forbidden"}))
		if req != nil || !strings.Contains(reply, "only agents you created") {
			t.Fatalf("ownership bypass %s: %+v %s", name, req, reply)
		}
	}
	// Other opted-in builders do not inherit ownership.
	other := h.agentOn("Other builder", "script/s1", map[string]any{"templateId": "agent-builder"})
	req, reply = h.say(other, "other", builderCallText("update_agent", map[string]any{"agent": child.ID, "name": "Stolen"}))
	if req != nil || !strings.Contains(reply, "only agents you created") {
		t.Fatalf("other builder: %s", reply)
	}
}

func TestBuilderDenialCapabilityAndUnsupportedSettings(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	ordinary := h.agentOn("Ordinary", "script/s1", nil)
	builder := h.agentOn("Builder", "script/s1", map[string]any{"templateId": "agent-builder", "approvals": map[string]any{"profile": "custom", "tools": []string{}}})
	req, reply := h.say(ordinary, "no-tools", builderCallText("create_agent", map[string]any{"name": "Not made"}))
	if req != nil || !strings.Contains(reply, "not available") {
		t.Fatalf("ordinary agent got builder tools: %+v %s", req, reply)
	}
	raw := json.RawMessage(`{"key":"x","approvalId":"ap_x","tool":"create_agent","configuration":{"name":"No"}}`)
	if _, err := h.app.API.BuilderCall(t.Context(), ordinary, "prepare", raw); err == nil {
		t.Fatal("gateway capability bypass")
	}
	req, _ = h.say(builder, "deny", builderCallText("create_agent", map[string]any{"name": "Denied"}))
	if req == nil {
		t.Fatal("custom empty policy failed to ask")
	}
	h.settle(builder, "deny", req, "deny")
	if len(h.app.Agents.List()) != 2 {
		t.Fatal("denial created an agent")
	}
	var key string
	h.app.DB.QueryRow(`SELECT request_key FROM builder_requests WHERE caller = ?`, builder).Scan(&key)
	replay, _ := json.Marshal(map[string]string{"key": key})
	if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", replay); err == nil {
		t.Fatal("denied gateway apply succeeded")
	}
	for i, field := range []string{"knowledge", "skills", "setupCommand"} {
		raw, _ := json.Marshal(map[string]any{"key": field, "approvalId": "ap_test", "tool": "create_agent", "configuration": map[string]any{"name": "Bad", field: map[string]any{}}})
		if _, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw); err == nil || !strings.Contains(err.Error(), field) {
			t.Fatalf("unsupported %d: %v", i, err)
		}
	}
	h.mustDo("PATCH", "/api/agents/"+builder, map[string]any{"approvals": map[string]any{"rules": []map[string]any{{"tool": "create_agent", "args": map[string]string{"name": "Forbidden*"}, "action": "deny"}}}}, 200)
	req, reply = h.say(builder, "rule-deny", builderCallText("create_agent", map[string]any{"name": "Forbidden creation"}))
	if req != nil || !strings.Contains(reply, "Not allowed by your approval rules") || len(h.app.Agents.List()) != 2 {
		t.Fatalf("a builder bypassed a deny rule: %+v %s", req, reply)
	}
}

func TestBuilderTemplateRoundTripAndConciergePermissions(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	for _, enabled := range []bool{false, true} {
		tp := templates.FromAgent("roundtrip", agents.Config{Name: "Portable", Kind: "assistant", Model: agents.DemoModel, Builder: enabled})
		parsed, err := templates.Parse(templates.Marshal(tp))
		if err != nil {
			t.Fatal(err)
		}
		var cfg agents.Config
		parsed.Apply(&cfg)
		if cfg.Builder != enabled {
			t.Fatalf("builder opt-in lost: %v", enabled)
		}
	}
	front := h.agentOn("Concierge", "script/s1", map[string]any{"templateId": "concierge"})
	helper := h.agentOn("Helper", "demo/demo-1", nil)
	ag, _ := h.app.Agents.Get(front)
	if ag.Config.Builder || len(ag.Config.CanCall) != 0 || !strings.Contains(ag.Config.Instructions, "Can ask") {
		t.Fatalf("concierge grants access: %+v", ag.Config)
	}
	if peers := (askGateway{h.app}).Peers(t.Context(), front); len(peers) != 0 {
		t.Fatal("concierge sees unrelated agents")
	}
	h.mustDo("PATCH", "/api/agents/"+front, map[string]any{"canCall": []string{helper}}, 200)
	peers := (askGateway{h.app}).Peers(t.Context(), front)
	if len(peers) != 1 || peers[0].ID != helper {
		t.Fatal("explicit permission missing")
	}
}
