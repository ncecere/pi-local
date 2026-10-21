package app

import (
	"encoding/csv"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

type activityJSON struct {
	ID         int64           `json:"id"`
	At         int64           `json:"at"`
	Kind       string          `json:"kind"`
	AgentID    *string         `json:"agentId"`
	AgentName  string          `json:"agentName"`
	ThreadID   *string         `json:"threadId"`
	Actor      string          `json:"actor"`
	Title      string          `json:"title"`
	Outcome    string          `json:"outcome"`
	DurationMs *int64          `json:"durationMs"`
	Detail     json.RawMessage `json:"detail"`
}

func (e activityJSON) thread() string {
	if e.ThreadID == nil {
		return ""
	}
	return *e.ThreadID
}

// field reads one field of an entry's detail ("approval.status" goes one level down).
func (e activityJSON) field(path string) any {
	var v any
	json.Unmarshal(e.Detail, &v)
	for _, key := range strings.Split(path, ".") {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[key]
	}
	return v
}

type activityPage struct {
	Items      []activityJSON `json:"items"`
	NextBefore *string        `json:"nextBefore"`
}

func (h *harness) activity(query string) activityPage {
	h.t.Helper()
	return decodeInto[activityPage](h.t, h.mustDo("GET", "/api/activity?"+query, nil, 200))
}

// activityWith waits until the query lists at least n entries, and returns them.
func (h *harness) activityWith(query string, n int) []activityJSON {
	h.t.Helper()
	var got []activityJSON
	eventually(h.t, 30*time.Second, "activity for "+query, func() bool {
		got = h.activity(query).Items
		return len(got) >= n
	})
	return got
}

func TestTheActivityLogRecordsMessagesToolCallsAndApprovals(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	agent := toolsAgent(t, h, []string{"read", "write", "bash"}, []string{"bash"})
	other := h.createAgent("Bystander")

	// One call the person approves, one they deny, one that needs no approval; a message that holds a pasted key.
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": "RUN:echo hello > made.txt && cat made.txt", "requestId": "r1"}, 202)
	req := h.pendingApproval(agent)
	h.mustDo("POST", "/api/agents/"+agent+"/approvals/"+req.ID, map[string]string{"decision": "approve"}, 200)
	h.waitReply(agent, "t1")

	h.mustDo("POST", "/api/agents/"+agent+"/threads/t2/messages", map[string]string{"text": "RUN:rm -rf something", "requestId": "r2"}, 202)
	req = h.pendingApproval(agent)
	h.mustDo("POST", "/api/agents/"+agent+"/approvals/"+req.ID, map[string]string{"decision": "deny", "reason": "not today"}, 200)
	h.waitReply(agent, "t2")

	long := "WRITE:notes.md:" + strings.Repeat("a long note ", 40) + " and a key sk-proj-" + strings.Repeat("aB3", 16)
	h.sendAndWait(agent, "t3", long, "r3")

	// Tool calls: what ran, how it ended, with the redacted arguments, the thread, and the decision.
	tools := h.activityWith("agent="+agent+"&kind=tool", 3)
	byThread := map[string]activityJSON{}
	for _, e := range tools {
		byThread[e.thread()] = e
	}
	ran, denied, wrote := byThread["t1"], byThread["t2"], byThread["t3"]
	if ran.Title != "bash" || ran.Outcome != "ok" || !strings.Contains(ran.field("arguments.command").(string), "echo hello") ||
		ran.field("approval.status") != "approved" || ran.AgentName != "Worker" || ran.Actor != "Worker" || ran.DurationMs == nil {
		t.Fatalf("the approved command: %+v %s", ran, ran.Detail)
	}
	if denied.Title != "bash" || denied.Outcome != "denied" || denied.field("approval.status") != "denied" || !strings.Contains(denied.field("error").(string), "not today") || denied.DurationMs != nil {
		t.Fatalf("the denied command: %+v %s", denied, denied.Detail)
	}
	if wrote.Title != "write" || wrote.Outcome != "ok" || wrote.field("approval") != nil {
		t.Fatalf("a call that needed no approval: %+v %s", wrote, wrote.Detail)
	}
	if strings.Contains(string(wrote.Detail), "sk-proj-") {
		t.Fatalf("a credential in a tool call's arguments was kept: %s", wrote.Detail)
	}

	// Messages: who sent what to which agent and thread; only the first words, never a credential.
	messages := h.activityWith("agent="+agent+"&kind=message", 3)
	if len(messages) != 3 {
		t.Fatalf("messages: %d", len(messages))
	}
	var longMsg activityJSON
	for _, m := range messages {
		if m.thread() == "t3" {
			longMsg = m
		}
		if m.Title != "Message sent" || m.Outcome != "ok" || m.Actor == "" || m.AgentName != "Worker" || m.AgentID == nil || *m.AgentID != agent {
			t.Fatalf("a message: %+v", m)
		}
	}
	preview, _ := longMsg.field("preview").(string)
	if utf8.RuneCountInString(preview) != 120 || !strings.HasSuffix(preview, "…") || !strings.HasPrefix(preview, "WRITE:notes.md:a long note") || longMsg.field("chars").(float64) != float64(utf8.RuneCountInString(long)) {
		t.Fatalf("the preview: %q (%v)", preview, longMsg.field("chars"))
	}
	if strings.Contains(string(longMsg.Detail), "sk-proj-") || strings.Contains(string(longMsg.Detail), "and a key") {
		t.Fatalf("a message's detail holds more than its first words: %s", longMsg.Detail)
	}
	if secret := h.activityWith("agent="+agent+"&kind=message&thread=t1", 1)[0]; !strings.HasPrefix(secret.field("preview").(string), "RUN:echo hello") {
		t.Fatalf("a short message: %+v", secret)
	}

	// Approvals decided.
	decided := h.activityWith("agent="+agent+"&kind=approval", 2)
	titles := map[string]string{}
	for _, e := range decided {
		titles[e.Title] = e.Outcome
		if e.Actor == "" || e.DurationMs == nil {
			t.Fatalf("an approval: %+v", e)
		}
	}
	if titles["Approved bash"] != "ok" || titles["Denied bash"] != "denied" {
		t.Fatalf("approvals: %v", titles)
	}

	// Filters: a thread holds its own message, call and decision; another agent has nothing.
	var kinds []string
	for _, e := range h.activityWith("agent="+agent+"&thread=t2", 3) {
		if e.thread() != "t2" {
			t.Fatalf("thread filter: %+v", e)
		}
		kinds = append(kinds, e.Kind)
	}
	if len(kinds) != 3 {
		t.Fatalf("t2's activity: %v", kinds)
	}
	if got := h.activity("agent=" + other).Items; len(got) != 0 {
		t.Fatalf("another agent's activity: %+v", got)
	}
	if got := h.activity("agent=" + agent + "&outcome=denied&kind=tool,approval").Items; len(got) != 2 {
		t.Fatalf("outcome and kind lists: %+v", got)
	}
	if got := h.activity("agent=" + agent + "&q=rm+-rf").Items; len(got) < 2 {
		t.Fatalf("text search: %+v", got)
	}
	if got := h.activity("agent=" + agent + "&since=" + strconv.FormatInt(time.Now().Add(time.Minute).UnixMilli(), 10)).Items; len(got) != 0 {
		t.Fatalf("since: %+v", got)
	}

	// Pages: newest first, by cursor, with nothing twice and nothing missed.
	all := h.activity("agent=" + agent + "&limit=500").Items
	if all[0].At < all[len(all)-1].At {
		t.Fatalf("not newest first")
	}
	var paged []activityJSON
	before := ""
	for pages := 0; pages < 30; pages++ {
		page := h.activity("agent=" + agent + "&limit=4" + before)
		if len(page.Items) > 4 {
			t.Fatalf("a page of %d", len(page.Items))
		}
		paged = append(paged, page.Items...)
		if page.NextBefore == nil {
			break
		}
		before = "&before=" + url.QueryEscape(*page.NextBefore)
	}
	if len(paged) != len(all) {
		t.Fatalf("paging gave %d entries, the whole list %d", len(paged), len(all))
	}
	for i := range all {
		if paged[i].ID != all[i].ID {
			t.Fatalf("paging entry %d: %d, not %d", i, paged[i].ID, all[i].ID)
		}
	}

	// Bad filters are refused.
	for _, q := range []string{"kind=nonsense", "limit=0", "limit=9999", "since=yesterday", "before=soon"} {
		if code, data := h.do("GET", "/api/activity?"+q, nil); code != 400 {
			t.Fatalf("%s: %d %s", q, code, data)
		}
	}

	// The CSV export: the same filters, one row per entry, as a download.
	resp, err := http.Get(h.srv.URL + "/api/activity/export?agent=" + agent + "&kind=tool")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/csv") || !strings.Contains(resp.Header.Get("Content-Disposition"), `attachment; filename="pi-local-activity-`) {
		t.Fatalf("export: %d %v", resp.StatusCode, resp.Header)
	}
	rows, err := csv.NewReader(strings.NewReader(string(raw))).ReadAll()
	if err != nil {
		t.Fatalf("export is not CSV: %v\n%s", err, raw)
	}
	if strings.Join(rows[0], ",") != "time,kind,agent,agent_id,thread_id,actor,title,outcome,duration_ms,detail" || len(rows) != 4 {
		t.Fatalf("export rows: %d %v", len(rows), rows[0])
	}
	for _, row := range rows[1:] {
		if row[1] != "tool" || row[2] != "Worker" || row[3] != agent {
			t.Fatalf("an export row: %v", row)
		}
	}
	if strings.Contains(string(raw), "sk-proj-") {
		t.Fatalf("the export holds a credential")
	}

	// The desktop app saves through a dialog; a browser, which has none, is told to download.
	if code, data := h.do("POST", "/api/activity/export?agent="+agent, nil); code != 501 || !strings.Contains(string(data), "not_supported") {
		t.Fatalf("saving without a dialog: %d %s", code, data)
	}
	dir := t.TempDir()
	h.app.API.SaveDialog = func(name string) (string, error) { return filepath.Join(dir, name), nil }
	saved := decodeInto[struct{ Path string }](t, h.mustDo("POST", "/api/activity/export?agent="+agent+"&kind=message", nil, 200))
	file, err := os.ReadFile(saved.Path)
	if err != nil || !strings.HasPrefix(filepath.Base(saved.Path), "pi-local-activity-") || strings.Count(string(file), "\n") != 4 {
		t.Fatalf("saved file: %v %q", err, file)
	}
	h.app.API.SaveDialog = func(string) (string, error) { return "", nil }
	if got := decodeInto[struct{ Cancelled bool }](t, h.mustDo("POST", "/api/activity/export", nil, 200)); !got.Cancelled {
		t.Fatalf("a cancelled dialog: %+v", got)
	}
}

func TestTheActivityLogRecordsSchedulesAsksBudgetsErrorsAndSignIns(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	scripted(t, h)
	h.priceScripted(1, 1)
	lead := h.agentOn("Lead", "script/s1", nil)
	member := h.agentOn("Helper", "script/s1", map[string]any{"budget": map[string]any{"monthlyUsd": 5}})
	h.mustDo("POST", "/api/teams", map[string]any{"name": "Crew", "leadId": lead, "memberIds": []string{member}}, 201)

	// A schedule's run, from "Run now".
	s := decodeInto[scheduleJSON](t, h.mustDo("POST", "/api/agents/"+lead+"/schedules", map[string]any{"name": "Digest", "cron": "@daily", "message": "Digest please"}, 201))
	h.mustDo("POST", "/api/schedules/"+s.ID+"/run", nil, 200)
	runs := h.activityWith("agent="+lead+"&kind=schedule", 1)
	if r := runs[0]; r.Title != "Schedule ran: Digest" || r.Outcome != "ok" || r.Actor != "Schedule: Digest" || r.thread() == "" || r.DurationMs == nil || r.field("scheduleId") != s.ID {
		t.Fatalf("a schedule run: %+v %s", r, r.Detail)
	}

	// An ask between agents: recorded under the asking agent and its conversation.
	h.sendAndWait(lead, "t1", "ASK:Helper:What do you know?", "r1")
	asked := h.activityWith("agent="+lead+"&kind=ask", 1)
	if a := asked[0]; a.Title != "Asked Helper" || a.Outcome != "ok" || a.thread() != "t1" || a.field("targetAgentId") != member || a.field("preview") != "What do you know?" || a.DurationMs == nil {
		t.Fatalf("an ask: %+v %s", a, a.Detail)
	}

	// A budget refusal: of a message, and of an ask.
	h.spend(member, 6)
	h.sendAndWait(lead, "t1", "ASK:Helper:And now?", "r2")
	code, _, message := overBudget(t, h, member, "t9")
	if code != 402 {
		t.Fatalf("over budget: %d", code)
	}
	refusals := h.activityWith("agent="+member+"&kind=budget", 2)
	vias := map[any]bool{}
	for _, r := range refusals {
		vias[r.field("via")] = true
		if r.Outcome != "refused" || r.Title != message || r.Actor != "Pi Local" {
			t.Fatalf("a budget refusal: %+v (%q)", r, message)
		}
	}
	if !vias["message"] || !vias["ask"] {
		t.Fatalf("refusals: %v", vias)
	}

	// A reply that fails: the provider answers with an error.
	broken := newFakeProvider(t, "openai", "")
	broken.status = 500
	h.mustDo("POST", "/api/providers", map[string]any{"id": "broken", "name": "Broken", "kind": "openai-compatible", "baseUrl": broken.URL + "/v1"}, 201)
	h.mustDo("PUT", "/api/providers/broken/models/b1", map[string]any{"name": "Broken"}, 200)
	failing := h.agentOn("Failing", "broken/b1", nil)
	h.mustDo("POST", "/api/agents/"+failing+"/threads/f1/messages", map[string]string{"text": "hello", "requestId": "rf"}, 202)
	errs := h.activityWith("agent="+failing+"&kind=error", 1)
	if e := errs[0]; e.Title != "A reply failed" || e.Outcome != "error" || e.thread() != "f1" || e.field("error") == "" {
		t.Fatalf("a failed reply: %+v %s", e, e.Detail)
	}
	// Reporting the same failure again (every report of the thread) adds nothing.
	time.Sleep(300 * time.Millisecond)
	if got := h.activity("agent=" + failing + "&kind=error").Items; len(got) != 1 {
		t.Fatalf("a failure was recorded %d times", len(got))
	}

	// MCP sign-ins: a local server's sign-in command succeeding and failing, and signing out.
	node, _ := exec.LookPath("node")
	h.mustDo("POST", "/api/mcp/servers", map[string]any{
		"name": "Fixture", "transport": "stdio", "command": node, "args": []string{fixture("stdio-mcp-server.mjs")},
		"loginArgs": []string{"-e", `setTimeout(() => process.exit(0), 100)`},
	}, 201)
	h.mustDo("POST", "/api/mcp/servers/fixture/login", nil, 202)
	signIns := h.activityWith("kind=sign_in", 1)
	if e := signIns[0]; e.Title != "Signed in to Fixture" || e.Outcome != "ok" || e.AgentID != nil || e.field("server") != "fixture" || e.Actor == "" {
		t.Fatalf("a sign-in: %+v %s", e, e.Detail)
	}
	h.mustDo("PATCH", "/api/mcp/servers/fixture", map[string]any{"loginArgs": []string{"-e", `console.error("AADSTS65001 consent needed"); process.exit(3)`}}, 200)
	h.mustDo("POST", "/api/mcp/servers/fixture/login", nil, 202)
	if got := h.activityWith("kind=sign_in&outcome=error", 1)[0]; got.Title != "Signing in to Fixture failed" || !strings.Contains(got.field("error").(string), "code 3") {
		t.Fatalf("a failed sign-in: %+v %s", got, got.Detail)
	}
}

func TestTheActivityLogKeepsNinetyDaysAndSurvivesItsAgent(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	agent := h.createAgent("Short-lived")
	h.sendAndWait(agent, "t1", "hello", "r1")
	h.activityWith("agent="+agent, 1)
	old := time.Now().Add(-91 * 24 * time.Hour).UnixMilli()
	if _, err := h.app.DB.Exec(`INSERT INTO activity (at, kind, title) VALUES (?, 'message', 'Too old'), (?, 'message', 'Just inside')`, old, time.Now().Add(-89*24*time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if n, err := h.app.Activity.Prune(t.Context()); err != nil || n != 1 {
		t.Fatalf("pruned %d: %v", n, err)
	}
	titles := map[string]bool{}
	for _, e := range h.activity("limit=500").Items {
		titles[e.Title] = true
	}
	if titles["Too old"] || !titles["Just inside"] {
		t.Fatalf("after pruning: %v", titles)
	}

	// An agent that is deleted leaves its history, under the name it had.
	h.mustDo("DELETE", "/api/agents/"+agent, nil, 200)
	left := h.activity("agent=" + agent).Items
	if len(left) == 0 || left[0].AgentName != "Short-lived" {
		t.Fatalf("after deleting the agent: %+v", left)
	}
}
