package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/gateway"
	"github.com/ncecere/pi-local/internal/memory"
	"github.com/ncecere/pi-local/internal/threads"
)

type suggestedFact struct {
	ID           string `json:"id"`
	Category     string `json:"category"`
	Text         string `json:"text"`
	Trust        string `json:"trust"`
	Status       string `json:"status"`
	SourceAgent  string `json:"sourceAgent"`
	SourceThread string `json:"sourceThread"`
	History      []struct {
		Text     string `json:"text"`
		Category string `json:"category"`
		At       int64  `json:"at"`
	} `json:"history"`
}

func suggestedFacts(t *testing.T, h *harness) []suggestedFact {
	t.Helper()
	return decodeInto[[]suggestedFact](t, h.mustDo("GET", "/api/you/memories?status=suggested", nil, 200))
}

const idleForTests = 1200 * time.Millisecond

func startSuggesting(t *testing.T) (*harness, *fakeProvider) {
	t.Helper()
	h := start(t, t.TempDir(), Config{MemoryIdle: idleForTests})
	fake := newFakeProvider(t, "openai", "Noted.")
	h.mustDo("POST", "/api/providers", map[string]any{"id": "script", "name": "Script", "kind": "openai-compatible", "baseUrl": fake.URL + "/v1"}, 201)
	h.mustDo("PUT", "/api/providers/script/models/s1", map[string]any{"name": "Scripted"}, 200)
	return h, fake
}

func TestSuggestionsAtTheEndOfAConversation(t *testing.T) {
	h, fake := startSuggesting(t)
	agent := h.agentOn("Helper", "script/s1", nil)
	fake.setExtract(`{"facts":[{"text":"Is vegetarian","category":"preferences"},{"text":"Works as a nurse","category":"work"},{"text":"Has a dog named Rex","category":"family"}]}`)

	// Off until the person turns it on: the page says so, and an idle conversation is never read.
	you := decodeInto[struct {
		Suggestions struct{ Enabled, Judged bool }
	}](t, h.mustDo("GET", "/api/you", nil, 200))
	if you.Suggestions.Enabled || you.Suggestions.Judged {
		t.Fatalf("suggestions are on by default: %+v", you)
	}
	h.sendAndWait(agent, "t1", "I'm a vegetarian and a nurse", "r1")
	time.Sleep(idleForTests + 1500*time.Millisecond)
	if n := len(fake.extractions()); n != 0 || len(suggestedFacts(t, h)) != 0 {
		t.Fatalf("with the switch off, %d extractions, %+v", n, suggestedFacts(t, h))
	}

	// On: one system-wide switch.
	h.mustDo("PUT", "/api/you/settings", map[string]any{"suggestions": true}, 200)
	if got := decodeInto[map[string]bool](t, h.mustDo("PUT", "/api/you/settings", map[string]any{}, 200)); !got["enabled"] {
		t.Fatalf("settings: %v", got)
	}
	h.sendAndWait(agent, "t1", "Also, my dog Rex needs a walk at noon", "r2")
	var got []suggestedFact
	eventually(t, 30*time.Second, "the suggestions", func() bool {
		got = suggestedFacts(t, h)
		return len(got) > 0
	})
	// At most three; each is the agent's inference from this conversation.
	if len(got) != 3 {
		t.Fatalf("suggestions: %+v", got)
	}
	for _, f := range got {
		if f.Trust != "inferred" || f.Status != "suggested" || f.SourceAgent != agent || f.SourceThread != "t1" {
			t.Errorf("a suggestion: %+v", f)
		}
	}
	// The request was one small call to the agent's own model: strict prompt, the person's words, nothing else.
	asked := fake.extractions()
	if len(asked) != 1 {
		t.Fatalf("%d extraction requests", len(asked))
	}
	var extractionRequest struct {
		Tools []any `json:"tools"`
	}
	if json.Unmarshal([]byte(asked[0]), &extractionRequest) != nil || len(extractionRequest.Tools) != 0 {
		t.Fatal("extraction exposed tools")
	}
	for _, want := range []string{"JSON only", "I'm a vegetarian and a nurse", "my dog Rex needs a walk"} {
		if !strings.Contains(asked[0], want) {
			t.Errorf("the request lacks %q", want)
		}
	}
	// A conversation is read once per reply, and only its new part: a third message is a new wait with only itself.
	fake.setExtract(`{"facts":[]}`)
	h.sendAndWait(agent, "t1", "One more thing: the printer is on the second floor", "r4")
	eventually(t, 30*time.Second, "the second extraction", func() bool { return len(fake.extractions()) == 2 })
	second := fake.extractions()[1]
	if !strings.Contains(second, "the printer is on the second floor") || strings.Contains(second, "I'm a vegetarian") {
		t.Errorf("the second look should read only what came after the first: %s", second)
	}
	time.Sleep(idleForTests + 800*time.Millisecond)
	if n := len(fake.extractions()); n != 2 {
		t.Errorf("a quiet conversation was read again: %d requests", n)
	}

	// A suggestion isn't known: no agent sees it until the person accepts.
	h.sendAndWait(agent, "t2", "hello", "r3")
	chats := fake.chats()
	if last := string(chats[len(chats)-1].Body); strings.Contains(last, "Works as a nurse") || strings.Contains(last, "Is vegetarian") {
		t.Fatal("an unaccepted suggestion reached an agent's prompt")
	}
}

func TestSuggestionsNeverFromSchedulesOrOtherAgentsOrAgentsWithoutMemory(t *testing.T) {
	h, fake := startSuggesting(t)
	h.mustDo("PUT", "/api/you/settings", map[string]any{"suggestions": true}, 200)
	fake.setExtract(`{"facts":[{"text":"Is left-handed","category":"preferences"}]}`)
	agent := h.agentOn("Helper", "script/s1", nil)
	forgetful := h.agentOn("Forgetful", "script/s1", map[string]any{"memory": map[string]any{"off": true}})

	// A schedule's conversation: its message isn't the person's.
	at := time.Now().Add(1 * time.Second).UTC().Format(time.RFC3339)
	h.mustDo("POST", "/api/agents/"+agent+"/schedules", map[string]any{"name": "Nightly", "at": at, "message": "I am left-handed, run the nightly report"}, 201)
	eventually(t, 30*time.Second, "the scheduled run", func() bool {
		for _, th := range h.threads(agent) {
			if strings.HasPrefix(th.ThreadID, "sched-") && !th.Busy && th.LastReplyAt != nil {
				return true
			}
		}
		return false
	})
	// An agent with memory off.
	h.sendAndWait(forgetful, "t1", "I like jazz", "r1")
	// The person's own conversation, as the control: it is read.
	h.sendAndWait(agent, "t1", "I like opera", "r2")
	eventually(t, 30*time.Second, "the person's conversation to be read", func() bool { return len(fake.extractions()) >= 1 })
	time.Sleep(idleForTests + 800*time.Millisecond)
	asked := fake.extractions()
	if len(asked) != 1 || !strings.Contains(asked[0], "I like opera") || strings.Contains(asked[0], "left-handed") || strings.Contains(asked[0], "jazz") {
		t.Fatalf("only the person's own conversation with an agent that has memory is read: %d %v", len(asked), asked)
	}

	// The guard itself, for every way in (the idle timer and the compaction hook both ask it).
	ctx := context.Background()
	var sched string
	for _, th := range h.threads(agent) {
		if strings.HasPrefix(th.ThreadID, "sched-") {
			sched = th.ThreadID
		}
	}
	if h.app.suggestable(ctx, agent, sched) {
		t.Error("a schedule's conversation can be read")
	}
	if _, err := h.app.Threads.Sending(ctx, agent, "asked", "Can you check this?", &threads.CalledBy{AgentID: forgetful, ThreadID: "x"}); err != nil {
		t.Fatal(err)
	}
	h.app.Threads.Sent(agent, "asked")
	if h.app.suggestable(ctx, agent, "asked") {
		t.Error("a conversation another agent asked in can be read")
	}
	if !h.app.suggestable(ctx, agent, "t1") || h.app.suggestable(ctx, forgetful, "t1") {
		t.Error("the person's conversation should be readable only by an agent with memory")
	}
	// Facts reported before a compaction obey the same guard, and the switch.
	g := memoryGateway{h.app}
	in := gateway.SuggestInput{Trigger: "compaction", ThreadID: sched}
	in.Facts = append(in.Facts, struct {
		Text     string `json:"text"`
		Category string `json:"category"`
	}{"Likes cold showers", "preferences"})
	if res, err := g.Suggest(ctx, agent, in); err != nil || res["saved"] != 0 {
		t.Fatalf("a schedule's conversation: %v %v", res, err)
	}
	in.ThreadID = "t1"
	if res, err := g.Suggest(ctx, agent, in); err != nil || res["saved"] != 1 {
		t.Fatalf("before a compaction: %v %v", res, err)
	}
	h.mustDo("PUT", "/api/you/settings", map[string]any{"suggestions": false}, 200)
	in.Facts[0].Text = "Likes warm showers"
	if res, _ := g.Suggest(ctx, agent, in); res["saved"] != 0 {
		t.Fatalf("with the switch off: %v", res)
	}
	if _, err := g.Suggest(ctx, forgetful, in); err == nil {
		t.Fatal("an agent with memory off may suggest")
	}
	var shower int
	for _, f := range suggestedFacts(t, h) {
		if strings.Contains(f.Text, "showers") {
			shower++
			if f.SourceThread != "t1" || f.Trust != "inferred" {
				t.Errorf("a compaction suggestion: %+v", f)
			}
		}
	}
	if shower != 1 {
		t.Errorf("suggestions about showers: %d", shower)
	}
}

func TestSuggestionsAreJudgedWhenFastJudgmentsAreOn(t *testing.T) {
	h, fake := startSuggesting(t)
	agent := h.agentOn("Helper", "script/s1", nil)
	fake.setExtract(`{"facts":[{"text":"Prefers metric units","category":"preferences"},{"text":"Needs the report by 5pm today","category":"work"}]}`)
	system := fakeMemoryJudge(t)
	h.mustDo("PUT", "/api/settings/judgments", map[string]any{"enabled": true, "url": system.URL, "apiKey": "ts-key", "uses": map[string]bool{"memory": true}}, 200)
	h.mustDo("PUT", "/api/you/settings", map[string]any{"suggestions": true}, 200)
	if got := decodeInto[struct{ Suggestions struct{ Judged bool } }](t, h.mustDo("GET", "/api/you", nil, 200)); !got.Suggestions.Judged {
		t.Fatal("the page doesn't say suggestions are judged")
	}
	h.sendAndWait(agent, "t1", "I like metric units, and I need the report by 5pm today", "r1")
	eventually(t, 30*time.Second, "the judged suggestions", func() bool { return len(suggestedFacts(t, h)) > 0 })
	time.Sleep(300 * time.Millisecond)
	got := suggestedFacts(t, h)
	if len(got) != 1 || got[0].Text != "Prefers metric units" {
		t.Fatalf("the one-off should have been dropped: %+v", got)
	}

	// Auxiliary judgments are visible in usage, explicitly unpriced (there is no System One price table).
	raw := string(h.mustDo("GET", "/api/me/usage?model=judgments/"+h.app.Judge.Settings().Model, nil, 200))
	if !strings.Contains(raw, `"unpricedRequests":1`) || !strings.Contains(raw, `"inputTokens":120`) || !strings.Contains(raw, `"outputTokens":12`) {
		t.Fatalf("judgment request not accounted: %s", raw)
	}
	// A service that can't be reached is no judgment: they stay suggestions for the person to decide.
	system.Close()
	fake.setExtract(`{"facts":[{"text":"Speaks Portuguese","category":"preferences"}]}`)
	h.sendAndWait(agent, "t1", "Eu falo português", "r2")
	eventually(t, 30*time.Second, "the unjudged suggestion", func() bool { return len(suggestedFacts(t, h)) == 2 })
}

// fakeMemoryJudge answers the memory question: statements about a deadline today are one-offs.
func fakeMemoryJudge(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req judgeRequest
		json.NewDecoder(r.Body).Decode(&req)
		answers := map[string]any{}
		for name := range req.Questions {
			idx := strings.TrimPrefix(name, "f")
			fact := ""
			if v, ok := req.State["fact"+idx].(string); ok {
				fact = v
			}
			p := 0.95
			if strings.Contains(fact, "today") {
				p = 0.1
			}
			answers[name] = map[string]any{"type": "noul", "noul": p}
		}
		json.NewEncoder(w).Encode(map[string]any{"model": req.Model, "answers": answers, "usage": map[string]int{"input_tokens": 120, "output_tokens": 12}})
	}))
	t.Cleanup(srv.Close)
	return srv
}

type judgeRequest struct {
	Model     string                    `json:"model"`
	State     map[string]any            `json:"state"`
	Questions map[string]map[string]any `json:"questions"`
}

func TestFactHistoryAndTrust(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	created := decodeInto[suggestedFact](t, h.mustDo("POST", "/api/you/memories", map[string]any{"category": "work", "text": "Works at Acme"}, 201))
	if created.Trust != "said" || len(created.History) != 0 {
		t.Fatalf("created: %+v", created)
	}
	// A pin changes nothing it said.
	h.mustDo("PATCH", "/api/you/memories/"+created.ID, map[string]any{"pinned": true}, 200)
	// Its words and its category are what history keeps.
	h.mustDo("PATCH", "/api/you/memories/"+created.ID, map[string]any{"text": "Works at Initech"}, 200)
	changed := decodeInto[suggestedFact](t, h.mustDo("PATCH", "/api/you/memories/"+created.ID, map[string]any{"category": "projects"}, 200))
	if len(changed.History) != 2 || changed.History[0].Text != "Works at Initech" || changed.History[0].Category != "work" || changed.History[1].Text != "Works at Acme" {
		t.Fatalf("history (newest first): %+v", changed.History)
	}
	if changed.History[0].At == 0 || changed.History[0].At < changed.History[1].At {
		t.Errorf("history times: %+v", changed.History)
	}
	// The same history in the list and the export; the same text again adds none.
	h.mustDo("PATCH", "/api/you/memories/"+created.ID, map[string]any{"text": "Works at Initech"}, 200)
	listed := decodeInto[[]suggestedFact](t, h.mustDo("GET", "/api/you/memories", nil, 200))
	if len(listed) != 1 || len(listed[0].History) != 2 {
		t.Fatalf("list: %+v", listed)
	}
	if !strings.Contains(string(h.mustDo("GET", "/api/you/export", nil, 200)), "Works at Acme") {
		t.Error("the export has no history")
	}
	// Accepting a suggestion isn't an edit; editing it before accepting is.
	sug, err := h.app.Memory.AddFact(context.Background(), memoryInput("inferred", "Likes tea"))
	if err != nil {
		t.Fatal(err)
	}
	accepted := decodeInto[suggestedFact](t, h.mustDo("PATCH", "/api/you/memories/"+sug.ID, map[string]any{"accept": true}, 200))
	if accepted.Status != "active" || accepted.Trust != "inferred" || len(accepted.History) != 0 {
		t.Fatalf("accepted: %+v", accepted)
	}
	// Deleting forgets the history too; erasing forgets everything.
	h.mustDo("DELETE", "/api/you/memories/"+created.ID, nil, 200)
	var rows int
	h.app.DB.QueryRow(`SELECT COUNT(*) FROM user_memory_history`).Scan(&rows)
	if rows != 0 {
		t.Fatalf("history rows left after a delete: %d", rows)
	}
}

func TestSearchConversationsIsOwnConversationsOnly(t *testing.T) {
	h, _ := startSuggesting(t)
	mine := h.agentOn("Mine", "script/s1", nil)
	other := h.agentOn("Other", "script/s1", nil)
	h.sendAndWait(mine, "trip", "We should plan the Lisbon trip for May", "r1")
	h.sendAndWait(other, "secret", "The Lisbon acquisition is confidential", "r1")
	// Messages are indexed after each reply, once the agent has answered.
	eventually(t, 15*time.Second, "both conversations to be searchable", func() bool {
		a, _ := h.app.Search.SearchAgent(context.Background(), mine, "lisbon", 5)
		b, _ := h.app.Search.SearchAgent(context.Background(), other, "lisbon", 5)
		return len(a) == 1 && len(b) == 1
	})
	reply := lastReply(h.sendAndWait(mine, "ask", `CALL:search_conversations:{"query":"lisbon"}`, "r2"))
	if !strings.Contains(reply, "Lisbon trip for May") || !strings.Contains(reply, "thread trip") {
		t.Fatalf("the tool's answer: %q", reply)
	}
	if strings.Contains(reply, "acquisition") || strings.Contains(reply, "confidential") || strings.Contains(reply, "secret") {
		t.Fatalf("another agent's conversation leaked: %q", reply)
	}
	// Titles and dates come with it.
	if !strings.Contains(reply, "We should plan the Lisbon trip for May") || !strings.Contains(reply, time.Now().UTC().Format("2006-01-02")) {
		t.Errorf("no title or date: %q", reply)
	}
	// An agent with memory off has no such tool, and the app refuses it too.
	forgetful := h.agentOn("Forgetful", "script/s1", map[string]any{"memory": map[string]any{"off": true}})
	if _, err := (memoryGateway{h.app}).SearchConversations(context.Background(), forgetful, "lisbon", 5); err == nil {
		t.Fatal("an agent with memory off can search")
	}
	res, err := (memoryGateway{h.app}).SearchConversations(context.Background(), mine, "nothing-like-this", 5)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(res)
	if string(raw) != `{"results":[]}` {
		t.Errorf("no match: %s", raw)
	}
}

func TestExtractionFailureDuplicateAndBudgetAccounting(t *testing.T) {
	h, fake := startSuggesting(t)
	h.priceScripted(1, 1)
	agent := h.agentOn("Helper", "script/s1", map[string]any{"budget": map[string]any{"monthlyUsd": 20}})
	h.sendAndWait(agent, "t1", "I prefer metric units", "r1")
	h.sendAndWait(agent, "empty", "Hi", "r2")
	ctx := context.Background()
	thread, err := h.app.Threads.Get(ctx, agent, "t1")
	if err != nil || thread.LastReplyAt == nil {
		t.Fatalf("thread: %+v %v", thread, err)
	}
	h.mustDo("PUT", "/api/you/settings", map[string]any{"suggestions": true}, 200)
	// Invalid JSON is a failed extraction, not a successful empty one: do not move the cursor.
	fake.setExtract(`{"facts":[{"text":"Prefers metric units","category":"work","tool":"bash"}]}`)
	h.app.suggestFromIdle(agent, "t1", *thread.LastReplyAt)
	if got := h.app.Memory.Extracted(ctx, agent, "t1"); got.ReplyAt != 0 || len(suggestedFacts(t, h)) != 0 {
		t.Fatalf("failed extraction advanced or saved: %+v", got)
	}
	fake.setExtract(`{"facts":[{"text":"Prefers metric units","category":"preferences"}]}`)
	h.app.suggestFromIdle(agent, "t1", *thread.LastReplyAt)
	h.app.suggestFromIdle(agent, "t1", *thread.LastReplyAt)
	if len(fake.extractions()) != 2 || len(suggestedFacts(t, h)) != 1 {
		t.Fatalf("duplicate extraction: requests=%d facts=%+v", len(fake.extractions()), suggestedFacts(t, h))
	}
	// The same fact reported by compaction is not another fact, or counted as newly saved.
	candidates := []memory.Candidate{{Text: "Prefers metric units", Category: "preferences"}}
	if n := h.app.saveSuggestions(ctx, agent, "t1", candidates); n != 0 {
		t.Fatalf("duplicate fact counted as new: %d", n)
	}
	fake.setExtract(`{"facts":[]}`)
	empty, _ := h.app.Threads.Get(ctx, agent, "empty")
	h.app.suggestFromIdle(agent, "empty", *empty.LastReplyAt)
	if got := h.app.Memory.Extracted(ctx, agent, "empty"); got.ReplyAt == 0 || got.Messages != 2 {
		t.Fatalf("successful empty extraction did not advance: %+v", got)
	}
	// Every auxiliary model call, including malformed responses, uses the existing usage-counting provider.
	eventually(t, 15*time.Second, "extraction usage", func() bool {
		r := decodeInto[struct {
			Total struct {
				Requests int
				CostUSD  float64
			}
		}](t, h.mustDo("GET", "/api/me/usage?agent="+agent, nil, 200))
		return r.Total.Requests == 5 && r.Total.CostUSD > 0 // two replies and three extraction attempts
	})
	// Both extraction triggers consult the same budget guard before asking a model.
	h.spend(agent, 21)
	g := memoryGateway{h.app}
	if g.ExtractionAllowed(ctx, agent, "t1") {
		t.Fatal("compaction extraction allowed over budget")
	}
	n := len(fake.extractions())
	h.app.Memory.ForgetThread(ctx, agent, "t1")
	h.app.suggestFromIdle(agent, "t1", *thread.LastReplyAt)
	if len(fake.extractions()) != n {
		t.Fatal("idle extraction called the model over budget")
	}
}

func TestCloseCancelsIdleMemoryExtraction(t *testing.T) {
	h, fake := startSuggesting(t)
	started, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	// A provider that answers normal replies, but stalls the auxiliary request until cancelled. All data and
	// credentials belong to this harness; nothing reaches a real model or the shared fake services.
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if strings.Contains(string(raw), "at most 3 durable facts") {
			close(started)
			select {
			case <-r.Context().Done():
				close(cancelled)
			case <-release:
				http.Error(w, "test released", http.StatusBadGateway)
			}
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		fake.serve(w, r)
	}))
	t.Cleanup(provider.Close)
	t.Cleanup(unblock)
	h.mustDo("PATCH", "/api/providers/script", map[string]any{"baseUrl": provider.URL + "/v1"}, 200)
	h.mustDo("PUT", "/api/you/settings", map[string]any{"suggestions": true}, 200)
	agent := h.agentOn("Helper", "script/s1", nil)
	h.sendAndWait(agent, "t1", "I prefer brief answers", "r1")
	select {
	case <-started:
	case <-time.After(20 * time.Second):
		t.Fatal("idle extraction never reached the stalled provider")
	}

	// Exercise the real App.Close, not just a helper cancellation. Without the closeIdle cancellation this
	// waits for the Background-based three-minute extraction deadline.
	a := h.app
	h.app = nil // the test closes it; harness cleanup still closes its HTTP server
	closed := make(chan struct{})
	closingAt := time.Now()
	go func() { a.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		unblock() // make a regression fail promptly instead of holding the test process for three minutes
		select {
		case <-closed:
		case <-time.After(15 * time.Second):
		}
		t.Fatal("App.Close did not promptly cancel idle extraction")
	}
	t.Logf("App.Close cancelled idle extraction in %s", time.Since(closingAt))
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("cancelling extraction did not reach the model provider")
	}
	// A timer racing with shutdown cannot start more work (or add to a WaitGroup after Close waited).
	a.suggestFromIdle(agent, "t1", time.Now().UnixMilli())
}

func memoryInput(trust, text string) memory.FactInput {
	return memory.FactInput{Category: "preferences", Text: text, Trust: trust}
}
