package app

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
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
	claims  map[string]extractionClaim
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
	claim, done := a.claimExtraction(ctx, agentID, threadID)
	if claim == "" {
		return
	}
	defer a.releaseExtraction(agentID, threadID, claim)
	if done.ReplyAt >= replyAt && done.Cursor != "" {
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
	body, _ := json.Marshal(map[string]any{"threadId": threadID, "since": done.Cursor, "known": known})
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
			Facts  []memory.Candidate `json:"facts"`
			Cursor string             `json:"cursor"`
		} `json:"data"`
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if dec.Decode(&out) != nil || dec.Decode(new(any)) != io.EOF || !validCursor(out.Data.Cursor) || len(out.Data.Facts) > memory.MaxCandidates {
		return
	}
	// The switch or origin may have changed while the model was answering.
	if !a.suggestable(ctx, agentID, threadID) {
		return
	}
	if _, err := a.saveSuggestionsChecked(ctx, agentID, threadID, out.Data.Facts); err != nil {
		return
	}
	// Failed requests never advance the cursor; successful empty extractions do.
	cursor := laterCursor(done.Cursor, out.Data.Cursor)
	if err := a.Memory.SetExtracted(ctx, agentID, threadID, memory.Extraction{Cursor: cursor, ReplyAt: replyAt}); err != nil {
		slog.Info("recording memory extraction", "err", err)
	}
}

// saveSuggestions judges (when the `memory` use of fast judgments is on) and saves candidates as suggestions, and says
// how many were new. The caller has checked the conversation may be read.
func (a *App) saveSuggestions(ctx context.Context, agentID, threadID string, candidates []memory.Candidate) int {
	n, _ := a.saveSuggestionsChecked(ctx, agentID, threadID, candidates)
	return n
}

func (a *App) saveSuggestionsChecked(ctx context.Context, agentID, threadID string, candidates []memory.Candidate) (int, error) {
	candidates = memory.CleanCandidates(candidates)
	if !a.suggestable(ctx, agentID, threadID) {
		return 0, errors.New("conversation no longer eligible")
	}
	if len(candidates) > 0 && a.Judge != nil && a.Judge.On("memory") && a.budgetCheck("memory judgment")(ctx, agentID) == nil {
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
	// Do not hold app.db or this guard across model I/O. The UI's disable/delete paths
	// take the same guard, so eligibility cannot change between this check and writes.
	a.suggestionMu.Lock()
	defer a.suggestionMu.Unlock()
	if !a.suggestable(ctx, agentID, threadID) {
		return 0, errors.New("conversation no longer eligible")
	}
	if len(candidates) == 0 {
		return 0, nil
	}
	saved := 0
	existing := map[string]bool{}
	facts, err := a.Memory.Facts(ctx, "")
	if err != nil {
		return 0, err
	}
	for _, f := range facts {
		existing[f.ID] = true
	}
	for _, c := range candidates {
		if !a.suggestable(ctx, agentID, threadID) {
			return saved, errors.New("conversation no longer eligible")
		}
		f, err := a.Memory.AddFact(ctx, memory.FactInput{Category: c.Category, Text: c.Text, Trust: "inferred", Active: false, SourceAgent: agentID, SourceThread: threadID})
		if err != nil {
			slog.Info("saving a suggestion", "err", err)
			return saved, err
		}
		if f.Status == "suggested" && !existing[f.ID] {
			saved++
			existing[f.ID] = true
		}
	}
	return saved, nil
}

// --- the gateway's side --------------------------------------------------------------------------------------------

func (g memoryGateway) ExtractionAllowed(ctx context.Context, agentID, threadID string) bool {
	return threadID != "" && g.a.suggestable(ctx, agentID, threadID) && g.a.budgetCheck("memory")(ctx, agentID) == nil
}

// Suggest also leases the shared extraction cursor before compaction makes any auxiliary request.
func (g memoryGateway) Suggest(ctx context.Context, agentID string, in gateway.SuggestInput) (map[string]any, error) {
	if in.Trigger == "release" {
		g.a.releaseExtraction(agentID, in.ThreadID, in.Claim)
		return map[string]any{"saved": 0}, nil
	}
	if _, _, err := g.agent(agentID); err != nil {
		return nil, err
	}
	if in.Trigger == "begin" {
		claim, done := g.a.claimExtraction(ctx, agentID, in.ThreadID)
		return map[string]any{"enabled": claim != "", "claim": claim, "since": done.Cursor}, nil
	}
	if !g.a.suggestable(ctx, agentID, in.ThreadID) {
		g.a.releaseExtraction(agentID, in.ThreadID, in.Claim)
		return map[string]any{"saved": 0}, nil
	}
	if !g.a.ownsExtraction(agentID, in.ThreadID, in.Claim) {
		return nil, errors.New("memory extraction claim expired or missing")
	}
	defer g.a.releaseExtraction(agentID, in.ThreadID, in.Claim)
	if in.Trigger != "compaction" || !validCursor(in.Cursor) || len(in.Facts) > memory.MaxCandidates {
		return nil, errors.New("invalid memory extraction")
	}
	cands := make([]memory.Candidate, 0, len(in.Facts))
	for _, f := range in.Facts {
		cands = append(cands, memory.Candidate{Text: f.Text, Category: f.Category})
	}
	saved, err := g.a.saveSuggestionsChecked(ctx, agentID, in.ThreadID, cands)
	if err != nil {
		return nil, err
	}
	done := g.a.Memory.Extracted(ctx, agentID, in.ThreadID)
	done.Cursor = laterCursor(done.Cursor, in.Cursor)
	if err := g.a.Memory.SetExtracted(ctx, agentID, in.ThreadID, done); err != nil {
		return nil, err
	}
	return map[string]any{"saved": saved}, nil
}

// Claims are process-local, shared by idle and compaction, and never hold a DB transaction.
// The lease outlives the bounded runtime request; expiry recovers a crashed/disconnected runtime.
type extractionClaim struct {
	token string
	until time.Time
}

func (a *App) claimExtraction(ctx context.Context, agentID, threadID string) (string, memory.Extraction) {
	w := &a.idle
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || threadID == "" || !a.suggestable(ctx, agentID, threadID) || a.budgetCheck("memory")(ctx, agentID) != nil {
		return "", memory.Extraction{}
	}
	key := idleKey(agentID, threadID)
	if w.claims == nil {
		w.claims = map[string]extractionClaim{}
	}
	if old, ok := w.claims[key]; ok && time.Now().Before(old.until) {
		return "", memory.Extraction{}
	}
	token := rand.Text()
	w.claims[key] = extractionClaim{token: token, until: time.Now().Add(5 * time.Minute)}
	return token, a.Memory.Extracted(ctx, agentID, threadID)
}

func (a *App) ownsExtraction(agentID, threadID, token string) bool {
	a.idle.mu.Lock()
	defer a.idle.mu.Unlock()
	c := a.idle.claims[idleKey(agentID, threadID)]
	return token != "" && c.token == token && time.Now().Before(c.until)
}

func (a *App) releaseExtraction(agentID, threadID, token string) {
	a.idle.mu.Lock()
	defer a.idle.mu.Unlock()
	key := idleKey(agentID, threadID)
	if c := a.idle.claims[key]; token != "" && c.token == token {
		delete(a.idle.claims, key)
	}
}

var messageCursor = regexp.MustCompile(`^e([0-9]{1,15})(?::([0-9]{1,6}))?$`)

func validCursor(s string) bool { return s == "" || messageCursor.MatchString(s) }

func laterCursor(a, b string) string {
	parts := func(s string) (int64, int64) {
		m := messageCursor.FindStringSubmatch(s)
		if m == nil {
			return 0, 0
		}
		e, _ := strconv.ParseInt(m[1], 10, 64)
		i, _ := strconv.ParseInt(m[2], 10, 64)
		return e, i
	}
	ae, ai := parts(a)
	be, bi := parts(b)
	if be > ae || (be == ae && bi > ai) {
		return b
	}
	return a
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
