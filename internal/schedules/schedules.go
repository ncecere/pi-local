// Package schedules sends agents messages at set times: a person's schedules (made in the app) and an agent's own
// (its schedule tools, through the gateway). Each fire sends the message as a "trigger" with the fire's ID as the
// request ID (so a retried fire is never answered twice), and the run is finished when the agent's reply ends.
package schedules

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/robfig/cron/v3"

	"github.com/ncecere/pi-local/internal/threads"
)

// Limits on schedules an agent makes for itself.
const (
	MaxPerAgent      = 20
	MinInterval      = 5 * time.Minute
	MaxRunsPerDay    = 300
	MaxAhead         = 366 * 24 * time.Hour
	PauseAfter       = 5 // consecutive failed fires
	maxMessageChars  = 32_000
	missedGrace      = 2 * time.Minute
	maxNameChars     = 80
	defaultCheckTick = 30 * time.Second
)

// Schedule is a schedule as the UI (and, in its own shape, an agent) sees it.
type Schedule struct {
	ID             string  `json:"id"`
	AgentID        string  `json:"agentId"`
	AgentName      string  `json:"agentName"`
	Name           string  `json:"name"`
	Once           bool    `json:"once"`
	At             *int64  `json:"at"`
	Cron           *string `json:"cron"`
	Timezone       string  `json:"timezone"`
	Message        string  `json:"message"`
	ThreadMode     string  `json:"threadMode"`
	ThreadID       *string `json:"threadId"`
	OriginThreadID *string `json:"originThreadId"`
	MadeBy         string  `json:"madeBy"`
	MissedPolicy   string  `json:"missedPolicy"`
	Paused         bool    `json:"paused"`
	PausedReason   *string `json:"pausedReason"`
	NextFireAt     *int64  `json:"nextFireAt"`
	LastFireAt     *int64  `json:"lastFireAt"`
	LastRun        *Run    `json:"lastRun"`
	CreatedAt      int64   `json:"createdAt"`
}

// Run is one fire.
type Run struct {
	ID         string  `json:"id"`
	ScheduleID string  `json:"scheduleId"`
	ThreadID   string  `json:"threadId"`
	FiredAt    int64   `json:"firedAt"`
	Status     string  `json:"status"`
	Error      *string `json:"error"`
	FinishedAt *int64  `json:"finishedAt"`
}

// Input is a schedule to make, or changes to one.
type Input struct {
	Name         *string `json:"name"`
	At           *string `json:"at"` // ISO 8601 (once)
	Cron         *string `json:"cron"`
	Timezone     *string `json:"timezone"`
	Message      *string `json:"message"`
	ThreadMode   *string `json:"threadMode"` // new or this
	ThreadID     *string `json:"threadId"`
	MissedPolicy *string `json:"missedPolicy"`
	Paused       *bool   `json:"paused"`
	// AgentID moves a schedule to another agent (Update, from the app only): its runs then start new conversations
	// there, since the old agent's conversation isn't the new one's.
	AgentID *string `json:"agentId"`
}

// Error is a refusal for people (or an agent's model).
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func bad(code, format string, args ...any) error {
	return &Error{Status: http.StatusBadRequest, Code: code, Message: fmt.Sprintf(format, args...)}
}

// ErrNotFound: no such schedule.
var ErrNotFound = &Error{Status: http.StatusNotFound, Code: "not_found", Message: "Schedule not found"}

// Runtimes reaches agents.
type Runtimes interface {
	Call(ctx context.Context, id, method, pathAndQuery string, body []byte, header http.Header) (*http.Response, error)
}

// Agents tells about agents.
type Agents interface {
	Exists(id string) bool
	NameOf(id string) string
}

// Store keeps schedules and fires them.
type Store struct {
	db       *sql.DB
	runtimes Runtimes
	agents   Agents
	index    *threads.Index
	// OnChange is told after a schedule changes (nil: deleted); OnRunEnd after a run finishes.
	OnChange func(id string, s *Schedule)
	OnRunEnd func(s *Schedule, run *Run)
	// Budget, when set, says whether the agent may take new work: an error (over its budget) refuses it. A refused
	// "Run now" is 402 over_budget; a refused scheduled fire is a failed run saying why, which doesn't count toward
	// pausing the schedule (next month it runs again).
	Budget func(ctx context.Context, agentID string) error

	now    func() time.Time
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	kick   chan struct{}
	parser cron.Parser
}

// New makes the store; Start begins firing.
func New(db *sql.DB, runtimes Runtimes, agents Agents, index *threads.Index) *Store {
	ctx, cancel := context.WithCancel(context.Background())
	return &Store{db: db, runtimes: runtimes, agents: agents, index: index, now: time.Now, ctx: ctx, cancel: cancel,
		kick: make(chan struct{}, 1), OnChange: func(string, *Schedule) {}, OnRunEnd: func(*Schedule, *Run) {},
		parser: cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)}
}

// Start applies each schedule's missed-fire policy (the app was closed) and starts the loop.
func (s *Store) Start() {
	s.catchUp()
	s.wg.Add(1)
	go s.loop()
}

// Close stops firing.
func (s *Store) Close() {
	s.cancel()
	s.wg.Wait()
}

func newID(prefix string) string {
	b := make([]byte, 10)
	rand.Read(b)
	return prefix + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b))
}

const cols = `id, agent_id, name, once, at, cron, timezone, message, thread_mode, thread_id, origin_thread_id, made_by, missed_policy, paused, paused_reason, next_fire_at, last_fire_at, created_at`

func (s *Store) scan(row interface{ Scan(...any) error }) (*Schedule, error) {
	var sc Schedule
	var once, paused int
	var at, next, last sql.NullInt64
	var cronExpr, thread, origin, reason sql.NullString
	if err := row.Scan(&sc.ID, &sc.AgentID, &sc.Name, &once, &at, &cronExpr, &sc.Timezone, &sc.Message, &sc.ThreadMode, &thread, &origin, &sc.MadeBy, &sc.MissedPolicy, &paused, &reason, &next, &last, &sc.CreatedAt); err != nil {
		return nil, err
	}
	sc.Once, sc.Paused = once != 0, paused != 0
	ip := func(n sql.NullInt64) *int64 {
		if n.Valid {
			v := n.Int64
			return &v
		}
		return nil
	}
	sp := func(n sql.NullString) *string {
		if n.Valid {
			v := n.String
			return &v
		}
		return nil
	}
	sc.At, sc.NextFireAt, sc.LastFireAt = ip(at), ip(next), ip(last)
	sc.Cron, sc.ThreadID, sc.OriginThreadID, sc.PausedReason = sp(cronExpr), sp(thread), sp(origin), sp(reason)
	return &sc, nil
}

func (s *Store) list(ctx context.Context, where string, args ...any) ([]*Schedule, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+cols+` FROM schedules `+where, args...)
	if err != nil {
		return nil, err
	}
	var out []*Schedule
	for rows.Next() {
		sc, err := s.scan(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, sc)
	}
	rows.Close()
	// Names and last runs after the rows are closed (app.db has one connection).
	for _, sc := range out {
		sc.AgentName = s.agents.NameOf(sc.AgentID)
		if runs, err := s.Runs(ctx, sc.ID, 1); err == nil && len(runs) > 0 {
			sc.LastRun = runs[0]
		}
	}
	if out == nil {
		out = []*Schedule{}
	}
	return out, rows.Err()
}

// List returns every schedule (agentID "": of every agent), next to fire first.
func (s *Store) List(ctx context.Context, agentID string) ([]*Schedule, error) {
	if agentID == "" {
		return s.list(ctx, `ORDER BY next_fire_at IS NULL, next_fire_at, created_at`)
	}
	return s.list(ctx, `WHERE agent_id = ? ORDER BY next_fire_at IS NULL, next_fire_at, created_at`, agentID)
}

// Get returns one schedule.
func (s *Store) Get(ctx context.Context, id string) (*Schedule, error) {
	list, err := s.list(ctx, `WHERE id = ?`, id)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, ErrNotFound
	}
	return list[0], nil
}

// Runs lists a schedule's latest runs.
func (s *Store) Runs(ctx context.Context, scheduleID string, limit int) ([]*Run, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, schedule_id, thread_id, fired_at, status, error, finished_at FROM schedule_runs WHERE schedule_id = ? ORDER BY fired_at DESC LIMIT ?`, scheduleID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Run{}
	for rows.Next() {
		var r Run
		var e sql.NullString
		var fin sql.NullInt64
		if err := rows.Scan(&r.ID, &r.ScheduleID, &r.ThreadID, &r.FiredAt, &r.Status, &e, &fin); err != nil {
			return nil, err
		}
		if e.Valid {
			r.Error = &e.String
		}
		if fin.Valid {
			r.FinishedAt = &fin.Int64
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// --- times ------------------------------------------------------------------------------------------------------

func (s *Store) location(tz string) (*time.Location, error) {
	if tz == "" {
		tz = "UTC"
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, bad("invalid_timezone", "Unknown time zone %q (use an IANA name such as Europe/Paris).", tz)
	}
	return loc, nil
}

// parseAt reads an ISO 8601 time; without an offset it is in loc.
func parseAt(raw string, loc *time.Location) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05Z07:00", "2006-01-02T15:04Z07:00"} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t, nil
		}
	}
	for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02 15:04"} {
		if t, err := time.ParseInLocation(layout, raw, loc); err == nil {
			return t, nil
		}
	}
	return time.Time{}, bad("invalid_time", "%q isn't a date and time (use 2026-10-21T09:00).", raw)
}

// next is a recurring schedule's next fire after t.
func (s *Store) next(expr, tz string, after time.Time) (time.Time, error) {
	loc, err := s.location(tz)
	if err != nil {
		return time.Time{}, err
	}
	sched, err := s.parser.Parse(expr)
	if err != nil {
		return time.Time{}, bad("invalid_cron", "%q isn't a cron expression (five fields: minute hour day month weekday, or @daily).", expr)
	}
	n := sched.Next(after.In(loc))
	if n.IsZero() {
		return time.Time{}, bad("invalid_cron", "%q never fires.", expr)
	}
	return n, nil
}

// --- making and changing ----------------------------------------------------------------------------------------

type draft struct {
	name, cronExpr, tz, message, threadMode, threadID, missed string
	at                                                        *time.Time
	paused                                                    bool
}

func (s *Store) build(d *draft) (next *time.Time, err error) {
	d.name = strings.TrimSpace(d.name)
	d.message = strings.TrimSpace(d.message)
	if d.message == "" || utf8.RuneCountInString(d.message) > maxMessageChars {
		return nil, bad("invalid_message", "The message is 1 to 32,000 characters.")
	}
	if d.name == "" {
		d.name = strings.SplitN(d.message, "\n", 2)[0]
	}
	if r := []rune(d.name); len(r) > maxNameChars {
		d.name = string(r[:maxNameChars-1]) + "…"
	}
	if d.threadMode != "new" && d.threadMode != "this" {
		return nil, bad("invalid_thread_mode", "A schedule fires in a new conversation each time (new) or in one conversation (this).")
	}
	if d.threadMode == "this" && d.threadID == "" {
		return nil, bad("invalid_thread_mode", "Name the conversation it fires in.")
	}
	if d.missed != "skip" && d.missed != "run_once" {
		return nil, bad("invalid_missed_policy", "After the app was closed a missed fire is skipped (skip) or run once (run_once).")
	}
	if _, err := s.location(d.tz); err != nil {
		return nil, err
	}
	now := s.now()
	switch {
	case d.at != nil && d.cronExpr != "":
		return nil, bad("invalid_when", "A schedule is a one-time time (at) or a cron expression, not both.")
	case d.at != nil:
		if d.at.Before(now.Add(-time.Minute)) {
			return nil, bad("invalid_time", "That time has passed.")
		}
		if d.at.After(now.Add(MaxAhead)) {
			return nil, bad("invalid_time", "At most a year ahead.")
		}
		t := *d.at
		return &t, nil
	case d.cronExpr != "":
		n, err := s.next(d.cronExpr, d.tz, now)
		if err != nil {
			return nil, err
		}
		return &n, nil
	default:
		return nil, bad("invalid_when", "Say when: a date and time, or a cron expression.")
	}
}

func nullable[T comparable](v T) any {
	var zero T
	if v == zero {
		return nil
	}
	return v
}

// Create makes a schedule for an agent (madeBy "user" or "agent"; an agent's own are limited).
func (s *Store) Create(ctx context.Context, agentID, madeBy, originThread string, in Input) (*Schedule, error) {
	if !s.agents.Exists(agentID) {
		return nil, ErrNotFound
	}
	d := draft{tz: "UTC", threadMode: "new", missed: "run_once"}
	if err := s.apply(&d, in); err != nil {
		return nil, err
	}
	next, err := s.build(&d)
	if err != nil {
		return nil, err
	}
	if madeBy == "agent" {
		if err := s.agentLimits(ctx, agentID, d); err != nil {
			return nil, err
		}
	}
	id := newID("sc_")
	now := s.now().UnixMilli()
	var at any
	if d.at != nil {
		at = d.at.UnixMilli()
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO schedules (id, agent_id, name, once, at, cron, timezone, message, thread_mode, thread_id, origin_thread_id, made_by, missed_policy, paused, next_fire_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, agentID, d.name, boolInt(d.at != nil), at, nullable(d.cronExpr), d.tz, d.message, d.threadMode, nullable(d.threadID),
		nullable(originThread), madeBy, d.missed, boolInt(d.paused), next.UnixMilli(), now, now)
	if err != nil {
		return nil, err
	}
	s.poke()
	sc, err := s.Get(ctx, id)
	if err == nil {
		s.OnChange(id, sc)
	}
	return sc, err
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *Store) apply(d *draft, in Input) error {
	if in.Name != nil {
		d.name = *in.Name
	}
	if in.Timezone != nil && *in.Timezone != "" {
		d.tz = *in.Timezone
	}
	if in.Message != nil {
		d.message = *in.Message
	}
	if in.ThreadMode != nil {
		d.threadMode = *in.ThreadMode
	}
	if in.ThreadID != nil {
		d.threadID = *in.ThreadID
	}
	if in.MissedPolicy != nil {
		d.missed = *in.MissedPolicy
	}
	if in.Paused != nil {
		d.paused = *in.Paused
	}
	if in.Cron != nil {
		d.cronExpr = strings.TrimSpace(*in.Cron)
		if d.cronExpr != "" {
			d.at = nil
		}
	}
	if in.At != nil {
		if strings.TrimSpace(*in.At) == "" {
			d.at = nil
		} else {
			loc, err := s.location(d.tz)
			if err != nil {
				return err
			}
			t, err := parseAt(*in.At, loc)
			if err != nil {
				return err
			}
			d.at, d.cronExpr = &t, ""
		}
	}
	return nil
}

// agentLimits keeps an agent's own schedules within bounds: how many, how often, how many runs a day.
func (s *Store) agentLimits(ctx context.Context, agentID string, d draft) error {
	var active, runs int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schedules WHERE agent_id = ? AND made_by = 'agent' AND next_fire_at IS NOT NULL`, agentID).Scan(&active)
	if active >= MaxPerAgent {
		return &Error{Status: http.StatusConflict, Code: "limit", Message: fmt.Sprintf("You already have %d schedules; cancel one first (list_schedules).", active)}
	}
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schedule_runs WHERE agent_id = ? AND fired_at > ?`, agentID, s.now().Add(-24*time.Hour).UnixMilli()).Scan(&runs)
	if runs >= MaxRunsPerDay {
		return &Error{Status: http.StatusConflict, Code: "limit", Message: "Your schedules have run too often today."}
	}
	if d.cronExpr != "" {
		first, err := s.next(d.cronExpr, d.tz, s.now())
		if err != nil {
			return err
		}
		second, err := s.next(d.cronExpr, d.tz, first)
		if err != nil {
			return err
		}
		if second.Sub(first) < MinInterval {
			return bad("too_often", "A schedule may fire at most every %d minutes.", int(MinInterval.Minutes()))
		}
	}
	return nil
}

// Update changes a schedule.
func (s *Store) Update(ctx context.Context, id string, in Input) (*Schedule, error) {
	cur, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	d := draft{name: cur.Name, tz: cur.Timezone, message: cur.Message, threadMode: cur.ThreadMode, missed: cur.MissedPolicy, paused: cur.Paused}
	if cur.Cron != nil {
		d.cronExpr = *cur.Cron
	}
	if cur.ThreadID != nil {
		d.threadID = *cur.ThreadID
	}
	if cur.At != nil {
		t := time.UnixMilli(*cur.At)
		d.at = &t
	}
	agentID := cur.AgentID
	if in.AgentID != nil && *in.AgentID != cur.AgentID {
		if !s.agents.Exists(*in.AgentID) {
			return nil, bad("invalid_agent", "Choose an agent that exists.")
		}
		agentID = *in.AgentID
		d.threadMode, d.threadID = "new", ""
		if in.ThreadMode != nil && *in.ThreadMode == "this" {
			in.ThreadMode, in.ThreadID = nil, nil
		}
	}
	if err := s.apply(&d, in); err != nil {
		return nil, err
	}
	// A reminder that already fired keeps no next fire unless it gets a new time.
	finished := cur.NextFireAt == nil && cur.Once && in.At == nil && in.Cron == nil
	var next *time.Time
	if !finished {
		if next, err = s.build(&d); err != nil {
			return nil, err
		}
	} else if _, err := s.build(&draft{name: d.name, tz: d.tz, message: d.message, threadMode: d.threadMode, threadID: d.threadID, missed: d.missed, cronExpr: "@daily"}); err != nil {
		return nil, err
	}
	var at, nextMs any
	if d.at != nil {
		at = d.at.UnixMilli()
	}
	if next != nil {
		nextMs = next.UnixMilli()
	}
	var reason any
	if d.paused && cur.PausedReason != nil && in.Paused == nil {
		reason = *cur.PausedReason
	}
	failures := "failures"
	if in.Paused != nil && !*in.Paused {
		failures = "0" // resumed by a person: start counting again
	}
	_, err = s.db.ExecContext(ctx, `UPDATE schedules SET agent_id = ?, name = ?, once = ?, at = ?, cron = ?, timezone = ?, message = ?, thread_mode = ?, thread_id = ?, missed_policy = ?,
		paused = ?, paused_reason = ?, next_fire_at = ?, failures = `+failures+`, updated_at = ? WHERE id = ?`,
		agentID, d.name, boolInt(d.at != nil), at, nullable(d.cronExpr), d.tz, d.message, d.threadMode, nullable(d.threadID), d.missed,
		boolInt(d.paused), reason, nextMs, s.now().UnixMilli(), id)
	if err != nil {
		return nil, err
	}
	s.poke()
	sc, err := s.Get(ctx, id)
	if err == nil {
		s.OnChange(id, sc)
	}
	return sc, err
}

// Delete removes a schedule (agentID, when given, must own it).
func (s *Store) Delete(ctx context.Context, id, agentID string) (*Schedule, error) {
	sc, err := s.Get(ctx, id)
	if err != nil || (agentID != "" && sc.AgentID != agentID) {
		return nil, ErrNotFound
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM schedules WHERE id = ?`, id); err != nil {
		return nil, err
	}
	s.OnChange(id, nil)
	return sc, nil
}

// ForgetAgent removes a deleted agent's schedules.
func (s *Store) ForgetAgent(ctx context.Context, agentID string) {
	list, _ := s.List(ctx, agentID)
	for _, sc := range list {
		s.Delete(ctx, sc.ID, "")
	}
}

// --- firing -----------------------------------------------------------------------------------------------------

func (s *Store) poke() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

func (s *Store) loop() {
	defer s.wg.Done()
	for {
		wait := defaultCheckTick
		var next sql.NullInt64
		s.db.QueryRowContext(s.ctx, `SELECT MIN(next_fire_at) FROM schedules WHERE paused = 0 AND next_fire_at IS NOT NULL`).Scan(&next)
		if next.Valid {
			if d := time.Until(time.UnixMilli(next.Int64)); d < wait {
				wait = max(d, 0)
			}
		}
		select {
		case <-s.ctx.Done():
			return
		case <-time.After(wait):
		case <-s.kick:
		}
		s.fireDue()
	}
}

func (s *Store) fireDue() {
	due, err := s.list(s.ctx, `WHERE paused = 0 AND next_fire_at IS NOT NULL AND next_fire_at <= ?`, s.now().UnixMilli())
	if err != nil {
		return
	}
	for _, sc := range due {
		s.fire(sc, true)
	}
}

// catchUp handles fires missed while the app was closed: skipped, or run once now (the schedule's policy).
func (s *Store) catchUp() {
	cutoff := s.now().Add(-missedGrace).UnixMilli()
	missed, err := s.list(context.Background(), `WHERE paused = 0 AND next_fire_at IS NOT NULL AND next_fire_at < ?`, cutoff)
	if err != nil {
		return
	}
	for _, sc := range missed {
		if sc.MissedPolicy == "run_once" {
			s.fire(sc, true)
			continue
		}
		s.advance(sc)
		slog.Info("skipping a schedule's fire missed while the app was closed", "schedule", sc.ID)
	}
}

// advance moves a schedule to its next fire (none for a reminder).
func (s *Store) advance(sc *Schedule) {
	var next any
	if !sc.Once && sc.Cron != nil {
		if n, err := s.next(*sc.Cron, sc.Timezone, s.now()); err == nil {
			next = n.UnixMilli()
		}
	}
	s.db.ExecContext(context.Background(), `UPDATE schedules SET next_fire_at = ?, updated_at = ? WHERE id = ?`, next, s.now().UnixMilli(), sc.ID)
	if updated, err := s.Get(context.Background(), sc.ID); err == nil {
		s.OnChange(sc.ID, updated)
	}
}

// Fire runs a schedule now (a person's "Run now", or its time came): it sends the message and advances it.
func (s *Store) Fire(ctx context.Context, id string) (*Run, error) {
	sc, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if s.Budget != nil {
		if err := s.Budget(ctx, sc.AgentID); err != nil {
			return nil, &Error{Status: http.StatusPaymentRequired, Code: "over_budget", Message: err.Error()}
		}
	}
	return s.fire(sc, false), nil
}

func (s *Store) fire(sc *Schedule, scheduled bool) *Run {
	ctx := context.Background()
	if scheduled {
		s.advance(sc)
	}
	if !s.agents.Exists(sc.AgentID) {
		return nil
	}
	runID := newID("fire_")
	thread := "sched-" + strings.TrimPrefix(runID, "fire_")
	if sc.ThreadMode == "this" && sc.ThreadID != nil {
		thread = *sc.ThreadID
	}
	now := s.now().UnixMilli()
	s.db.ExecContext(ctx, `INSERT INTO schedule_runs (id, schedule_id, agent_id, thread_id, fired_at) VALUES (?, ?, ?, ?, ?)`, runID, sc.ID, sc.AgentID, thread, now)
	s.db.ExecContext(ctx, `UPDATE schedules SET last_fire_at = ? WHERE id = ?`, now, sc.ID)
	run := &Run{ID: runID, ScheduleID: sc.ID, ThreadID: thread, FiredAt: now, Status: "running"}

	if s.Budget != nil {
		if err := s.Budget(ctx, sc.AgentID); err != nil {
			s.finish(sc.AgentID, thread, runID, "failed", err.Error())
			run.Status = "failed"
			if updated, err := s.Get(ctx, sc.ID); err == nil {
				s.OnChange(sc.ID, updated)
			}
			return run
		}
	}
	sendErr := s.send(ctx, sc, thread, runID)
	if sendErr != nil {
		s.finish(sc.AgentID, thread, runID, "failed", sendErr.Error())
		var failures int
		s.db.QueryRowContext(ctx, `UPDATE schedules SET failures = failures + 1 WHERE id = ? RETURNING failures`, sc.ID).Scan(&failures)
		if failures >= PauseAfter {
			s.db.ExecContext(ctx, `UPDATE schedules SET paused = 1, paused_reason = ? WHERE id = ?`,
				fmt.Sprintf("Paused after %d failed runs in a row: %s", failures, sendErr.Error()), sc.ID)
		}
		run.Status = "failed"
	} else {
		s.db.ExecContext(ctx, `UPDATE schedules SET failures = 0 WHERE id = ?`, sc.ID)
	}
	if updated, err := s.Get(ctx, sc.ID); err == nil {
		s.OnChange(sc.ID, updated)
	}
	return run
}

func (s *Store) send(ctx context.Context, sc *Schedule, thread, runID string) error {
	if _, err := s.index.Sending(ctx, sc.AgentID, thread, sc.Message, nil); err != nil {
		return err
	}
	defer s.index.Sent(sc.AgentID, thread)
	body, _ := json.Marshal(map[string]any{
		"text": sc.Message, "requestId": strings.ReplaceAll(runID, "_", "-"), "announceAuthor": true,
		"author": map[string]string{"kind": "trigger", "id": sc.ID, "name": sc.Name},
	})
	callCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	resp, err := s.runtimes.Call(callCtx, sc.AgentID, http.MethodPost, "/threads/"+thread+"/messages", body, http.Header{"Content-Type": {"application/json"}})
	if err != nil {
		return fmt.Errorf("%s could not be reached: %v", s.agents.NameOf(sc.AgentID), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		var e struct {
			Error struct{ Message string } `json:"error"`
		}
		json.Unmarshal(raw, &e)
		return errors.New("the agent refused the message: " + e.Error.Message)
	}
	return nil
}

func (s *Store) finish(agentID, thread, runID, status, errText string) {
	var e any
	if errText != "" {
		e = errText
	}
	res, err := s.db.ExecContext(context.Background(), `UPDATE schedule_runs SET status = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
		status, e, s.now().UnixMilli(), runID)
	if err != nil {
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return
	}
	var scheduleID string
	s.db.QueryRow(`SELECT schedule_id FROM schedule_runs WHERE id = ?`, runID).Scan(&scheduleID)
	sc, err := s.Get(context.Background(), scheduleID)
	if err != nil {
		return
	}
	runs, _ := s.Runs(context.Background(), scheduleID, 1)
	if len(runs) > 0 {
		s.OnRunEnd(sc, runs[0])
	}
}

// ThreadChanged finishes the runs in a thread whose reply just ended (from the thread index's changes).
func (s *Store) ThreadChanged(agentID string, t *threads.Thread) {
	if t == nil || t.Busy {
		return
	}
	rows, err := s.db.Query(`SELECT id FROM schedule_runs WHERE agent_id = ? AND thread_id = ? AND status = 'running'`, agentID, t.ThreadID)
	if err != nil {
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		if t.LastError != nil && *t.LastError != "" {
			s.finish(agentID, t.ThreadID, id, "failed", *t.LastError)
		} else {
			s.finish(agentID, t.ThreadID, id, "done", "")
		}
	}
}
