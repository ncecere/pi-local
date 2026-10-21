// Package threads is the app's index of every agent's threads (table threads in app.db), so the UI can list them
// without starting an agent's runtime. The runtime keeps it current with reports (threads/sync, threads/report);
// the app writes a record itself before relaying a thread's first message.
package threads

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Thread is a thread as the UI lists it (docs/api.md, AgentThread).
type Thread struct {
	ThreadID     string    `json:"threadId"`
	Title        string    `json:"title"`
	CreatedAt    int64     `json:"createdAt"`
	UpdatedAt    int64     `json:"updatedAt"`
	Busy         bool      `json:"busy"`
	LastReplyAt  *int64    `json:"lastReplyAt,omitempty"`
	LastError    *string   `json:"lastError,omitempty"`
	Visibility   string    `json:"visibility"`
	CreatedBy    any       `json:"createdBy"`
	Participants []any     `json:"participants"`
	CalledBy     *CalledBy `json:"calledBy"`
	// The model ("provider/modelId") and thinking level the person chose for it; empty: the agent's own.
	ModelID  string `json:"modelId,omitempty"`
	Thinking string `json:"thinking,omitempty"`
}

// CalledBy is the agent (and its thread) that asked in a thread (ask_agent).
type CalledBy struct {
	AgentID  string `json:"agentId"`
	Name     string `json:"name"`
	ThreadID string `json:"threadId"`
}

// Status is a runtime's report on a thread (docs/runtime-contract.md, ThreadStatus).
type Status struct {
	ThreadID    string  `json:"threadId"`
	Title       string  `json:"title"`
	CreatedAt   int64   `json:"createdAt"`
	Busy        bool    `json:"busy"`
	LastReplyAt *int64  `json:"lastReplyAt,omitempty"`
	LastError   *string `json:"lastError,omitempty"`
	At          int64   `json:"at"`
}

// ErrNotFound: the agent has no such thread in the index.
var ErrNotFound = errors.New("thread not found")

// Change is a thread that changed, for the UI's live events.
type Change struct {
	AgentID  string
	ThreadID string
	Deleted  bool
	Thread   *Thread
}

// Index is the threads table.
type Index struct {
	db       *sql.DB
	onChange func(Change)
	now      func() time.Time
	// NameOf names an agent (for CalledBy); set by the app.
	NameOf func(agentID string) string

	// sending counts messages on their way to a thread's runtime (Sending … Sent). Meanwhile a sync or report saying
	// the thread is idle is about the time before the message arrived, so it doesn't clear busy.
	sendMu  sync.Mutex
	sending map[string]int
}

func sendKey(agentID, threadID string) string { return agentID + "\x00" + threadID }

func (x *Index) inFlight(agentID, threadID string) bool {
	x.sendMu.Lock()
	defer x.sendMu.Unlock()
	return x.sending[sendKey(agentID, threadID)] > 0
}

// Sent says a message Sending announced has reached the runtime, or failed to.
func (x *Index) Sent(agentID, threadID string) {
	x.sendMu.Lock()
	defer x.sendMu.Unlock()
	k := sendKey(agentID, threadID)
	if x.sending[k]--; x.sending[k] <= 0 {
		delete(x.sending, k)
	}
}

// youngRecord: a sync doesn't remove a record the app wrote this recently (its first message may not have reached
// the runtime when the runtime listed its threads).
const youngRecord = 5 * time.Minute

// NewIndex makes the index; onChange is called after every change.
func NewIndex(db *sql.DB, onChange func(Change)) *Index {
	if onChange == nil {
		onChange = func(Change) {}
	}
	return &Index{db: db, onChange: onChange, now: time.Now, sending: map[string]int{}}
}

const columns = `thread_id, COALESCE(title_override, title), created_at, updated_at, busy, last_reply_at, last_error, called_by_agent, called_by_thread, COALESCE(model_id, ''), COALESCE(thinking, '')`

func (x *Index) scan(row interface{ Scan(...any) error }) (*Thread, error) {
	var t Thread
	var busy int
	var lastReply sql.NullInt64
	var lastErr, byAgent, byThread sql.NullString
	if err := row.Scan(&t.ThreadID, &t.Title, &t.CreatedAt, &t.UpdatedAt, &busy, &lastReply, &lastErr, &byAgent, &byThread, &t.ModelID, &t.Thinking); err != nil {
		return nil, err
	}
	if byAgent.Valid {
		t.CalledBy = &CalledBy{AgentID: byAgent.String, ThreadID: byThread.String}
		if x.NameOf != nil {
			t.CalledBy.Name = x.NameOf(byAgent.String)
		}
	}
	t.Busy = busy != 0
	if lastReply.Valid {
		v := lastReply.Int64
		t.LastReplyAt = &v
	}
	if lastErr.Valid {
		v := lastErr.String
		t.LastError = &v
	}
	t.Visibility = "private"
	t.Participants = []any{}
	return &t, nil
}

// List returns an agent's threads, newest activity first.
func (x *Index) List(ctx context.Context, agentID string) ([]*Thread, error) {
	rows, err := x.db.QueryContext(ctx, `SELECT `+columns+` FROM threads WHERE agent_id = ? ORDER BY updated_at DESC, thread_id`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Thread{}
	for rows.Next() {
		t, err := x.scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Get returns one thread.
func (x *Index) Get(ctx context.Context, agentID, threadID string) (*Thread, error) {
	t, err := x.scan(x.db.QueryRowContext(ctx, `SELECT `+columns+` FROM threads WHERE agent_id = ? AND thread_id = ?`, agentID, threadID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return t, err
}

func (x *Index) changed(ctx context.Context, agentID, threadID string) {
	t, err := x.Get(ctx, agentID, threadID)
	if errors.Is(err, ErrNotFound) {
		x.onChange(Change{AgentID: agentID, ThreadID: threadID, Deleted: true})
		return
	}
	if err == nil {
		x.onChange(Change{AgentID: agentID, ThreadID: threadID, Thread: t})
	}
}

// TitleFrom is a thread's title from its first message, as the runtime makes it: the first line, at most 60 characters.
func TitleFrom(text string) string {
	line := strings.TrimSpace(strings.SplitN(strings.TrimSpace(text), "\n", 2)[0])
	if utf8.RuneCountInString(line) > 60 {
		line = string([]rune(line)[:60])
	}
	return line
}

// Sending records that a message is on its way to a thread: the thread is busy from now. The record is made when the
// thread is new (created reports whether it was, so a refused first message can take it away again).
// calledBy, when an agent asks, is recorded on a new thread.
// Every call must be followed by Sent once the message reached the runtime (or failed to).
func (x *Index) Sending(ctx context.Context, agentID, threadID, text string, calledBy *CalledBy) (created bool, err error) {
	x.sendMu.Lock()
	x.sending[sendKey(agentID, threadID)]++
	x.sendMu.Unlock()
	now := x.now().UnixMilli()
	var byAgent, byThread any
	if calledBy != nil {
		byAgent, byThread = calledBy.AgentID, calledBy.ThreadID
	}
	res, err := x.db.ExecContext(ctx, `INSERT INTO threads (agent_id, thread_id, title, created_at, updated_at, busy, status_at, recorded_at, called_by_agent, called_by_thread)
		VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT (agent_id, thread_id) DO NOTHING`,
		agentID, threadID, TitleFrom(text), now, now, now, now, byAgent, byThread)
	if err != nil {
		x.Sent(agentID, threadID)
		return false, err
	}
	n, _ := res.RowsAffected()
	created = n == 1
	if !created {
		if _, err := x.db.ExecContext(ctx, `UPDATE threads SET busy = 1, updated_at = ? WHERE agent_id = ? AND thread_id = ?`, now, agentID, threadID); err != nil {
			x.Sent(agentID, threadID)
			return false, err
		}
	}
	x.changed(ctx, agentID, threadID)
	return created, nil
}

// Adopt records a thread the runtime just made (a fork), idle, with the source's title.
func (x *Index) Adopt(ctx context.Context, agentID, threadID, title string) error {
	now := x.now().UnixMilli()
	_, err := x.db.ExecContext(ctx, `INSERT INTO threads (agent_id, thread_id, title, created_at, updated_at, busy, status_at, recorded_at)
		VALUES (?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT (agent_id, thread_id) DO NOTHING`, agentID, threadID, TitleFrom(title), now, now, now, now)
	if err != nil {
		return err
	}
	x.changed(ctx, agentID, threadID)
	return nil
}

// SetChoice records the model and thinking level the person chose for a thread ("" for the agent's own).
func (x *Index) SetChoice(ctx context.Context, agentID, threadID, modelID, thinking string) error {
	res, err := x.db.ExecContext(ctx, `UPDATE threads SET model_id = NULLIF(?, ''), thinking = NULLIF(?, '')
		WHERE agent_id = ? AND thread_id = ? AND (COALESCE(model_id, '') != ? OR COALESCE(thinking, '') != ?)`,
		modelID, thinking, agentID, threadID, modelID, thinking)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		x.changed(ctx, agentID, threadID)
	}
	return nil
}

// Rename sets the title people see, over the runtime's.
func (x *Index) Rename(ctx context.Context, agentID, threadID, title string) (*Thread, error) {
	res, err := x.db.ExecContext(ctx, `UPDATE threads SET title_override = ? WHERE agent_id = ? AND thread_id = ?`, title, agentID, threadID)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	x.changed(ctx, agentID, threadID)
	return x.Get(ctx, agentID, threadID)
}

// Delete forgets a thread.
func (x *Index) Delete(ctx context.Context, agentID, threadID string) error {
	if _, err := x.db.ExecContext(ctx, `DELETE FROM threads WHERE agent_id = ? AND thread_id = ?`, agentID, threadID); err != nil {
		return err
	}
	x.onChange(Change{AgentID: agentID, ThreadID: threadID, Deleted: true})
	return nil
}

// apply writes one report when it is newer than what the record holds. With adopt, a thread the index lacks is
// created (a sync); without it, a report about an unknown thread is ignored, so a late report can never bring back a
// thread that was deleted.
func (x *Index) apply(ctx context.Context, tx *sql.Tx, agentID string, s Status, adopt bool) (bool, error) {
	if s.ThreadID == "" || s.At <= 0 {
		return false, nil
	}
	title := TitleFrom(s.Title)
	busy := 0
	if s.Busy || x.inFlight(agentID, s.ThreadID) {
		busy = 1
	}
	// Its last activity: a report is about now (a reply ended or began), and so is a sync of a busy thread; a sync of an
	// idle one (every thread, each time the agent wakes) is not, so it keeps its last reply's time.
	updated := s.At
	if adopt && !s.Busy {
		updated = max(s.CreatedAt, 0)
	}
	if s.LastReplyAt != nil && *s.LastReplyAt > updated {
		updated = *s.LastReplyAt
	}
	res, err := tx.ExecContext(ctx, `UPDATE threads SET title = ?, busy = ?, last_reply_at = COALESCE(?, last_reply_at), last_error = ?,
			updated_at = MAX(updated_at, ?), status_at = ?
		WHERE agent_id = ? AND thread_id = ? AND status_at < ?`,
		title, busy, s.LastReplyAt, s.LastError, updated, s.At, agentID, s.ThreadID, s.At)
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return true, nil
	}
	if !adopt {
		return false, nil
	}
	created := s.CreatedAt
	if created <= 0 {
		created = s.At
	}
	res, err = tx.ExecContext(ctx, `INSERT INTO threads (agent_id, thread_id, title, created_at, updated_at, busy, last_reply_at, last_error, status_at, recorded_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (agent_id, thread_id) DO NOTHING`,
		agentID, s.ThreadID, title, created, max(updated, created), busy, s.LastReplyAt, s.LastError, s.At, x.now().UnixMilli())
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// Report applies the runtime's report at the end of a reply. A thread the index doesn't know is ignored.
func (x *Index) Report(ctx context.Context, agentID string, s Status) error {
	tx, err := x.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	changed, err := x.apply(ctx, tx, agentID, s, false)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if changed {
		x.changed(ctx, agentID, s.ThreadID)
	}
	return nil
}

// Sync applies the runtime's list of every thread, at its start: each is adopted or updated, and records the runtime
// no longer has are removed, unless they are younger than five minutes (a first message on its way).
func (x *Index) Sync(ctx context.Context, agentID string, statuses []Status, at int64) error {
	tx, err := x.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	seen := map[string]bool{}
	var changed []string
	for _, s := range statuses {
		seen[s.ThreadID] = true
		ok, err := x.apply(ctx, tx, agentID, s, true)
		if err != nil {
			return err
		}
		if ok {
			changed = append(changed, s.ThreadID)
		}
	}
	var gone []string
	if at > 0 {
		cutoff := x.now().Add(-youngRecord).UnixMilli()
		rows, err := tx.QueryContext(ctx, `SELECT thread_id FROM threads WHERE agent_id = ? AND status_at < ? AND recorded_at < ?`, agentID, at, cutoff)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			if !seen[id] {
				gone = append(gone, id)
			}
		}
		rows.Close()
		for _, id := range gone {
			if _, err := tx.ExecContext(ctx, `DELETE FROM threads WHERE agent_id = ? AND thread_id = ?`, agentID, id); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, id := range changed {
		x.changed(ctx, agentID, id)
	}
	for _, id := range gone {
		x.onChange(Change{AgentID: agentID, ThreadID: id, Deleted: true})
	}
	return nil
}

// AgentsWithBusyThreads lists agents whose index shows a reply in progress: at the app's start, these are woken so
// work a previous run of the app left unfinished (it quit mid-reply) resumes without anyone opening the thread.
func (x *Index) AgentsWithBusyThreads(ctx context.Context) ([]string, error) {
	rows, err := x.db.QueryContext(ctx, `SELECT DISTINCT agent_id FROM threads WHERE busy = 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
