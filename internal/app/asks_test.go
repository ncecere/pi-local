package app

import (
	"strings"
	"testing"
	"time"
)

// scripted makes a provider whose model asks (ASK:<agent>:<question>) and reports what it got back.
func scripted(t *testing.T, h *harness) {
	t.Helper()
	fake := newFakeProvider(t, "openai", "plain reply")
	h.mustDo("POST", "/api/providers", map[string]any{"id": "script", "name": "Script", "kind": "openai-compatible", "baseUrl": fake.URL + "/v1"}, 201)
	h.mustDo("PUT", "/api/providers/script/models/s1", map[string]any{"name": "Scripted"}, 200)
}

func (h *harness) agentOn(name, model string, extra map[string]any) string {
	h.t.Helper()
	body := map[string]any{"name": name, "modelId": model}
	for k, v := range extra {
		body[k] = v
	}
	return decodeInto[struct{ ID string }](h.t, h.mustDo("POST", "/api/agents", body, 201)).ID
}

func toolResults(v view) []string {
	var out []string
	for _, m := range v.Messages {
		if m.Role == "tool" {
			out = append(out, m.Text)
		}
	}
	return out
}

type threadWithCaller struct {
	ThreadID string `json:"threadId"`
	Busy     bool   `json:"busy"`
	CalledBy *struct {
		AgentID, Name, ThreadID string
	} `json:"calledBy"`
}

func TestATeamLeadAsksAMember(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	scripted(t, h)
	lead := h.agentOn("Lead", "script/s1", nil)
	member := h.agentOn("Helper", "demo/demo-1", map[string]any{"description": "Knows things"})
	h.mustDo("POST", "/api/teams", map[string]any{"name": "Crew", "leadId": lead, "memberIds": []string{member}}, 201)

	// The lead may ask the member; the member may not ask the lead (members don't talk).
	if got := string(h.mustDo("GET", "/api/agents", nil, 200)); !strings.Contains(got, `"callable":[{"id":"`+member+`","name":"Helper","via":"team"}]`) {
		t.Fatalf("the lead's callable: %s", got)
	}

	v := h.sendAndWait(lead, "t1", "ASK:Helper:What do you know?", "r1")
	reply := lastReply(v)
	if !strings.HasPrefix(reply, "Got: ") || !strings.Contains(reply, "You said:") {
		t.Fatalf("the lead's reply should carry the member's answer: %q", reply)
	}
	// The member answered in a thread of its own, listed under it, saying who asked.
	code, data := h.do("GET", "/api/agents/"+member+"/threads", nil)
	list := decodeInto[[]threadWithCaller](t, data)
	if code != 200 || len(list) != 1 || list[0].CalledBy == nil || list[0].CalledBy.AgentID != lead || list[0].CalledBy.Name != "Lead" || list[0].CalledBy.ThreadID != "t1" {
		t.Fatalf("the member's asked thread: %d %s", code, data)
	}
	asked := h.view(member, list[0].ThreadID)
	if !strings.Contains(asked.Messages[0].Text, "What do you know?") {
		t.Fatalf("the member was sent: %+v", asked.Messages[0])
	}
	// The member's model was told who was speaking.
	if !strings.Contains(lastReply(asked), "[Message from agent Lead") {
		t.Fatalf("the member wasn't told the lead was asking: %q", lastReply(asked))
	}

	// A second ask continues the same conversation of the member's.
	h.sendAndWait(lead, "t1", "ASK:Helper:And more?", "r2")
	if got := decodeInto[[]threadWithCaller](t, h.mustDo("GET", "/api/agents/"+member+"/threads", nil, 200)); len(got) != 1 {
		t.Fatalf("a second ask should continue the member's conversation: %+v", got)
	}
}

func TestAsksNeedPermissionAndNeverLoop(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	scripted(t, h)
	a := h.agentOn("Alpha", "script/s1", nil)
	b := h.agentOn("Beta", "script/s1", nil)

	// No permission: there are no ask tools at all, so the call fails as an unknown tool.
	v := h.sendAndWait(a, "t1", "ASK:Beta:hello", "r1")
	if results := toolResults(v); len(results) != 1 || !strings.Contains(strings.ToLower(results[0]), "tool") {
		t.Fatalf("an agent that may ask nobody: %v", results)
	}

	// Each may ask the other: A asks B, and B (asked) tries to ask A back: refused, no loop.
	h.mustDo("PATCH", "/api/agents/"+a, map[string]any{"canCall": []string{b}}, 200)
	h.mustDo("PATCH", "/api/agents/"+b, map[string]any{"canCall": []string{a}}, 200)
	v = h.sendAndWait(a, "t2", "ASK:Beta:ASK:Alpha:round and round", "r2")
	if reply := lastReply(v); !strings.Contains(reply, "already part of this chain") {
		t.Fatalf("a cycle should be refused: %q", reply)
	}
	// Self and unknown agents are refused when configured, too.
	if code, data := h.do("PATCH", "/api/agents/"+a, map[string]any{"canCall": []string{a}}); code != 400 || !strings.Contains(string(data), "invalid_can_call") {
		t.Fatalf("an agent asking itself: %d %s", code, data)
	}
	if code, _ := h.do("PATCH", "/api/agents/"+a, map[string]any{"canCall": []string{"ag_nobodyhereatall"}}); code != 400 {
		t.Fatalf("an unknown agent in canCall: %d", code)
	}

	// Deleting B takes it out of A's canCall.
	h.mustDo("DELETE", "/api/agents/"+b, nil, 200)
	if got := string(h.mustDo("GET", "/api/agents", nil, 200)); !strings.Contains(got, `"canCall":[]`) {
		t.Fatalf("a deleted agent left in canCall: %s", got)
	}
}

func TestAnAskInFlightSurvivesQuittingTheApp(t *testing.T) {
	dir := t.TempDir()
	first := start(t, dir, Config{DemoTokensPerSecond: "8"})
	scripted(t, first)
	lead := first.agentOn("Lead", "script/s1", nil)
	slow := first.agentOn("Slow", "demo/demo-1", nil)
	first.mustDo("PATCH", "/api/agents/"+lead, map[string]any{"canCall": []string{slow}}, 200)
	first.mustDo("POST", "/api/agents/"+lead+"/threads/t1/messages", map[string]string{"text": "ASK:Slow:go slowly please", "requestId": "r1"}, 202)
	// Wait until the slow agent is in the middle of its answer, then quit.
	eventually(t, 20*time.Second, "the asked agent to be answering", func() bool {
		for _, th := range first.threads(slow) {
			if th.Busy {
				v := first.view(slow, th.ThreadID)
				return v.Partial != nil && v.Partial.Text != ""
			}
		}
		return false
	})
	first.close()

	second := start(t, dir, Config{DemoTokensPerSecond: "100000"})
	second.app.ResumeUnfinished(t.Context())
	eventually(t, 60*time.Second, "the lead's reply after reopening", func() bool {
		got := second.threads(lead)
		return len(got) == 1 && !got[0].Busy && got[0].LastReplyAt != nil
	})
	reply := lastReply(second.view(lead, "t1"))
	if !strings.HasPrefix(reply, "Got: ") || !strings.Contains(reply, "go slowly please") {
		t.Fatalf("the resumed ask's answer: %q", reply)
	}
	// One ask, one conversation of the slow agent's: the resume didn't ask twice.
	if got := second.threads(slow); len(got) != 1 {
		t.Fatalf("asked threads after the resume: %+v", got)
	}
	if users := strings.Count(viewUsers(second.view(slow, second.threads(slow)[0].ThreadID)), "\x00"); users != 1 {
		t.Fatalf("the slow agent was asked %d times", users)
	}
}
