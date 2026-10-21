package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestAgentsAskNotifyAndKeepAChecklist(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	scripted(t, h)
	agent := h.agentOn("Helper", "script/s1", nil)
	events, cancel := h.app.Hub.Subscribe()
	defer cancel()

	// ask_person with choices: a card like an MCP question; the answer comes back to the agent.
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": `CALL:ask_person:{"question":"Which day works?","choices":["Monday","Tuesday"]}`, "requestId": "r1"}, 202)
	var q elicitationJSON
	eventually(t, 30*time.Second, "the question", func() bool {
		list := decodeInto[[]elicitationJSON](t, h.mustDo("GET", "/api/elicitations", nil, 200))
		if len(list) == 1 {
			q = list[0]
		}
		return len(list) == 1
	})
	if q.ServerName != "Helper" || q.Message != "Which day works?" || q.Tool == nil || *q.Tool != "ask_person" {
		t.Fatalf("question: %+v", q)
	}
	h.mustDo("POST", "/api/elicitations/"+q.ID, map[string]any{"action": "accept", "content": map[string]any{"answer": "Tuesday"}}, 200)
	if reply := lastReply(h.waitReply(agent, "t1")); !strings.Contains(reply, "They answered: Tuesday") {
		t.Fatalf("answer: %q", reply)
	}
	// The step's details say what happened, for the app.
	if v := string(h.mustDo("GET", "/api/agents/"+agent+"/threads/t1", nil, 200)); !strings.Contains(v, `"outcome":"answered"`) || !strings.Contains(v, `"answer":"Tuesday"`) {
		t.Fatalf("the step's details: %.600s", v)
	}
	// Declined yes/no.
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t2/messages", map[string]string{"text": `CALL:ask_person:{"question":"Delete the draft?","yes_no":true}`, "requestId": "r1"}, 202)
	eventually(t, 30*time.Second, "the yes/no", func() bool {
		list := decodeInto[[]elicitationJSON](t, h.mustDo("GET", "/api/elicitations", nil, 200))
		if len(list) == 1 {
			q = list[0]
		}
		return len(list) == 1
	})
	h.mustDo("POST", "/api/elicitations/"+q.ID, map[string]any{"action": "decline"}, 200)
	if reply := lastReply(h.waitReply(agent, "t2")); !strings.Contains(reply, "They answered: no") {
		t.Fatalf("declined: %q", reply)
	}

	// notify_person: an event for the desktop app; a second one at once is refused.
	if reply := lastReply(h.sendAndWait(agent, "t3", `CALL:notify_person:{"title":"Report ready","message":"Your weekly report is done."}`, "r1")); !strings.Contains(reply, "Notification sent") {
		t.Fatalf("notify: %q", reply)
	}
	saw := false
	for !saw {
		select {
		case ev := <-events:
			if ev.Name == "notification" {
				var n struct{ AgentName, Title, ThreadID string }
				json.Unmarshal(ev.Data, &n)
				saw = n.AgentName == "Helper" && n.Title == "Report ready" && n.ThreadID == "t3"
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no notification event")
		}
	}
	if reply := lastReply(h.sendAndWait(agent, "t3", `CALL:notify_person:{"title":"Again","message":"x"}`, "r2")); !strings.Contains(reply, "very recently") {
		t.Fatalf("rate limit: %q", reply)
	}

	// todo: a checklist document beside the conversation.
	h.sendAndWait(agent, "t4", `CALL:todo:{"items":[{"text":"Read the brief","status":"done"},{"text":"Draft","status":"doing"}]}`, "r1")
	// Listed with the thread only once written (no empty checklist in every conversation).
	if v := string(h.mustDo("GET", "/api/agents/"+agent+"/threads/t3", nil, 200)); strings.Contains(v, `"todo"`) {
		t.Fatalf("a thread without a checklist lists one: %s", v)
	}
	if v := string(h.mustDo("GET", "/api/agents/"+agent+"/threads/t4", nil, 200)); !strings.Contains(v, `"todo":{"revision"`) {
		t.Fatalf("the checklist isn't listed: %.400s", v)
	}
	doc := string(h.mustDo("GET", "/api/agents/"+agent+"/threads/t4/documents/todo", nil, 200))
	if !strings.Contains(doc, "Read the brief") || !strings.Contains(doc, `"doing"`) {
		t.Fatalf("todo document: %s", doc)
	}
}
