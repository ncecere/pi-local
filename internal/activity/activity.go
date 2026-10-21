// Package activity is the audit log: what agents did and what was done to them (docs/api.md, "Activity").
//
// Tool calls arrive from the runtimes, batched, when each call ends (the gateway's POST /activity); the app records
// the rest itself: messages sent, schedule runs, asks between agents, approvals decided, MCP sign-ins, budget refusals
// and errors. Entries are kept 90 days and pruned daily.
//
// Recording never blocks and never fails its caller: Record only queues the entry, and one goroutine writes the queue.
// That matters because app.db has one connection: a caller that holds rows open while it records would otherwise wait
// for itself.
package activity

import (
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/ncecere/pi-local/internal/agents"
)

// Retention is how long entries are kept.
const Retention = 90 * 24 * time.Hour

// Kinds of entry.
const (
	KindTool     = "tool"     // a tool call that ended
	KindMessage  = "message"  // the person sent a message
	KindSchedule = "schedule" // a schedule ran
	KindAsk      = "ask"      // an agent asked another
	KindApproval = "approval" // a tool call's approval was decided
	KindSignIn   = "sign_in"  // an MCP server's sign-in or sign-out
	KindBudget   = "budget"   // work refused because a budget was used up
	KindError    = "error"    // a reply failed, an agent could not start
)

// Kinds lists every kind, for validating filters.
var Kinds = []string{KindTool, KindMessage, KindSchedule, KindAsk, KindApproval, KindSignIn, KindBudget, KindError}

// Outcomes entries carry (a tool call: ok, error, denied or declined; the others as they fit).
var Outcomes = []string{"ok", "error", "denied", "declined", "refused", "cancelled"}

const (
	maxTitle  = 200
	maxActor  = 120
	maxDetail = 16 << 10
	// PreviewChars is how much of a message is kept: enough to recognise it, not to reread it.
	PreviewChars = 120
	queueSize    = 4096
	// DefaultLimit and MaxLimit bound a page.
	DefaultLimit = 100
	MaxLimit     = 500
	// maxExport bounds a CSV export (ninety days of a very busy agent).
	maxExport = 200_000
)

// Entry is one thing that happened.
type Entry struct {
	ID         int64           `json:"id"`
	At         int64           `json:"at"`
	Kind       string          `json:"kind"`
	AgentID    string          `json:"agentId"`
	AgentName  string          `json:"agentName"`
	ThreadID   string          `json:"threadId"`
	Actor      string          `json:"actor"`
	Title      string          `json:"title"`
	Outcome    string          `json:"outcome"`
	DurationMs *int64          `json:"durationMs"`
	Detail     json.RawMessage `json:"detail"`
	// Dedupe: when set, a second entry with the same key is dropped (a runtime may report a call again).
	Dedupe string `json:"-"`
}

// MarshalJSON writes "no agent" and "no thread" as null.
func (e Entry) MarshalJSON() ([]byte, error) {
	type plain Entry
	out := struct {
		plain
		AgentID  *string `json:"agentId"`
		ThreadID *string `json:"threadId"`
	}{plain: plain(e)}
	if e.AgentID != "" {
		out.AgentID = &e.AgentID
	}
	if e.ThreadID != "" {
		out.ThreadID = &e.ThreadID
	}
	if len(out.Detail) == 0 {
		out.Detail = json.RawMessage(`{}`)
	}
	return json.Marshal(out)
}

type item struct {
	entry *Entry
	done  chan struct{} // a marker: closed once everything before it is written
}

// Store keeps the log.
type Store struct {
	db *sql.DB
	// AgentName names an agent for entries that don't (set by the app).
	AgentName func(id string) string

	now    func() time.Time
	queue  chan item
	wg     sync.WaitGroup
	mu     sync.Mutex
	closed bool
	cancel context.CancelFunc
	ctx    context.Context
}

// New makes the store, starts its writer and its daily pruning; Close stops them.
func New(db *sql.DB) *Store {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Store{db: db, now: time.Now, queue: make(chan item, queueSize), ctx: ctx, cancel: cancel}
	s.wg.Add(2)
	go s.write()
	go s.prune()
	return s
}

// Close writes what is queued and stops.
func (s *Store) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.queue)
	s.mu.Unlock()
	s.cancel()
	s.wg.Wait()
}

// Record queues an entry (a nil store records nothing). It never blocks: when the queue is full (the database is stuck) the entry is dropped.
func (s *Store) Record(e Entry) {
	if s == nil || e.Kind == "" || e.Title == "" {
		return
	}
	if e.At <= 0 {
		e.At = s.now().UnixMilli()
	}
	if e.AgentName == "" && e.AgentID != "" && s.AgentName != nil {
		e.AgentName = s.AgentName(e.AgentID)
	}
	if e.Actor == "" && e.Kind == KindTool {
		e.Actor = e.AgentName // a tool call is the agent's own doing
	}
	e.Title = clip(oneLine(e.Title), maxTitle)
	e.Actor = clip(oneLine(e.Actor), maxActor)
	e.AgentName = clip(oneLine(e.AgentName), maxActor)
	if len(e.Detail) == 0 || !json.Valid(e.Detail) || len(e.Detail) > maxDetail {
		e.Detail = json.RawMessage(`{}`)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	select {
	case s.queue <- item{entry: &e}:
	default:
		slog.Warn("the activity log is behind; dropping an entry", "kind", e.Kind)
	}
}

// Detail makes an entry's detail from a map (bounded: a map that doesn't fit is dropped).
func Detail(fields map[string]any) json.RawMessage {
	raw, err := json.Marshal(fields)
	if err != nil || len(raw) > maxDetail {
		return json.RawMessage(`{}`)
	}
	return raw
}

// Preview is the first PreviewChars characters of a message on one line, with anything that looks like a credential
// hidden (people paste keys into messages).
func Preview(text string) string {
	text = agents.RedactText(strings.Join(strings.Fields(text), " "))
	if r := []rune(text); len(r) > PreviewChars {
		return string(r[:PreviewChars-1]) + "…"
	}
	return text
}

// Flush waits until everything recorded before it is written.
func (s *Store) Flush() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	done := make(chan struct{})
	select {
	case s.queue <- item{done: done}:
		s.mu.Unlock()
	default:
		s.mu.Unlock()
		return
	}
	<-done
}

func (s *Store) write() {
	defer s.wg.Done()
	for first := range s.queue {
		batch := []item{first}
	more:
		for len(batch) < 200 {
			select {
			case next, ok := <-s.queue:
				if !ok {
					break more
				}
				batch = append(batch, next)
			default:
				break more
			}
		}
		s.insert(batch)
		for _, it := range batch {
			if it.done != nil {
				close(it.done)
			}
		}
	}
}

func (s *Store) insert(batch []item) {
	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		slog.Warn("recording activity", "err", err)
		return
	}
	for _, it := range batch {
		e := it.entry
		if e == nil {
			continue
		}
		var dedupe any
		if e.Dedupe != "" {
			dedupe = e.Dedupe
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO activity (at, kind, agent_id, agent_name, thread_id, actor, title, outcome, duration_ms, detail, dedupe)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
			e.At, e.Kind, e.AgentID, e.AgentName, e.ThreadID, e.Actor, e.Title, e.Outcome, e.DurationMs, string(e.Detail), dedupe); err != nil {
			slog.Warn("recording activity", "kind", e.Kind, "err", err)
		}
	}
	if err := tx.Commit(); err != nil {
		slog.Warn("recording activity", "err", err)
	}
}

// prune removes entries past their retention, at the start and then daily.
func (s *Store) prune() {
	defer s.wg.Done()
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		if n, err := s.Prune(s.ctx); err != nil {
			if s.ctx.Err() != nil {
				return
			}
			slog.Warn("pruning the activity log", "err", err)
		} else if n > 0 {
			slog.Info("pruned the activity log", "entries", n)
		}
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Prune removes entries older than the retention and says how many.
func (s *Store) Prune(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM activity WHERE at < ?`, s.now().Add(-Retention).UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Query filters a list. Empty fields don't filter.
type Query struct {
	Agent   string
	Thread  string
	Kinds   []string
	Outcome []string
	// Text matches the title, the actor, the agent's name and the detail, ignoring case.
	Text string
	// Since: only entries at or after this time (Unix ms).
	Since int64
	// Before: the cursor of the last entry of the previous page (see ParseCursor).
	Before string
	Limit  int
}

// Cursor names a place in the list: entries are newest first by time, then by ID.
func Cursor(e *Entry) string { return strconv.FormatInt(e.At, 10) + "." + strconv.FormatInt(e.ID, 10) }

// ParseCursor reads a cursor: "<at>.<id>", or just a time (Unix ms: entries before it).
func ParseCursor(c string) (at, id int64, ok bool) {
	if c == "" {
		return 0, 0, false
	}
	a, b, hasID := strings.Cut(c, ".")
	at, err := strconv.ParseInt(a, 10, 64)
	if err != nil || at < 0 {
		return 0, 0, false
	}
	if !hasID {
		return at, 0, true
	}
	id, err = strconv.ParseInt(b, 10, 64)
	if err != nil || id < 0 {
		return 0, 0, false
	}
	return at, id, true
}

func (q Query) where() (string, []any) {
	var conds []string
	var args []any
	if q.Agent != "" {
		conds, args = append(conds, "agent_id = ?"), append(args, q.Agent)
	}
	if q.Thread != "" {
		conds, args = append(conds, "thread_id = ?"), append(args, q.Thread)
	}
	in := func(column string, values []string) {
		if len(values) == 0 {
			return
		}
		marks := strings.TrimSuffix(strings.Repeat("?,", len(values)), ",")
		conds = append(conds, column+" IN ("+marks+")")
		for _, v := range values {
			args = append(args, v)
		}
	}
	in("kind", q.Kinds)
	in("outcome", q.Outcome)
	if q.Since > 0 {
		conds, args = append(conds, "at >= ?"), append(args, q.Since)
	}
	if text := strings.TrimSpace(q.Text); text != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(text) + "%"
		conds = append(conds, `(title LIKE ? ESCAPE '\' OR actor LIKE ? ESCAPE '\' OR agent_name LIKE ? ESCAPE '\' OR detail LIKE ? ESCAPE '\')`)
		args = append(args, like, like, like, like)
	}
	if at, id, ok := ParseCursor(q.Before); ok {
		if id == 0 {
			conds, args = append(conds, "at < ?"), append(args, at)
		} else {
			conds, args = append(conds, "(at < ? OR (at = ? AND id < ?))"), append(args, at, at, id)
		}
	}
	if len(conds) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

// List reads a page, newest first, and the cursor for the next one ("" at the end).
func (s *Store) List(ctx context.Context, q Query) ([]*Entry, string, error) {
	s.Flush()
	limit := q.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	limit = min(limit, MaxLimit)
	where, args := q.where()
	rows, err := s.db.QueryContext(ctx, `SELECT id, at, kind, agent_id, agent_name, thread_id, actor, title, outcome, duration_ms, detail FROM activity`+where+
		` ORDER BY at DESC, id DESC LIMIT ?`, append(args, limit+1)...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []*Entry{}
	for rows.Next() {
		var e Entry
		var duration sql.NullInt64
		var detail string
		if err := rows.Scan(&e.ID, &e.At, &e.Kind, &e.AgentID, &e.AgentName, &e.ThreadID, &e.Actor, &e.Title, &e.Outcome, &duration, &detail); err != nil {
			return nil, "", err
		}
		if duration.Valid {
			e.DurationMs = &duration.Int64
		}
		e.Detail = json.RawMessage(detail)
		out = append(out, &e)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) > limit {
		out = out[:limit]
		next = Cursor(out[len(out)-1])
	}
	return out, next, nil
}

// CSVHeader is the export's first row.
var CSVHeader = []string{"time", "kind", "agent", "agent_id", "thread_id", "actor", "title", "outcome", "duration_ms", "detail"}

// WriteCSV writes every entry the query matches (its Before and Limit are ignored), newest first. It reads page by
// page: a page's rows are closed before it writes, so a slow reader never holds app.db's only connection.
func (s *Store) WriteCSV(ctx context.Context, w io.Writer, q Query) error {
	cw := csv.NewWriter(w)
	if err := cw.Write(CSVHeader); err != nil {
		return err
	}
	q.Limit = MaxLimit
	q.Before = ""
	written := 0
	for {
		page, next, err := s.List(ctx, q)
		if err != nil {
			return err
		}
		for _, e := range page {
			duration := ""
			if e.DurationMs != nil {
				duration = strconv.FormatInt(*e.DurationMs, 10)
			}
			row := []string{time.UnixMilli(e.At).UTC().Format("2006-01-02T15:04:05.000Z"), e.Kind, e.AgentName, e.AgentID, e.ThreadID,
				e.Actor, e.Title, e.Outcome, duration, string(e.Detail)}
			for i := range row {
				row[i] = csvSafe(row[i])
			}
			if err := cw.Write(row); err != nil {
				return err
			}
		}
		cw.Flush()
		if err := cw.Error(); err != nil {
			return err
		}
		written += len(page)
		if next == "" || written >= maxExport || ctx.Err() != nil {
			return ctx.Err()
		}
		q.Before = next
	}
}

// csvSafe keeps a spreadsheet from running a cell as a formula: text that starts with =, +, -, @, a tab or a
// carriage return gets an apostrophe in front (what Excel and Sheets show as plain text).
func csvSafe(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

// ValidKinds reports whether every kind is one the log uses.
func ValidKinds(kinds []string) bool {
	for _, k := range kinds {
		found := false
		for _, known := range Kinds {
			found = found || k == known
		}
		if !found {
			return false
		}
	}
	return true
}

// scrub redacts the free text inside a decoded value: a credential pasted into a command or a note is not only a value
// whose key names one (the log outlives the conversation, and can be exported).
func scrub(v any) any {
	switch v := v.(type) {
	case string:
		return agents.RedactText(v)
	case []any:
		for i := range v {
			v[i] = scrub(v[i])
		}
		return v
	case map[string]any:
		for k := range v {
			v[k] = scrub(v[k])
		}
		return v
	}
	return v
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

// ToolApproval is what the runtime says of a call's approval.
type ToolApproval struct {
	// Status: approved, denied, timed_out or cancelled.
	Status string `json:"status"`
	// By: who decided ("" for a time-out or cancellation).
	By string `json:"by,omitempty"`
	// Source: what made it ask (a built-in rule, one of the person's rules, the profile, fast judgments).
	Source string `json:"source,omitempty"`
	// WaitedMs: from the request to the decision.
	WaitedMs *int64 `json:"waitedMs,omitempty"`
}

// ToolItem is one tool call as a runtime reports it when it ends (POST /activity).
type ToolItem struct {
	// EntryID is the call's result in the agent's storage: it names the call even where providers repeat call IDs.
	EntryID string `json:"entryId"`
	CallID  string `json:"callId"`
	// ThreadID: the thread whose run made the call ("" for a conversation no thread owns).
	ThreadID  string          `json:"threadId"`
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	// Outcome: ok, error, denied (a rule or a person refused it) or declined (asked, and nobody decided).
	Outcome    string        `json:"outcome"`
	DurationMs *int64        `json:"durationMs"`
	EndedAt    int64         `json:"endedAt"`
	Approval   *ToolApproval `json:"approval"`
	// Error: what the model was told when the call failed or was refused (short).
	Error string `json:"error"`
}

// MaxToolBatch is how many items one report may carry; the rest are ignored.
const MaxToolBatch = 200

var toolOutcomes = map[string]bool{"ok": true, "error": true, "denied": true, "declined": true}

// RecordTools records a runtime's report. The runtime is not trusted to redact: arguments and errors are redacted
// again here (internal/agents/redact.go, the Go side of runtime/src/lib/redact.ts). It answers how many it took.
func (s *Store) RecordTools(agentID string, items []ToolItem) int {
	if len(items) > MaxToolBatch {
		items = items[:MaxToolBatch]
	}
	n := 0
	for _, it := range items {
		if it.Tool == "" || len(it.Tool) > maxTitle || !toolOutcomes[it.Outcome] || (it.EntryID == "" && it.CallID == "") {
			continue
		}
		detail := map[string]any{"callId": clip(it.CallID, 200)}
		var args any
		if len(it.Arguments) > 0 && len(it.Arguments) <= 64<<10 && json.Unmarshal(it.Arguments, &args) == nil {
			detail["arguments"] = scrub(agents.RedactValue(args))
		}
		if it.Error != "" {
			detail["error"] = clip(agents.RedactText(oneLine(it.Error)), 300)
		}
		if a := it.Approval; a != nil && a.Status != "" {
			ap := map[string]any{"status": clip(a.Status, 20)}
			if a.By != "" {
				ap["by"] = clip(oneLine(a.By), maxActor)
			}
			if a.Source != "" {
				ap["source"] = clip(a.Source, 20)
			}
			if a.WaitedMs != nil && *a.WaitedMs >= 0 {
				ap["waitedMs"] = *a.WaitedMs
			}
			detail["approval"] = ap
		}
		key := it.EntryID
		if key == "" {
			key = it.ThreadID + "/" + it.CallID + "/" + strconv.FormatInt(it.EndedAt, 10)
		}
		var duration *int64
		if it.DurationMs != nil && *it.DurationMs >= 0 {
			duration = it.DurationMs
		}
		at := it.EndedAt
		if now := s.now().UnixMilli(); at <= 0 || at > now+60_000 {
			at = now
		}
		thread := it.ThreadID
		if len(thread) > 64 {
			thread = ""
		}
		s.Record(Entry{At: at, Kind: KindTool, AgentID: agentID, ThreadID: thread, Title: it.Tool, Outcome: it.Outcome, DurationMs: duration,
			Detail: Detail(detail), Dedupe: fmt.Sprintf("tool:%s:%s", agentID, key)})
		n++
	}
	return n
}
