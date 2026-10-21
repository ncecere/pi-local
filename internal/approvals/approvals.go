// Package approvals keeps tool calls that wait for a person (runtime approvals.ts, docs/api.md): requests as the
// runtimes report them, their expiry, the person's decisions, and delivering each decision to the agent's runtime
// (waking it when it sleeps) until it lands.
package approvals

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// MaxPending: beyond this many waiting requests per agent a new one is denied at once (and not recorded).
const MaxPending = 100

// Approval is a request as the UI sees it.
type Approval struct {
	ID          string          `json:"id"`
	AgentID     string          `json:"agentId"`
	AgentName   string          `json:"agentName"`
	ThreadID    *string         `json:"threadId"`
	Tool        string          `json:"tool"`
	Arguments   json.RawMessage `json:"arguments"`
	Summary     *string         `json:"summary"`
	Status      string          `json:"status"`
	RequestedAt int64           `json:"requestedAt"`
	ExpiresAt   int64           `json:"expiresAt"`
	DecidedAt   *int64          `json:"decidedAt"`
	Reason      *string         `json:"reason"`
	// CallID is retained for the tool audit, not exposed in the approvals API.
	CallID string `json:"-"`
}

// Report is what a runtime reports of a request (runtime approvals.ts, reportOf).
type Report struct {
	ID          string          `json:"id"`
	ThreadID    string          `json:"threadId"`
	Tool        string          `json:"tool"`
	CallID      string          `json:"callId"`
	Arguments   json.RawMessage `json:"arguments"`
	Summary     string          `json:"summary"`
	RequestedAt int64           `json:"requestedAt"`
	Status      string          `json:"status"`
}

// Answer is what the runtime is told back: the expiry, and a decision when there is one.
type Answer struct {
	ID        string         `json:"id"`
	Status    string         `json:"status"`
	Reason    string         `json:"reason,omitempty"`
	DecidedBy map[string]any `json:"decidedBy,omitempty"`
	ExpiresAt int64          `json:"expiresAt"`
}

// Runtimes reaches agents' runtimes.
type Runtimes interface {
	Call(ctx context.Context, id, method, pathAndQuery string, body []byte, header http.Header) (*http.Response, error)
}

// Agents tells how long an agent's requests wait, and its name.
type Agents interface {
	ApprovalTimeout(agentID string) time.Duration
	NameOf(agentID string) string
	Exists(agentID string) bool
}

// Errors.
var (
	ErrNotFound = errors.New("approval not found")
	ErrDecided  = errors.New("approval already decided")
)

// Store keeps approvals.
type Store struct {
	db       *sql.DB
	runtimes Runtimes
	agents   Agents
	// OnChange is told of every new or changed request.
	OnChange func(*Approval)
	// Person is who decides (the local person's name), for the model to read.
	Person string

	now    func() time.Time
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	kick   chan struct{}
}

// New makes the store and starts its loop (expiry and delivery); Close stops it.
func New(db *sql.DB, runtimes Runtimes, agents Agents) *Store {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Store{db: db, runtimes: runtimes, agents: agents, OnChange: func(*Approval) {}, Person: "you", now: time.Now, ctx: ctx, cancel: cancel, kick: make(chan struct{}, 1)}
	s.wg.Add(1)
	go s.loop()
	return s
}

// Close stops the loop; undelivered decisions are delivered after the next start.
func (s *Store) Close() {
	s.cancel()
	s.wg.Wait()
}

const cols = `agent_id, id, thread_id, tool, call_id, arguments, summary, status, requested_at, expires_at, decided_at, reason`

func (s *Store) scan(row interface{ Scan(...any) error }) (*Approval, error) {
	var a Approval
	var thread, summary, reason sql.NullString
	var decided sql.NullInt64
	var args string
	if err := row.Scan(&a.AgentID, &a.ID, &thread, &a.Tool, &a.CallID, &args, &summary, &a.Status, &a.RequestedAt, &a.ExpiresAt, &decided, &reason); err != nil {
		return nil, err
	}
	a.Arguments = json.RawMessage(args)
	if thread.Valid {
		a.ThreadID = &thread.String
	}
	if summary.Valid {
		a.Summary = &summary.String
	}
	if reason.Valid {
		a.Reason = &reason.String
	}
	if decided.Valid {
		a.DecidedAt = &decided.Int64
	}
	a.AgentName = s.agents.NameOf(a.AgentID)
	return &a, nil
}

func (s *Store) get(ctx context.Context, agentID, id string) (*Approval, error) {
	a, err := s.scan(s.db.QueryRowContext(ctx, `SELECT `+cols+` FROM approvals WHERE agent_id = ? AND id = ?`, agentID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return a, err
}

func (s *Store) list(ctx context.Context, query string, args ...any) ([]*Approval, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+cols+` FROM approvals `+query, args...)
	if err != nil {
		return nil, err
	}
	// Read every row before naming agents (app.db has one connection).
	var out []*Approval
	for rows.Next() {
		a, err := s.scan(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, a)
	}
	rows.Close()
	if out == nil {
		out = []*Approval{}
	}
	return out, rows.Err()
}

// Pending lists every waiting request, newest first; all: the last 200 of any status.
func (s *Store) List(ctx context.Context, all bool) ([]*Approval, error) {
	if all {
		return s.list(ctx, `ORDER BY requested_at DESC LIMIT 200`)
	}
	return s.list(ctx, `WHERE status = 'pending' ORDER BY requested_at DESC`)
}

// ForAgent lists one agent's requests, pending first (thread "": all of its threads).
func (s *Store) ForAgent(ctx context.Context, agentID, thread string) ([]*Approval, error) {
	if thread != "" {
		return s.list(ctx, `WHERE agent_id = ? AND thread_id = ? ORDER BY status != 'pending', requested_at DESC LIMIT 200`, agentID, thread)
	}
	return s.list(ctx, `WHERE agent_id = ? ORDER BY status != 'pending', requested_at DESC LIMIT 200`, agentID)
}

// PendingCount is how many of an agent's requests wait.
func (s *Store) PendingCount(ctx context.Context, agentID string) int {
	var n int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM approvals WHERE agent_id = ? AND status = 'pending'`, agentID).Scan(&n)
	return n
}

func (s *Store) changed(ctx context.Context, agentID, id string) {
	if a, err := s.get(ctx, agentID, id); err == nil {
		s.OnChange(a)
	}
}

func (s *Store) answer(ctx context.Context, agentID, id string) Answer {
	var status string
	var expires int64
	var reason sql.NullString
	s.db.QueryRowContext(ctx, `SELECT status, expires_at, reason FROM approvals WHERE agent_id = ? AND id = ?`, agentID, id).Scan(&status, &expires, &reason)
	a := Answer{ID: id, Status: status, ExpiresAt: expires, Reason: reason.String}
	switch status {
	case "approved", "denied":
		a.DecidedBy = map[string]any{"kind": "user", "id": "local", "name": s.Person}
	case "timed_out":
		a.DecidedBy = map[string]any{"kind": "system", "name": "Pi Local"}
	}
	return a
}

func validID(id string) bool {
	if !strings.HasPrefix(id, "ap_") || len(id) > 70 {
		return false
	}
	for _, r := range id[3:] {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

// bounded keeps an untrusted view of arguments to 16 KiB of valid JSON.
func bounded(raw json.RawMessage) string {
	if len(raw) == 0 || !json.Valid(raw) {
		return "null"
	}
	if len(raw) > 16<<10 {
		return `"[arguments too large to show]"`
	}
	return string(raw)
}

// record writes a report (a new request, or a runtime's word that one was cancelled) and returns the answer.
func (s *Store) record(ctx context.Context, agentID string, r Report) (Answer, bool) {
	if !validID(r.ID) || r.Tool == "" || len(r.Tool) > 200 {
		return Answer{}, false
	}
	existing, err := s.get(ctx, agentID, r.ID)
	if err == nil {
		// Known: a runtime saying it was cancelled (its call went away) ends a pending request.
		if r.Status == "cancelled" && existing.Status == "pending" {
			s.db.ExecContext(ctx, `UPDATE approvals SET status = 'cancelled', decided_at = ?, delivered = 1 WHERE agent_id = ? AND id = ? AND status = 'pending'`, s.now().UnixMilli(), agentID, r.ID)
			s.changed(ctx, agentID, r.ID)
		}
		return s.answer(ctx, agentID, r.ID), true
	}
	if r.Status != "pending" {
		return Answer{ID: r.ID, Status: r.Status}, true
	}
	if s.PendingCount(ctx, agentID) >= MaxPending {
		slog.Warn("an agent has too many approvals waiting; denying a new one", "agent", agentID)
		return Answer{ID: r.ID, Status: "denied", Reason: "Too many requests are already waiting for approval; decide those first.",
			DecidedBy: map[string]any{"kind": "system", "name": "Pi Local"}}, true
	}
	requested := r.RequestedAt
	now := s.now().UnixMilli()
	if requested <= 0 || requested > now+60_000 {
		requested = now
	}
	expires := requested + s.agents.ApprovalTimeout(agentID).Milliseconds()
	var thread, summary any
	if r.ThreadID != "" {
		thread = r.ThreadID
	}
	if r.Summary != "" {
		summary = r.Summary
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO approvals (agent_id, id, thread_id, tool, call_id, arguments, summary, status, requested_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (agent_id, id) DO NOTHING`,
		agentID, r.ID, thread, r.Tool, r.CallID, bounded(r.Arguments), summary, requested, expires)
	if err != nil {
		slog.Error("recording an approval", "agent", agentID, "err", err)
		return Answer{}, false
	}
	s.changed(ctx, agentID, r.ID)
	// Already overdue (it waited while the app was closed): time it out now.
	s.poke()
	return s.answer(ctx, agentID, r.ID), true
}

// ReportOne records one new request (gateway POST /approvals/report).
func (s *Store) ReportOne(ctx context.Context, agentID string, r Report) (Answer, bool) {
	return s.record(ctx, agentID, r)
}

// Sync records a runtime's pending requests at its start and answers for each; pending requests it no longer has
// (asked before `at`) are cancelled.
func (s *Store) Sync(ctx context.Context, agentID string, reports []Report, at int64) []Answer {
	seen := map[string]bool{}
	out := []Answer{}
	for _, r := range reports {
		if a, ok := s.record(ctx, agentID, r); ok {
			seen[r.ID] = true
			out = append(out, a)
		}
	}
	if at > 0 {
		gone, _ := s.list(ctx, `WHERE agent_id = ? AND status = 'pending' AND requested_at < ?`, agentID, at)
		for _, a := range gone {
			if seen[a.ID] {
				continue
			}
			s.db.ExecContext(ctx, `UPDATE approvals SET status = 'cancelled', decided_at = ?, delivered = 1 WHERE agent_id = ? AND id = ? AND status = 'pending'`, s.now().UnixMilli(), agentID, a.ID)
			s.changed(ctx, agentID, a.ID)
		}
	}
	return out
}

// Decide records a person's decision and delivers it to the agent.
func (s *Store) Decide(ctx context.Context, agentID, id string, approve bool, reason string) (*Approval, error) {
	reason = strings.TrimSpace(reason)
	if len([]rune(reason)) > 1000 {
		reason = string([]rune(reason)[:1000])
	}
	status := "denied"
	if approve {
		status = "approved"
	}
	var r any
	if reason != "" {
		r = reason
	}
	res, err := s.db.ExecContext(ctx, `UPDATE approvals SET status = ?, reason = ?, decided_at = ?, decided_by = 'user', delivered = 0, delivery_attempts = 0, next_delivery_at = 0
		WHERE agent_id = ? AND id = ? AND status = 'pending'`, status, r, s.now().UnixMilli(), agentID, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if _, err := s.get(ctx, agentID, id); err != nil {
			return nil, err
		}
		return nil, ErrDecided
	}
	s.changed(ctx, agentID, id)
	s.poke()
	return s.get(ctx, agentID, id)
}

// Kick runs the expiry and delivery loop now.
func (s *Store) Kick() { s.poke() }

func (s *Store) poke() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

func (s *Store) loop() {
	defer s.wg.Done()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		s.expire()
		s.deliver()
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		case <-s.kick:
		}
	}
}

// expire times out requests past their expiry (the call is denied).
func (s *Store) expire() {
	ctx := s.ctx
	now := s.now().UnixMilli()
	overdue, err := s.list(ctx, `WHERE status = 'pending' AND expires_at <= ?`, now)
	if err != nil {
		return
	}
	for _, a := range overdue {
		res, err := s.db.ExecContext(ctx, `UPDATE approvals SET status = 'timed_out', decided_at = ?, delivered = 0, delivery_attempts = 0, next_delivery_at = 0
			WHERE agent_id = ? AND id = ? AND status = 'pending'`, now, a.AgentID, a.ID)
		if err == nil {
			if n, _ := res.RowsAffected(); n > 0 {
				s.changed(ctx, a.AgentID, a.ID)
			}
		}
	}
}

// deliver tells runtimes about decisions they haven't heard of, waking them; a failure is retried with backoff.
func (s *Store) deliver() {
	ctx := s.ctx
	now := s.now().UnixMilli()
	rows, err := s.db.QueryContext(ctx, `SELECT agent_id, id, status, COALESCE(reason, ''), delivery_attempts FROM approvals WHERE delivered = 0 AND next_delivery_at <= ?`, now)
	if err != nil {
		return
	}
	type item struct {
		agent, id, status, reason string
		attempts                  int
	}
	var items []item
	for rows.Next() {
		var it item
		if rows.Scan(&it.agent, &it.id, &it.status, &it.reason, &it.attempts) == nil {
			items = append(items, it)
		}
	}
	rows.Close()
	for _, it := range items {
		if ctx.Err() != nil {
			return
		}
		if !s.agents.Exists(it.agent) {
			s.db.ExecContext(ctx, `UPDATE approvals SET delivered = 1 WHERE agent_id = ? AND id = ?`, it.agent, it.id)
			continue
		}
		decision := map[string]string{"approved": "approve", "denied": "deny", "timed_out": "timeout", "cancelled": "cancel"}[it.status]
		body := map[string]any{"decision": decision}
		if it.reason != "" {
			body["reason"] = it.reason
		}
		ans := s.answer(ctx, it.agent, it.id)
		if ans.DecidedBy != nil {
			body["decidedBy"] = ans.DecidedBy
		}
		raw, _ := json.Marshal(body)
		callCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		resp, err := s.runtimes.Call(callCtx, it.agent, http.MethodPost, "/approvals/"+it.id, raw, http.Header{"Content-Type": {"application/json"}})
		cancel()
		ok := err == nil && (resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusNotFound)
		if resp != nil {
			resp.Body.Close()
		}
		if ok {
			s.db.ExecContext(ctx, `UPDATE approvals SET delivered = 1 WHERE agent_id = ? AND id = ?`, it.agent, it.id)
			continue
		}
		// Back off: 5 s, 10 s … up to 5 minutes.
		delay := min(time.Duration(5<<min(it.attempts, 6))*time.Second, 5*time.Minute)
		s.db.ExecContext(ctx, `UPDATE approvals SET delivery_attempts = delivery_attempts + 1, next_delivery_at = ? WHERE agent_id = ? AND id = ?`,
			s.now().Add(delay).UnixMilli(), it.agent, it.id)
		slog.Info("delivering an approval decision failed; retrying later", "agent", it.agent, "approval", it.id, "err", err)
	}
}

// ForgetAgent removes a deleted agent's requests.
func (s *Store) ForgetAgent(ctx context.Context, agentID string) {
	s.db.ExecContext(ctx, `DELETE FROM approvals WHERE agent_id = ?`, agentID)
}
