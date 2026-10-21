package app

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"time"
)

type scheduleJSON struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	MadeBy     string `json:"madeBy"`
	NextFireAt *int64 `json:"nextFireAt"`
	Paused     bool   `json:"paused"`
	LastRun    *struct {
		ThreadID string  `json:"threadId"`
		Status   string  `json:"status"`
		Error    *string `json:"error"`
	} `json:"lastRun"`
}

func (h *harness) schedule(id string) scheduleJSON {
	h.t.Helper()
	for _, s := range decodeInto[[]scheduleJSON](h.t, h.mustDo("GET", "/api/schedules", nil, 200)) {
		if s.ID == id {
			return s
		}
	}
	h.t.Fatalf("no schedule %s", id)
	return scheduleJSON{}
}

func TestAReminderFiresAndItsRunFinishes(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	agent := h.createAgent("Remindee")
	at := time.Now().Add(2 * time.Second).UTC().Format(time.RFC3339)
	s := decodeInto[scheduleJSON](t, h.mustDo("POST", "/api/agents/"+agent+"/schedules", map[string]any{"at": at, "message": "Check the build", "name": "Build check"}, 201))
	if s.NextFireAt == nil || s.MadeBy != "user" {
		t.Fatalf("created: %+v", s)
	}
	eventually(t, 30*time.Second, "the reminder to fire and its reply to end", func() bool {
		got := h.schedule(s.ID)
		return got.LastRun != nil && got.LastRun.Status == "done"
	})
	got := h.schedule(s.ID)
	if got.NextFireAt != nil {
		t.Fatalf("a reminder fires once: %+v", got)
	}
	// The run is a conversation of its own, sent as the schedule (the agent was told who spoke).
	v := h.view(agent, got.LastRun.ThreadID)
	if v.Messages[0].Text != "Check the build" || !strings.Contains(lastReply(v), "[Message from trigger Build check]") {
		t.Fatalf("the run's conversation: %+v", v.Messages)
	}

	// A recurring schedule, run now by hand; a bad cron is refused.
	daily := decodeInto[scheduleJSON](t, h.mustDo("POST", "/api/agents/"+agent+"/schedules", map[string]any{"cron": "0 9 * * 1-5", "timezone": "America/New_York", "message": "Morning summary"}, 201))
	if daily.NextFireAt == nil || time.UnixMilli(*daily.NextFireAt).Before(time.Now()) {
		t.Fatalf("next fire: %+v", daily)
	}
	h.mustDo("POST", "/api/schedules/"+daily.ID+"/run", nil, 200)
	eventually(t, 20*time.Second, "the run now to finish", func() bool {
		got := h.schedule(daily.ID)
		return got.LastRun != nil && got.LastRun.Status == "done"
	})
	for _, bad := range []map[string]any{{"cron": "every tuesday", "message": "x"}, {"at": "2001-01-01T00:00", "message": "x"}, {"cron": "@daily", "message": "x", "timezone": "Mars/Base"}} {
		if code, data := h.do("POST", "/api/agents/"+agent+"/schedules", bad); code != 400 {
			t.Fatalf("%v: %d %s", bad, code, data)
		}
	}
}

func TestAFireMissedWhileClosedRunsOnceAtTheNextStart(t *testing.T) {
	dir := t.TempDir()
	first := start(t, dir, Config{DemoTokensPerSecond: "100000"})
	agent := first.createAgent("Sleepy")
	s := decodeInto[scheduleJSON](t, first.mustDo("POST", "/api/agents/"+agent+"/schedules", map[string]any{"cron": "@daily", "message": "Daily digest"}, 201))
	// It was due an hour ago, while the app was closed.
	first.app.DB.Exec(`UPDATE schedules SET next_fire_at = ? WHERE id = ?`, time.Now().Add(-time.Hour).UnixMilli(), s.ID)
	first.close()

	second := start(t, dir, Config{DemoTokensPerSecond: "100000"})
	eventually(t, 30*time.Second, "the missed fire to run once", func() bool {
		got := second.schedule(s.ID)
		return got.LastRun != nil && got.LastRun.Status == "done"
	})
	if got := second.schedule(s.ID); got.NextFireAt == nil || time.UnixMilli(*got.NextFireAt).Before(time.Now()) {
		t.Fatalf("it should be moved to its next fire: %+v", got)
	}
}

func TestAnAgentSchedulesItsOwnWork(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	scripted(t, h)
	agent := h.agentOn("Planner", "script/s1", map[string]any{"schedules": map[string]any{"agentMade": true}})
	reply := lastReply(h.sendAndWait(agent, "t1", `CALL:schedule:{"when":"0 8 * * *","timezone":"Europe/Paris","message":"Send the morning report","name":"Morning report"}`, "r1"))
	if !strings.Contains(reply, "Recurring schedule set") || !strings.Contains(reply, "this conversation") {
		t.Fatalf("the schedule tool: %q", reply)
	}
	list := decodeInto[[]scheduleJSON](t, h.mustDo("GET", "/api/agents/"+agent+"/schedules", nil, 200))
	if len(list) != 1 || list[0].MadeBy != "agent" || list[0].Name != "Morning report" {
		t.Fatalf("the agent's schedule: %+v", list)
	}
	// Too often is refused.
	if reply := lastReply(h.sendAndWait(agent, "t1", `CALL:schedule:{"when":"* * * * *","message":"spam"}`, "r2")); !strings.Contains(reply, "at most every 5 minutes") {
		t.Fatalf("an every-minute schedule: %q", reply)
	}
	// It lists and cancels its own, and not a person's.
	h.mustDo("POST", "/api/agents/"+agent+"/schedules", map[string]any{"cron": "@weekly", "message": "A person's"}, 201)
	listed := lastReply(h.sendAndWait(agent, "t1", `CALL:list_schedules:{}`, "r3"))
	if !strings.Contains(listed, "Morning report") || strings.Contains(listed, "A person's") {
		t.Fatalf("list_schedules: %q", listed)
	}
	cancelled := lastReply(h.sendAndWait(agent, "t1", `CALL:cancel_schedule:{"id":"`+list[0].ID+`"}`, "r4"))
	if !strings.Contains(cancelled, "Got:") || len(decodeInto[[]scheduleJSON](t, h.mustDo("GET", "/api/agents/"+agent+"/schedules", nil, 200))) != 1 {
		t.Fatalf("cancel_schedule: %q", cancelled)
	}
	// Without agentMade it has no schedule tools.
	other := h.agentOn("Plain", "script/s1", nil)
	if reply := lastReply(h.sendAndWait(other, "t1", `CALL:schedule:{"when":"@daily","message":"x"}`, "r1")); strings.Contains(reply, "set") {
		t.Fatalf("an agent without schedules scheduled: %q", reply)
	}
}

func TestSearchingMessages(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	agent := h.createAgent("Archivist")
	h.sendAndWait(agent, "t1", "The quarterly numbers from Zürich look promising", "r1")
	h.sendAndWait(agent, "t2", "Something else entirely", "r2")
	type results struct {
		Results []struct {
			AgentID, ThreadID, Snippet string
		} `json:"results"`
	}
	var got results
	eventually(t, 10*time.Second, "the conversation to be indexed", func() bool {
		got = decodeInto[results](t, h.mustDo("GET", "/api/search?q="+url.QueryEscape("zurich quart"), nil, 200))
		return len(got.Results) == 1
	})
	if got.Results[0].ThreadID != "t1" || !strings.Contains(got.Results[0].Snippet, "\u0001") {
		t.Fatalf("a match with its words marked: %+v", got)
	}
	// FTS syntax in a query is only words.
	h.mustDo("GET", "/api/search?q="+url.QueryEscape(`"unbalanced OR NEAR(`), nil, 200)
	if got := decodeInto[results](t, h.mustDo("GET", "/api/search?q=a", nil, 200)); len(got.Results) != 0 {
		t.Fatalf("a one-letter query: %+v", got)
	}
	// A deleted conversation is gone from search.
	h.mustDo("DELETE", "/api/agents/"+agent+"/threads/t1", nil, 200)
	if got := decodeInto[results](t, h.mustDo("GET", "/api/search?q=zurich", nil, 200)); len(got.Results) != 0 {
		t.Fatalf("a deleted conversation still found: %+v", got)
	}
	if !strings.Contains(string(h.mustDo("GET", "/api/me", nil, 200)), `"messageSearch":true`) {
		t.Fatal("search should be on")
	}
}

func TestEditingAMessageMakesANewConversation(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	agent := h.createAgent("Editor")
	h.sendAndWait(agent, "t1", "first question", "r1")
	v := h.sendAndWait(agent, "t1", "second question", "r2")
	raw, _ := json.Marshal(v)
	var ids struct {
		Messages []struct{ ID, Role string } `json:"messages"`
	}
	json.Unmarshal([]byte(h.mustDo("GET", "/api/agents/"+agent+"/threads/t1", nil, 200)), &ids)
	second := ids.Messages[2].ID
	forked := decodeInto[struct {
		ThreadID string `json:"threadId"`
		Title    string `json:"title"`
	}](t, h.mustDo("POST", "/api/agents/"+agent+"/threads/t1/fork", map[string]string{"beforeMessageId": second}, 201))
	if forked.ThreadID == "" || forked.ThreadID == "t1" || forked.Title != "first question (edited)" {
		t.Fatalf("fork: %+v (%s)", forked, raw)
	}
	if got := h.view(agent, forked.ThreadID); len(got.Messages) != 2 {
		t.Fatalf("the fork keeps the first exchange: %+v", got.Messages)
	}
	edited := h.sendAndWait(agent, forked.ThreadID, "second question, better", "r3")
	if edited.Messages[2].Text != "second question, better" || len(h.threads(agent)) != 2 {
		t.Fatalf("the edited conversation: %+v", edited.Messages)
	}
	// A branch from the copy is marked once, not "(edited) (branch)".
	branch := decodeInto[struct{ Title string }](t, h.mustDo("POST", "/api/agents/"+agent+"/threads/"+forked.ThreadID+"/fork", map[string]string{"afterMessageId": lastUserMessageID(t, h, agent, forked.ThreadID)}, 201))
	if branch.Title != "first question (branch)" {
		t.Fatalf("a branch's title: %q", branch.Title)
	}
	if code, _ := h.do("POST", "/api/agents/"+agent+"/threads/t1/fork", map[string]string{"beforeMessageId": "e999999"}); code != 400 {
		t.Fatalf("a message that isn't there: %d", code)
	}
}

// A schedule moves to another agent: its runs start conversations there.
func TestAScheduleMovesToAnotherAgent(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	from := h.createAgent("Old")
	to := h.createAgent("New")
	s := decodeInto[scheduleJSON](t, h.mustDo("POST", "/api/agents/"+from+"/schedules", map[string]any{"cron": "@daily", "message": "Digest"}, 201))
	moved := decodeInto[struct {
		AgentID, ThreadMode string
	}](t, h.mustDo("PATCH", "/api/schedules/"+s.ID, map[string]any{"agentId": to}, 200))
	if moved.AgentID != to || moved.ThreadMode != "new" {
		t.Fatalf("moved: %+v", moved)
	}
	h.mustDo("PATCH", "/api/schedules/"+s.ID, map[string]any{"agentId": "ag_nobody"}, 400)
	h.mustDo("POST", "/api/schedules/"+s.ID+"/run", nil, 200)
	eventually(t, 20*time.Second, "the run on the new agent", func() bool {
		got := h.schedule(s.ID)
		return got.LastRun != nil && got.LastRun.Status == "done"
	})
	if v := h.view(to, h.schedule(s.ID).LastRun.ThreadID); len(v.Messages) == 0 || v.Messages[0].Text != "Digest" {
		t.Fatalf("the run's conversation on the new agent: %+v", v.Messages)
	}
}

// lastUserMessageID is the id of a thread's last user message (branching after it).
func lastUserMessageID(t *testing.T, h *harness, agent, thread string) string {
	t.Helper()
	v := decodeInto[struct {
		Messages []struct{ ID, Role string } `json:"messages"`
	}](t, h.mustDo("GET", "/api/agents/"+agent+"/threads/"+thread, nil, 200))
	for i := len(v.Messages) - 1; i >= 0; i-- {
		if v.Messages[i].Role == "user" {
			return v.Messages[i].ID
		}
	}
	t.Fatal("no user message")
	return ""
}
