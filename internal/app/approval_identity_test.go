package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The real supervisor/SQLite/runtime path: a restarted provider reuses call_1 in the same conversation.
func TestRepeatedProviderIDKeepsApprovalOccurrence(t *testing.T) {
	h := start(t, t.TempDir(), Config{}) // secrets.NewMemory(), no keychain
	fake := newFakeProvider(t, "openai", "done")
	h.mustDo("POST", "/api/providers", map[string]any{"id": "script", "name": "Script", "kind": "openai-compatible", "baseUrl": fake.URL + "/v1"}, 201)
	h.mustDo("PUT", "/api/providers/script/models/s1", map[string]any{"name": "Scripted"}, 200)
	agent := h.agentOn("Careful worker", "script/s1", map[string]any{
		"workspace": map[string]any{"tools": []string{"bash"}},
		"approvals": map[string]any{"profile": "careful"},
	})
	base := "/api/agents/" + agent
	thread := base + "/threads/t1"
	type call struct {
		ID, InstanceID, TaskID string
		Arguments              json.RawMessage
		EndedAt                *float64
		Approval               struct{ ID, Status string }
	}
	type message struct {
		Role, InstanceID, TaskID string
		ToolCalls                []call
	}
	type chat struct {
		Messages  []message
		Approvals []struct {
			ID, TaskID string
			Arguments  json.RawMessage
		}
	}
	calls := func(v chat) []call {
		var out []call
		for _, m := range v.Messages {
			out = append(out, m.ToolCalls...)
		}
		return out
	}
	get := func(path string) chat {
		v := decodeInto[chat](t, h.mustDo("GET", path, nil, 200))
		for i := range v.Messages {
			for j := range v.Messages[i].ToolCalls {
				c := &v.Messages[i].ToolCalls[j]
				var args any
				if err := json.Unmarshal(c.Arguments, &args); err != nil {
					t.Fatal(err)
				}
				c.Arguments, _ = json.Marshal(args)
			}
		}
		return v
	}
	h.mustDo("POST", thread+"/messages", map[string]string{"text": "RUN:echo first > first.txt", "requestId": "a"}, 202)
	a := h.pendingApproval(agent)
	h.mustDo("POST", base+"/approvals/"+a.ID, map[string]string{"decision": "approve"}, 200)
	h.waitReply(agent, "t1")
	old := calls(get(thread))[0]
	if old.ID != "call_1" || old.InstanceID == "" || old.TaskID == "" || old.EndedAt == nil || old.Approval.ID != a.ID || old.Approval.Status != "approved" {
		t.Fatalf("first call: %+v", old)
	}
	fake.mu.Lock()
	fake.calls = 0 // provider process restart, without losing the conversation's history
	fake.mu.Unlock()
	h.mustDo("POST", thread+"/messages", map[string]string{"text": "RUN:echo exact-second > second.txt", "requestId": "b"}, 202)
	b := h.pendingApproval(agent)
	waiting := get(thread)
	all := calls(waiting)
	if len(all) != 2 {
		t.Fatalf("calls: %+v", all)
	}
	current := all[1]
	if current.ID != old.ID || current.InstanceID == old.InstanceID || current.TaskID == old.TaskID || current.EndedAt != nil || current.Approval.ID != b.ID || current.Approval.Status != "pending" {
		t.Fatalf("pending second call: %+v (old %+v)", current, old)
	}
	if !reflect.DeepEqual(old, all[0]) {
		t.Fatalf("history changed: %+v", all[0])
	}
	if len(waiting.Approvals) != 1 || waiting.Approvals[0].ID != b.ID || waiting.Approvals[0].TaskID != current.TaskID {
		t.Fatalf("pending list: %+v", waiting.Approvals)
	}
	var args map[string]any
	if err := json.Unmarshal(waiting.Approvals[0].Arguments, &args); err != nil || args["command"] != "echo exact-second > second.txt" {
		t.Fatalf("wrong snapshot arguments: %s (%v)", waiting.Approvals[0].Arguments, err)
	}
	ws := filepath.Join(h.app.cfg.DataDir, "agents", agent, "workspace")
	if _, err := os.Stat(filepath.Join(ws, "second.txt")); !os.IsNotExist(err) {
		t.Fatalf("B executed unapproved: %v", err)
	}
	// Hibernation rebuilds the identity index from durable task inputs, and a page need not contain A.
	h.mustDo("POST", base+"/sleep", nil, 200)
	if reloaded := calls(get(thread)); !reflect.DeepEqual(reloaded, all) {
		t.Fatalf("reload changed calls: %+v", reloaded)
	}
	page := get(thread + "?limit=1")
	if got := calls(page); len(got) != 1 || !reflect.DeepEqual(got[0], current) || page.Approvals[0].ID != b.ID {
		t.Fatalf("paged pending call: %+v", page)
	}
	h.mustDo("POST", base+"/approvals/"+b.ID, map[string]string{"decision": "approve"}, 200)
	h.waitReply(agent, "t1")
	if raw, err := os.ReadFile(filepath.Join(ws, "second.txt")); err != nil || string(raw) != "exact-second\n" {
		t.Fatalf("exact approved B: %q, %v", raw, err)
	}
	final := calls(get(thread))
	if !reflect.DeepEqual(final[0], old) || final[1].Approval.ID != b.ID || final[1].Approval.Status != "approved" || final[1].EndedAt == nil {
		t.Fatalf("final: %+v", final)
	}
}
