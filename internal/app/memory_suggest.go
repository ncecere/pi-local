package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ncecere/pi-local/internal/gateway"
	"github.com/ncecere/pi-local/internal/memory"
	"github.com/ncecere/pi-local/internal/threads"
	"github.com/ncecere/pi-local/internal/usage"
)

// Suggestions from conversations (docs/api.md, "Suggestions from conversations").
//
// Two triggers, one switch (Settings → You, off by default):
//   - Idle: a conversation has had no message for memoryIdle (10 minutes) after a reply. The app asks the agent's own
//     runtime to read what is new in it and ask the agent's model for at most 3 facts about the person
//     (POST /memory/extract on the runtime).
//   - Before a compaction: the runtime does the same on what pi is about to summarize and reports it to the gateway
//     (POST /memory/suggest).
//
// Both end in saveSuggestions: the candidates are judged when fast judgments' `memory` use is on, and saved as
// suggestions (trust inferred, status suggested) with the conversation as their source. Nothing is ever saved as known.
// Never for a conversation a schedule started or another agent asked in.

const defaultMemoryIdle = 10 * time.Minute

// idleWatch is the conversations waiting out their idle time.
type idleWatch struct {
	mu      sync.Mutex
	timers  map[string]*idleTimer
	closed  bool
	ctx     context.Context
	cancel  context.CancelFunc
	running sync.WaitGroup
}

type idleTimer struct {
	replyAt int64
	timer   *time.Timer
}

func idleKey(agentID, threadID string) string { return agentID + "\x00" + threadID }

func (a *App) memoryIdle() time.Duration {
	if a.cfg.MemoryIdle > 0 {
		return a.cfg.MemoryIdle
	}
	return defaultMemoryIdle
}

// watchIdle follows a thread's changes: a message in flight cancels the wait, a reply that just ended starts it. A
// thread whose last reply is older than the idle time (the app was closed, an old thread an agent's start synced)
// isn't checked, and neither is one that was checked after that reply.
func (a *App) watchIdle(agentID string, t *threads.Thread, deleted bool) {
	w := &a.idle
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	key := idleKey(agentID, t.ThreadID)
	if w.timers == nil {
		w.timers = map[string]*idleTimer{}
	}
	cur := w.timers[key]
	if deleted || t.Busy {
		if cur != nil {
			cur.timer.Stop()
			delete(w.timers, key)
		}
		return
	}
	if t.LastReplyAt == nil {
		return
	}
	replyAt := *t.LastReplyAt
	if cur != nil {
		if cur.replyAt == replyAt {
			return // the same reply: a rename, a sync
		}
		cur.timer.Stop()
		delete(w.timers, key)
	}
	wait := a.memoryIdle() - time.Since(time.UnixMilli(replyAt))
	if wait <= 0 || !a.Memory.SuggestionsOn() {
		return
	}
	threadID := t.ThreadID
	timer := time.AfterFunc(wait, func() {
		w.mu.Lock()
		if w.closed || w.timers[key] == nil || w.timers[key].replyAt != replyAt {
			w.mu.Unlock()
			return
		}
		delete(w.timers, key)
		w.mu.Unlock()
		a.suggestFromIdle(agentID, threadID, replyAt)
	})
	w.timers[key] = &idleTimer{replyAt: replyAt, timer: timer}
}

// closeIdle stops timers and cancels all in-flight extraction before waiting for it to release app.db.
func (a *App) closeIdle() {
	w := &a.idle
	w.mu.Lock()
	w.closed = true
	if w.cancel != nil {
		w.cancel()
	}
	for k, t := range w.timers {
		t.timer.Stop()
		delete(w.timers, k)
	}
	w.mu.Unlock()
	w.running.Wait()
}

// suggestable says whether a conversation may be read for suggestions: the switch is on, the agent has memory, and
// the conversation is the person's own (not started by a schedule, not asked by another agent).
func (a *App) suggestable(ctx context.Context, agentID, threadID string) bool {
	if !a.Memory.SuggestionsOn() {
		return false
	}
	ag, err := a.Agents.Get(agentID)
	if err != nil || ag.Config.Memory.Off {
		return false
	}
	t, err := a.Threads.Get(ctx, agentID, threadID)
	if err != nil || t.CalledBy != nil || strings.HasPrefix(threadID, "sched-") {
		return false
	}
	var fired int
	err = a.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM schedule_runs WHERE agent_id = ? AND thread_id = ?`, agentID, threadID).Scan(&fired)
	return err == nil && fired == 0
}

// suggestFromIdle reads what is new in an idle conversation and saves what the agent's model found as suggestions.
func (a *App) suggestFromIdle(agentID, threadID string, replyAt int64) {
	w := &a.idle
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	if w.ctx == nil {
		w.ctx, w.cancel = context.WithCancel(context.Background())
	}
	ctx, cancel := context.WithTimeout(w.ctx, 3*time.Minute)
	// Register under the same lock as closeIdle's closed check: no Add can race its Wait.
	w.running.Add(1)
	w.mu.Unlock()
	defer w.running.Done()
	defer cancel()
	if !a.suggestable(ctx, agentID, threadID) {
		return
	}
	if t, err := a.Threads.Get(ctx, agentID, threadID); err != nil || t.Busy || (t.LastReplyAt != nil && *t.LastReplyAt != replyAt) {
		return // another message came in: its own reply starts a new wait
	}
	done := a.Memory.Extracted(ctx, agentID, threadID)
	if done.ReplyAt >= replyAt {
		return
	}
	// The model call is the agent's own spend: it counts against its budget like any request.
	if err := a.budgetCheck("memory")(ctx, agentID); err != nil {
		return
	}
	ag, err := a.Agents.Get(agentID)
	if err != nil {
		return
	}
	// What it already knows (what this agent may see), so the model doesn't suggest it again.
	known := []string{}
	if facts, err := a.Memory.SearchFacts(ctx, "", ag.Config.Memory.Share, 30); err == nil {
		for _, f := range facts {
			known = append(known, f.Text)
		}
	}
	body, _ := json.Marshal(map[string]any{"threadId": threadID, "since": done.Messages, "known": known})
	resp, err := a.Sup.Call(ctx, agentID, http.MethodPost, "/memory/extract", body, http.Header{"Content-Type": {"application/json"}})
	if err != nil {
		slog.Info("reading a conversation for suggestions", "agent", agentID, "err", err)
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		slog.Info("reading a conversation for suggestions: the agent said no", "agent", agentID, "status", resp.StatusCode)
		return
	}
	var out struct {
		Data struct {
			Facts    []memory.Candidate `json:"facts"`
			Messages int                `json:"messages"`
		} `json:"data"`
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if dec.Decode(&out) != nil || dec.Decode(new(any)) != io.EOF || out.Data.Messages < 0 || len(out.Data.Facts) > memory.MaxCandidates {
		return
	}
	// The switch or origin may have changed while the model was answering.
	if !a.suggestable(ctx, agentID, threadID) {
		return
	}
	a.saveSuggestions(ctx, agentID, threadID, out.Data.Facts)
	// Failed requests never advance the cursor; successful empty extractions do.
	if err := a.Memory.SetExtracted(ctx, agentID, threadID, memory.Extraction{Messages: out.Data.Messages, ReplyAt: replyAt}); err != nil {
		slog.Info("recording memory extraction", "err", err)
	}
}

// saveSuggestions judges (when the `memory` use of fast judgments is on) and saves candidates as suggestions, and says
// how many were new. The caller has checked the conversation may be read.
func (a *App) saveSuggestions(ctx context.Context, agentID, threadID string, candidates []memory.Candidate) int {
	candidates = memory.CleanCandidates(candidates)
	if len(candidates) == 0 {
		return 0
	}
	if a.Judge != nil && a.Judge.On("memory") && a.budgetCheck("memory judgment")(ctx, agentID) == nil {
		texts := make([]string, len(candidates))
		for i, c := range candidates {
			texts[i] = c.Text
		}
		// A failed judgment is no judgment: they are only suggestions, so they stay and the person decides.
		// System One has no configured token prices. Count attempts and available tokens as unpriced usage; never
		// hide their spend by pretending they are free. They obey the same pre-request budget gate as extraction.
		keep, err := a.Judge.KeepFacts(ctx, texts, func(model string, input, output int64) {
			if recordErr := a.RecordUsage(context.WithoutCancel(ctx), agentID, "judgments/"+model, usage.Counts{Requests: 1, Input: input, Output: output}); recordErr != nil {
				slog.Warn("recording memory judgment usage", "err", recordErr)
			}
		})
		if err == nil {
			kept := candidates[:0:0]
			for i, c := range candidates {
				if keep[i] {
					kept = append(kept, c)
				}
			}
			candidates = kept
		} else {
			slog.Info("judging suggestions", "err", err)
		}
	}
	saved := 0
	existing := map[string]bool{}
	facts, err := a.Memory.Facts(ctx, "")
	if err != nil {
		return 0
	}
	for _, f := range facts {
		existing[f.ID] = true
	}
	for _, c := range candidates {
		f, err := a.Memory.AddFact(ctx, memory.FactInput{Category: c.Category, Text: c.Text, Trust: "inferred", Active: false, SourceAgent: agentID, SourceThread: threadID})
		if err != nil {
			slog.Info("saving a suggestion", "err", err)
			continue
		}
		if f.Status == "suggested" && !existing[f.ID] {
			saved++
			existing[f.ID] = true
		}
	}
	return saved
}

// --- the gateway's side --------------------------------------------------------------------------------------------

func (g memoryGateway) ExtractionAllowed(ctx context.Context, agentID, threadID string) bool {
	return threadID != "" && g.a.suggestable(ctx, agentID, threadID) && g.a.budgetCheck("memory")(ctx, agentID) == nil
}

// Suggest: facts the runtime found in what a compaction is about to summarize.
func (g memoryGateway) Suggest(ctx context.Context, agentID string, in gateway.SuggestInput) (map[string]any, error) {
	if _, _, err := g.agent(agentID); err != nil {
		return nil, err
	}
	if in.Trigger != "compaction" || in.ThreadID == "" || !g.a.suggestable(ctx, agentID, in.ThreadID) {
		return map[string]any{"saved": 0}, nil
	}
	cands := make([]memory.Candidate, 0, len(in.Facts))
	for _, f := range in.Facts {
		cands = append(cands, memory.Candidate{Text: f.Text, Category: f.Category})
	}
	return map[string]any{"saved": g.a.saveSuggestions(ctx, agentID, in.ThreadID, cands)}, nil
}

// SearchConversations: the agent's own conversations, through the app's message search. The agent's ID comes from its
// runtime key, so it can never reach another agent's conversations.
func (g memoryGateway) SearchConversations(ctx context.Context, agentID, query string, limit int) (map[string]any, error) {
	if _, _, err := g.agent(agentID); err != nil {
		return nil, err
	}
	query = strings.TrimSpace(query)
	if r := []rune(query); len(r) > 200 {
		query = string(r[:200])
	}
	if limit <= 0 {
		limit = 5
	}
	limit = min(limit, 20)
	hits, err := g.a.Search.SearchAgent(ctx, agentID, query, limit*2)
	if err != nil {
		return nil, err
	}
	results := []map[string]any{}
	for _, h := range hits {
		if len(results) == limit {
			break
		}
		t, err := g.a.Threads.Get(ctx, agentID, h.ThreadID)
		if err != nil {
			continue // a conversation that is gone
		}
		when := t.UpdatedAt
		if t.LastReplyAt != nil {
			when = *t.LastReplyAt
		}
		snippet := strings.NewReplacer("\u0001", "**", "\u0002", "**").Replace(h.Snippet)
		results = append(results, map[string]any{
			"threadId": h.ThreadID, "title": t.Title, "date": time.UnixMilli(when).UTC().Format("2006-01-02"), "snippet": snippet,
		})
	}
	return map[string]any{"results": results}, nil
}
