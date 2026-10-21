package app

import (
	"strings"
	"testing"
	"time"
)

// The person picks a conversation's model and thinking level in the composer: the message runs on it, the
// conversation keeps it, usage counts under it, and turning the choice off brings back the agent's own model.
func TestAConversationRunsOnTheModelThePersonChose(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	fake := newFakeProvider(t, "openai", "plain reply")
	h.mustDo("POST", "/api/providers", map[string]any{"id": "two", "name": "Two", "kind": "openai-compatible", "baseUrl": fake.URL + "/v1"}, 201)
	h.mustDo("PUT", "/api/providers/two/models/quick", map[string]any{"name": "Quick"}, 200)
	h.mustDo("PUT", "/api/providers/two/models/strong", map[string]any{"name": "Strong", "reasoning": true}, 200)
	agent := h.agentOn("Helper", "two/quick", nil)

	me := string(h.mustDo("GET", "/api/me", nil, 200))
	if !strings.Contains(me, `"secretsInKeychain":false`) {
		t.Fatalf("tests keep secrets in memory: %s", me)
	}
	if !strings.Contains(me, `"modelPerConversation":true`) {
		t.Fatalf("on by default: %s", me)
	}
	last := func() fakeRequest {
		chats := fake.chats()
		return chats[len(chats)-1]
	}

	// The agent's own model, then the chosen one with high thinking; the conversation remembers the choice.
	h.sendAndWait(agent, "t1", "first", "r1")
	if m := last().Model; m != "quick" {
		t.Fatalf("own model: %q", m)
	}
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]any{"text": "second", "requestId": "r2", "modelId": "two/strong", "thinking": "high"}, 202)
	h.waitReply(agent, "t1")
	if r := last(); r.Model != "strong" || !strings.Contains(string(r.Body), `"reasoning_effort":"high"`) {
		t.Fatalf("chosen model: %q %s", r.Model, r.Body)
	}
	thread := decodeInto[struct{ ModelID, Thinking string }](t, h.mustDo("GET", "/api/agents/"+agent+"/threads/t1", nil, 200))
	if thread.ModelID != "two/strong" || thread.Thinking != "high" {
		t.Fatalf("thread keeps the choice: %+v", thread)
	}
	// A message that doesn't say keeps it.
	h.sendAndWait(agent, "t1", "third", "r3")
	if m := last().Model; m != "strong" {
		t.Fatalf("kept: %q", m)
	}
	// Another conversation is unaffected.
	h.sendAndWait(agent, "t2", "elsewhere", "r1")
	if m := last().Model; m != "quick" {
		t.Fatalf("other thread: %q", m)
	}

	// Usage counts under the model that answered.
	eventually(t, 20*time.Second, "usage for both models", func() bool {
		u := string(h.mustDo("GET", "/api/me/usage?days=7", nil, 200))
		return strings.Contains(u, `"two/strong"`) && strings.Contains(u, `"two/quick"`)
	})

	// Bad choices are refused; thinking on a model that doesn't reason is dropped.
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t3/messages", map[string]any{"text": "x", "modelId": "two/missing"}, 400)
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t3/messages", map[string]any{"text": "x", "thinking": "extreme"}, 400)
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t3/messages", map[string]any{"text": "x", "modelId": "demo/demo-1"}, 400)
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t4/messages", map[string]any{"text": "x", "requestId": "r1", "thinking": "high"}, 202)
	h.waitReply(agent, "t4")
	if th := decodeInto[struct{ Thinking string }](t, h.mustDo("GET", "/api/agents/"+agent+"/threads/t4", nil, 200)).Thinking; th != "" {
		t.Fatalf("thinking on a model that doesn't reason: %q", th)
	}

	// Turned off: back to the agent's model, even in the conversation that chose another.
	h.mustDo("PUT", "/api/settings/chat", map[string]any{"modelPerConversation": false}, 200)
	h.sendAndWait(agent, "t1", "fourth", "r4")
	if m := last().Model; m != "quick" {
		t.Fatalf("turned off: %q", m)
	}
	if !strings.Contains(string(h.mustDo("GET", "/api/me", nil, 200)), `"modelPerConversation":false`) {
		t.Fatal("me says it's off")
	}
}
