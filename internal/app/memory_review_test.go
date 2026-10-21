package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/gateway"
	"github.com/ncecere/pi-local/internal/memory"
)

func TestConcurrentFactEditHistoryChain(t *testing.T) {
	h := start(t, t.TempDir(), Config{}) // synthetic app.db and secrets.NewMemory
	ctx := context.Background()
	f, err := h.app.Memory.AddFact(ctx, memory.FactInput{Text: "Version zero", Category: "work", Trust: "said", Active: true})
	if err != nil {
		t.Fatal(err)
	}
	const n = 16
	ready := make(chan struct{})
	errs := make(chan error, n)
	var wg sync.WaitGroup
	for i := 1; i <= n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-ready
			text := fmt.Sprintf("Version %d", i)
			_, err := h.app.Memory.UpdateFact(ctx, f.ID, memory.FactChange{Text: &text})
			errs <- err
		}(i)
	}
	close(ready)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	got, err := h.app.Memory.Fact(ctx, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{got.Text: true}
	if len(got.History) != n {
		t.Fatalf("history: %+v", got.History)
	}
	for _, r := range got.History {
		if seen[r.Text] {
			t.Fatalf("lost intermediate edit; duplicate %q: %+v", r.Text, got)
		}
		seen[r.Text] = true
	}
	if len(seen) != n+1 || !seen["Version zero"] {
		t.Fatalf("chain: %+v", got)
	}
	// Index follows the final text, and deleting also removes history/index atomically.
	var indexed string
	if err := h.app.DB.QueryRow(`SELECT text FROM user_memory_index WHERE id = ?`, f.ID).Scan(&indexed); err != nil || indexed != got.Text {
		t.Fatalf("index %q: %v", indexed, err)
	}
	if err := h.app.Memory.DeleteFact(ctx, f.ID); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"user_memory_history", "user_memory_index"} {
		var count int
		if err := h.app.DB.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s: %d %v", table, count, err)
		}
	}
	// Updates racing deletion cannot leave a ghost search hit or history row.
	for i := 0; i < 8; i++ {
		f, err := h.app.Memory.AddFact(ctx, memory.FactInput{Text: "Disposable", Category: "work", Trust: "said", Active: true})
		if err != nil {
			t.Fatal(err)
		}
		goEdit := make(chan struct{})
		edited := make(chan error, 1)
		go func() {
			<-goEdit
			text := "Edited disposable"
			_, err := h.app.Memory.UpdateFact(ctx, f.ID, memory.FactChange{Text: &text})
			edited <- err
		}()
		close(goEdit)
		if err := h.app.Memory.DeleteFact(ctx, f.ID); err != nil {
			t.Fatal(err)
		}
		if err := <-edited; err != nil && err != memory.ErrNotFound {
			t.Fatal(err)
		}
		for _, table := range []string{"user_memories", "user_memory_history", "user_memory_index"} {
			var count int
			if err := h.app.DB.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
				t.Fatalf("orphan in %s: %d %v", table, count, err)
			}
		}
	}
}

func TestSuggestionEligibilityAfterBlockedJudgment(t *testing.T) {
	for _, change := range []string{"global off", "agent memory off", "delete conversation"} {
		t.Run(change, func(t *testing.T) {
			h, _ := startSuggesting(t)
			h.app.cfg.MemoryIdle = time.Hour
			agent := h.agentOn("Helper", "script/s1", nil)
			h.sendAndWait(agent, "t1", "I prefer tea", "r1")
			started, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			judge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req judgeRequest
				json.NewDecoder(r.Body).Decode(&req)
				close(started)
				<-release
				answers := map[string]any{}
				for key := range req.Questions {
					answers[key] = map[string]any{"type": "noul", "noul": 0.99}
				}
				json.NewEncoder(w).Encode(map[string]any{"model": req.Model, "answers": answers})
			}))
			t.Cleanup(judge.Close)
			t.Cleanup(unblock)
			h.mustDo("PUT", "/api/settings/judgments", map[string]any{"enabled": true, "url": judge.URL, "apiKey": "synthetic", "uses": map[string]bool{"memory": true}}, 200)
			h.mustDo("PUT", "/api/you/settings", map[string]any{"suggestions": true}, 200)
			done := make(chan int, 1)
			go func() {
				done <- h.app.saveSuggestions(context.Background(), agent, "t1", []memory.Candidate{{Text: "Prefers tea", Category: "preferences"}})
			}()
			select {
			case <-started:
			case <-time.After(10 * time.Second):
				t.Fatal("judge not reached")
			}
			switch change {
			case "global off":
				h.mustDo("PUT", "/api/you/settings", map[string]any{"suggestions": false}, 200)
			case "agent memory off":
				h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"memory": map[string]any{"off": true}}, 200)
			case "delete conversation":
				h.mustDo("DELETE", "/api/agents/"+agent+"/threads/t1", nil, 200)
			}
			unblock()
			select {
			case n := <-done:
				if n != 0 {
					t.Fatalf("saved %d after %s", n, change)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("save stuck")
			}
			facts, err := h.app.Memory.Facts(context.Background(), "")
			if err != nil || len(facts) != 0 {
				t.Fatalf("facts saved after %s: %+v %v", change, facts, err)
			}
		})
	}
}

func TestSharedExtractionCursorClaimsAndRetry(t *testing.T) {
	h, fake := startSuggesting(t)
	h.app.cfg.MemoryIdle = time.Hour
	agent := h.agentOn("Helper", "script/s1", nil)
	h.sendAndWait(agent, "t1", "I prefer metric units", "r1")
	h.mustDo("PUT", "/api/you/settings", map[string]any{"suggestions": true}, 200)
	ctx := context.Background()
	g := memoryGateway{h.app}
	thread, _ := h.app.Threads.Get(ctx, agent, "t1")
	// Idle -> compaction: same persisted cursor, even an empty extraction is checkpointed.
	fake.setExtract(`{"facts":[]}`)
	h.app.suggestFromIdle(agent, "t1", *thread.LastReplyAt)
	idle := h.app.Memory.Extracted(ctx, agent, "t1")
	if idle.Cursor == "" {
		t.Fatal("idle did not persist its empty extraction")
	}
	begin, err := g.Suggest(ctx, agent, gateway.SuggestInput{ThreadID: "t1", Trigger: "begin"})
	if err != nil || begin["since"] != idle.Cursor || begin["enabled"] != true {
		t.Fatalf("begin: %v %v", begin, err)
	}
	claim := begin["claim"].(string)
	// A competing compaction and idle attempt must both be excluded while this claim is held.
	other, err := g.Suggest(ctx, agent, gateway.SuggestInput{ThreadID: "t1", Trigger: "begin"})
	if err != nil || other["enabled"] != false {
		t.Fatalf("overlap admitted: %v %v", other, err)
	}
	before := len(fake.extractions())
	h.app.suggestFromIdle(agent, "t1", *thread.LastReplyAt)
	if len(fake.extractions()) != before {
		t.Fatal("idle overlapped compaction")
	}
	// Invalid result releases the claim and does not advance the watermark: retry retains the source.
	_, err = g.Suggest(ctx, agent, gateway.SuggestInput{ThreadID: "t1", Trigger: "compaction", Claim: claim, Cursor: "invalid"})
	if err == nil {
		t.Fatal("invalid cursor accepted")
	}
	if got := h.app.Memory.Extracted(ctx, agent, "t1"); got.Cursor != idle.Cursor {
		t.Fatalf("failed extraction advanced: %+v", got)
	}
	begin, err = g.Suggest(ctx, agent, gateway.SuggestInput{ThreadID: "t1", Trigger: "begin"})
	if err != nil || begin["enabled"] != true || begin["since"] != idle.Cursor {
		t.Fatalf("retry: %v %v", begin, err)
	}
	// An earlier compaction prefix never moves the watermark backwards.
	_, err = g.Suggest(ctx, agent, gateway.SuggestInput{ThreadID: "t1", Trigger: "compaction", Claim: begin["claim"].(string), Cursor: "e1"})
	if err != nil {
		t.Fatal(err)
	}
	if got := h.app.Memory.Extracted(ctx, agent, "t1"); got.Cursor != idle.Cursor {
		t.Fatalf("watermark regressed: %+v", got)
	}

	// Compaction -> idle on a second conversation. Obtain the runtime's stable tail without making a model call.
	h.sendAndWait(agent, "t2", "I prefer tea", "r2")
	begin, _ = g.Suggest(ctx, agent, gateway.SuggestInput{ThreadID: "t2", Trigger: "begin"})
	thread, _ = h.app.Threads.Get(ctx, agent, "t2")
	before = len(fake.extractions())
	h.app.suggestFromIdle(agent, "t2", *thread.LastReplyAt)
	if len(fake.extractions()) != before {
		t.Fatal("idle entered the runtime while compaction owned a new thread")
	}
	body, _ := json.Marshal(map[string]any{"threadId": "t2", "since": ""})
	resp, err := h.app.Sup.Call(ctx, agent, http.MethodPost, "/memory/extract", body, http.Header{"Content-Type": {"application/json"}})
	if err != nil {
		t.Fatal(err)
	}
	var extracted struct {
		Data struct {
			Cursor string `json:"cursor"`
		} `json:"data"`
	}
	json.NewDecoder(resp.Body).Decode(&extracted)
	resp.Body.Close()
	if extracted.Data.Cursor == "" {
		t.Fatal("runtime omitted stable cursor")
	}
	_, err = g.Suggest(ctx, agent, gateway.SuggestInput{ThreadID: "t2", Trigger: "compaction", Claim: begin["claim"].(string), Cursor: extracted.Data.Cursor})
	if err != nil {
		t.Fatal(err)
	}
	before = len(fake.extractions())
	thread, _ = h.app.Threads.Get(ctx, agent, "t2")
	h.app.suggestFromIdle(agent, "t2", *thread.LastReplyAt)
	if len(fake.extractions()) != before {
		t.Fatal("idle spent again after compaction")
	}
	// New facts are still read; old turns are not, even when checkpoint and view sizes differ.
	h.sendAndWait(agent, "t2", "I work as a nurse", "r3")
	fake.setExtract(`{"facts":[{"text":"Is a nurse","category":"work"}]}`)
	thread, _ = h.app.Threads.Get(ctx, agent, "t2")
	h.app.suggestFromIdle(agent, "t2", *thread.LastReplyAt)
	asked := fake.extractions()
	if len(asked) != before+1 || strings.Contains(asked[len(asked)-1], "I prefer tea") || !strings.Contains(asked[len(asked)-1], "I work as a nurse") {
		t.Fatalf("fresh transcript: %v", asked)
	}
	facts := suggestedFacts(t, h)
	if len(facts) != 1 || facts[0].Trust != "inferred" || facts[0].Status != "suggested" {
		t.Fatalf("trust: %+v", facts)
	}
}
