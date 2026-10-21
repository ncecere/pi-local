// Package asks carries out one agent asking another (ask_agent, docs/api.md "Teams and agents asking agents"): it
// checks who may ask whom, sends the message to the asked agent's own conversation as the asking agent, follows the
// reply, and hands it back to the waiting tool call. Asks are kept in app.db, so one in flight when the app quits
// goes on when it starts again.
package asks

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
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

	"github.com/ncecere/pi-local/internal/threads"
)

// Limits on asking.
const (
	MaxDepth        = 3                // agents in a chain of asks, the first asker included
	MaxPerWindow    = 20               // asks from one conversation within Window
	Window          = 10 * time.Minute //
	AnswerTimeout   = 30 * time.Minute // an ask with no reply by then fails
	maxResultChars  = 32_000
	maxMessageChars = 32_000
	pollEvery       = 500 * time.Millisecond
)

// Runtimes reaches agents' runtimes (the supervisor).
type Runtimes interface {
	Call(ctx context.Context, id, method, pathAndQuery string, body []byte, header http.Header) (*http.Response, error)
}

// Agents names agents and tells whether they exist.
type Agents interface {
	Exists(id string) bool
	NameOf(id string) string
	Touch(ctx context.Context, id string)
}

// Permissions says who may ask whom.
type Permissions interface {
	MayCall(ctx context.Context, caller, target string) bool
	CallableIDs(ctx context.Context, caller string) []string
}

// Error is a refusal the asking agent's model is told.
type Error struct{ Message string }

func (e *Error) Error() string { return e.Message }

func refuse(format string, args ...any) error { return &Error{Message: fmt.Sprintf(format, args...)} }

// ErrNotFound: no such ask (for this caller).
var ErrNotFound = errors.New("ask not found")

// Request is what a runtime's ask_agent sends.
type Request struct {
	Agent        string `json:"agent"` // ID or exact name
	Message      string `json:"message"`
	Conversation string `json:"conversation"` // continue (default) or new
	ThreadID     string `json:"threadId"`     // the asking agent's thread ("" for a subagent's conversation)
	Key          string `json:"key"`          // the tool call: a replay sends the same key
}

// Started is the answer to a request.
type Started struct {
	AskID     string `json:"askId"`
	AgentID   string `json:"agentId"`
	AgentName string `json:"agentName"`
	ThreadID  string `json:"threadId"`
}

// State is an ask's progress.
type State struct {
	Status string `json:"status"` // pending, done, failed
	Text   string `json:"text,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Broker runs asks.
type Broker struct {
	db       *sql.DB
	runtimes Runtimes
	agents   Agents
	perms    Permissions
	index    *threads.Index

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu      sync.Mutex
	waiters map[string]chan struct{} // closed when an ask finishes
	running map[string]bool          // asks with a worker
	threads map[string]*sync.Mutex   // one ask at a time per asked conversation
}

// New makes the broker; Close stops its workers (their asks resume at the next start).
func New(db *sql.DB, runtimes Runtimes, agents Agents, perms Permissions, index *threads.Index) *Broker {
	ctx, cancel := context.WithCancel(context.Background())
	return &Broker{db: db, runtimes: runtimes, agents: agents, perms: perms, index: index, ctx: ctx, cancel: cancel,
		waiters: map[string]chan struct{}{}, running: map[string]bool{}, threads: map[string]*sync.Mutex{}}
}

// Close stops following asks; pending ones stay pending and resume with Resume.
func (b *Broker) Close() {
	b.cancel()
	b.wg.Wait()
}

func newID() string {
	raw := make([]byte, 10)
	rand.Read(raw)
	return "ask_" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw))
}

func shortHash(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:10]))
}

type ask struct {
	id, caller, callerThread, key, target, targetThread, message string
	chain                                                        []string
	baseline                                                     int
	status, result, errText                                      string
	created                                                      time.Time
}

func (b *Broker) load(ctx context.Context, where string, args ...any) (*ask, error) {
	var a ask
	var chain string
	var result, errText sql.NullString
	var created int64
	err := b.db.QueryRowContext(ctx, `SELECT id, caller_id, caller_thread, call_key, target_id, target_thread, message, chain, baseline, status, result, error, created_at
		FROM asks WHERE `+where, args...).Scan(&a.id, &a.caller, &a.callerThread, &a.key, &a.target, &a.targetThread, &a.message, &chain, &a.baseline, &a.status, &result, &errText, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	json.Unmarshal([]byte(chain), &a.chain)
	a.result, a.errText, a.created = result.String, errText.String, time.UnixMilli(created)
	return &a, nil
}

func (b *Broker) started(a *ask) *Started {
	return &Started{AskID: a.id, AgentID: a.target, AgentName: b.agents.NameOf(a.target), ThreadID: a.targetThread}
}

// Callable lists whom an agent may ask, with names (for list_agents).
func (b *Broker) resolveTarget(ctx context.Context, caller, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	ids := b.perms.CallableIDs(ctx, caller)
	for _, id := range ids {
		if id == ref {
			return id, nil
		}
	}
	var match []string
	for _, id := range ids {
		if strings.EqualFold(b.agents.NameOf(id), ref) {
			match = append(match, id)
		}
	}
	switch len(match) {
	case 1:
		return match[0], nil
	case 0:
		if len(ids) == 0 {
			return "", refuse("You may not ask any other agents.")
		}
		return "", refuse("You may not ask %q. Use list_agents to see whom you may ask.", ref)
	default:
		return "", refuse("Several agents are called %q; use the agent's ID from list_agents.", ref)
	}
}

// Start begins an ask (or finds the one this tool call already began).
func (b *Broker) Start(ctx context.Context, caller string, req Request) (*Started, error) {
	if req.Key == "" || len(req.Key) > 200 {
		return nil, refuse("The ask is missing its key.")
	}
	if existing, err := b.load(ctx, `caller_id = ? AND call_key = ?`, caller, req.Key); err == nil {
		b.follow(existing.id)
		return b.started(existing), nil
	} else if !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	message := strings.TrimSpace(req.Message)
	if message == "" || len([]rune(message)) > maxMessageChars {
		return nil, refuse("The message to the agent must be 1 to 32,000 characters.")
	}
	target, err := b.resolveTarget(ctx, caller, req.Agent)
	if err != nil {
		return nil, err
	}
	if !b.perms.MayCall(ctx, caller, target) {
		return nil, refuse("You may not ask %s.", b.agents.NameOf(target))
	}
	// The chain of asks that led here: the caller's own (when it was asked in this thread), plus the caller.
	var chain []string
	if req.ThreadID != "" {
		if parent, err := b.load(ctx, `target_id = ? AND target_thread = ? ORDER BY created_at DESC LIMIT 1`, caller, req.ThreadID); err == nil {
			chain = append(chain, parent.chain...)
		}
	}
	chain = append(chain, caller)
	for _, id := range chain {
		if id == target {
			return nil, refuse("%s is already part of this chain of asks (it asked, directly or not, for what you are working on). Answer from what you have instead.", b.agents.NameOf(target))
		}
	}
	if len(chain) >= MaxDepth+1 {
		return nil, refuse("Asks can go at most %d agents deep; answer from what you have.", MaxDepth)
	}
	var recent int
	b.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM asks WHERE caller_id = ? AND caller_thread = ? AND created_at > ?`,
		caller, req.ThreadID, time.Now().Add(-Window).UnixMilli()).Scan(&recent)
	if recent >= MaxPerWindow {
		return nil, refuse("You have asked other agents %d times in the last %d minutes; answer from what you have.", recent, int(Window.Minutes()))
	}
	id := newID()
	targetThread := "ask-" + shortHash(caller, req.ThreadID, target)
	if req.Conversation == "new" {
		targetThread = "ask-" + shortHash(id)
	}
	raw, _ := json.Marshal(chain)
	_, err = b.db.ExecContext(ctx, `INSERT INTO asks (id, caller_id, caller_thread, call_key, target_id, target_thread, message, chain, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT (caller_id, call_key) DO NOTHING`,
		id, caller, req.ThreadID, req.Key, target, targetThread, message, string(raw), time.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	a, err := b.load(ctx, `caller_id = ? AND call_key = ?`, caller, req.Key)
	if err != nil {
		return nil, err
	}
	b.follow(a.id)
	return b.started(a), nil
}

// Resume follows every pending ask again (at the app's start).
func (b *Broker) Resume(ctx context.Context) {
	rows, err := b.db.QueryContext(ctx, `SELECT id FROM asks WHERE status = 'pending'`)
	if err != nil {
		slog.Warn("resuming asks", "err", err)
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
		b.follow(id)
	}
}

func (b *Broker) waiter(id string) chan struct{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch, ok := b.waiters[id]
	if !ok {
		ch = make(chan struct{})
		b.waiters[id] = ch
	}
	return ch
}

// follow starts the ask's worker unless one runs.
func (b *Broker) follow(id string) {
	b.mu.Lock()
	if b.running[id] || b.ctx.Err() != nil {
		b.mu.Unlock()
		return
	}
	b.running[id] = true
	b.mu.Unlock()
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		defer func() {
			b.mu.Lock()
			delete(b.running, id)
			b.mu.Unlock()
		}()
		b.work(id)
	}()
}

func (b *Broker) threadLock(agent, thread string) *sync.Mutex {
	b.mu.Lock()
	defer b.mu.Unlock()
	key := agent + "/" + thread
	m, ok := b.threads[key]
	if !ok {
		m = &sync.Mutex{}
		b.threads[key] = m
	}
	return m
}

func (b *Broker) finish(id, status, result, errText string) {
	if len([]rune(result)) > maxResultChars {
		result = string([]rune(result)[:maxResultChars]) + "\n\n(The reply was cut here.)"
	}
	_, err := b.db.ExecContext(context.Background(), `UPDATE asks SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'pending'`,
		status, nullable(result), nullable(errText), time.Now().UnixMilli(), id)
	if err != nil {
		slog.Warn("recording an ask's outcome", "ask", id, "err", err)
	}
	b.mu.Lock()
	ch, ok := b.waiters[id]
	if !ok {
		ch = make(chan struct{})
		b.waiters[id] = ch
	}
	select {
	case <-ch:
	default:
		close(ch)
	}
	b.mu.Unlock()
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

type viewMessage struct {
	Role  string `json:"role"`
	Text  string `json:"text"`
	Error string `json:"error"`
}

type view struct {
	Busy     bool          `json:"busy"`
	Messages []viewMessage `json:"messages"`
}

// readView reads the asked conversation (nil when it doesn't exist yet).
func (b *Broker) readView(ctx context.Context, agent, thread string) (*view, error) {
	resp, err := b.runtimes.Call(ctx, agent, http.MethodGet, "/threads/"+thread, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	var out struct {
		Data view `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&out); err != nil {
		return nil, err
	}
	return &out.Data, nil
}

func users(v *view) int {
	if v == nil {
		return 0
	}
	n := 0
	for _, m := range v.Messages {
		if m.Role == "user" {
			n++
		}
	}
	return n
}

// work sends the ask's message (once its conversation is free) and follows the reply.
func (b *Broker) work(id string) {
	ctx := b.ctx
	a, err := b.load(ctx, `id = ?`, id)
	if err != nil || a.status != "pending" {
		return
	}
	if !b.agents.Exists(a.target) {
		b.finish(id, "failed", "", "that agent was deleted")
		return
	}
	lock := b.threadLock(a.target, a.targetThread)
	lock.Lock()
	defer lock.Unlock()
	deadline := a.created.Add(AnswerTimeout)

	if a.baseline < 0 {
		v, err := b.readView(ctx, a.target, a.targetThread)
		if err != nil {
			if ctx.Err() == nil {
				b.finish(id, "failed", "", fmt.Sprintf("%s could not start: %v", b.agents.NameOf(a.target), err))
			}
			return
		}
		a.baseline = users(v)
		if _, err := b.db.ExecContext(ctx, `UPDATE asks SET baseline = ? WHERE id = ?`, a.baseline, id); err != nil {
			return
		}
	}
	// The message, as the asking agent (idempotent: a resumed ask sends it again with the same request ID).
	callerName := b.agents.NameOf(a.caller)
	b.agents.Touch(ctx, a.target)
	sent := func() {}
	if _, err := b.index.Sending(ctx, a.target, a.targetThread, a.message, &threads.CalledBy{AgentID: a.caller, ThreadID: a.callerThread}); err != nil {
		slog.Warn("recording an asked thread", "ask", id, "err", err)
	} else {
		sent = func() { b.index.Sent(a.target, a.targetThread) }
	}
	body, _ := json.Marshal(map[string]any{
		"text": a.message, "requestId": strings.ReplaceAll(id, "_", "-"), "announceAuthor": true,
		"author": map[string]string{"kind": "agent", "id": a.caller, "name": callerName},
	})
	resp, err := b.runtimes.Call(ctx, a.target, http.MethodPost, "/threads/"+a.targetThread+"/messages", body, http.Header{"Content-Type": {"application/json"}})
	sent()
	if err != nil {
		if ctx.Err() == nil {
			b.finish(id, "failed", "", fmt.Sprintf("%s could not be reached: %v", b.agents.NameOf(a.target), err))
		}
		return
	}
	answer, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		var e struct {
			Error struct{ Message string } `json:"error"`
		}
		json.Unmarshal(answer, &e)
		b.finish(id, "failed", "", fmt.Sprintf("%s refused the message: %s", b.agents.NameOf(a.target), e.Error.Message))
		return
	}

	for {
		if time.Now().After(deadline) {
			b.runtimes.Call(context.Background(), a.target, http.MethodPost, "/threads/"+a.targetThread+"/stop", nil, nil)
			b.finish(id, "failed", "", fmt.Sprintf("no reply within %d minutes", int(AnswerTimeout.Minutes())))
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(pollEvery):
		}
		if done, _ := b.isFinished(ctx, id); done {
			return
		}
		v, err := b.readView(ctx, a.target, a.targetThread)
		if err != nil || v == nil {
			continue
		}
		if v.Busy || users(v) <= a.baseline || len(v.Messages) == 0 {
			continue
		}
		last := v.Messages[len(v.Messages)-1]
		if last.Role != "assistant" {
			continue
		}
		if last.Error != "" && last.Text == "" {
			b.finish(id, "failed", "", last.Error)
			return
		}
		b.finish(id, "done", last.Text, "")
		return
	}
}

func (b *Broker) isFinished(ctx context.Context, id string) (bool, error) {
	var status string
	err := b.db.QueryRowContext(ctx, `SELECT status FROM asks WHERE id = ?`, id).Scan(&status)
	return status != "pending", err
}

// Wait returns an ask's state, waiting up to `wait` for it to finish.
func (b *Broker) Wait(ctx context.Context, caller, id string, wait time.Duration) (*State, error) {
	a, err := b.load(ctx, `id = ? AND caller_id = ?`, id, caller)
	if err != nil {
		return nil, err
	}
	if a.status == "pending" {
		b.follow(id)
		select {
		case <-b.waiter(id):
		case <-time.After(wait):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if a, err = b.load(ctx, `id = ?`, id); err != nil {
			return nil, err
		}
	}
	return &State{Status: a.status, Text: a.result, Error: a.errText}, nil
}

// Stop ends an ask its caller no longer waits for, and stops the reply it started.
func (b *Broker) Stop(ctx context.Context, caller, id string) error {
	a, err := b.load(ctx, `id = ? AND caller_id = ?`, id, caller)
	if err != nil {
		return err
	}
	if a.status != "pending" {
		return nil
	}
	b.finish(id, "failed", "", "stopped: the asking agent stopped waiting")
	if resp, err := b.runtimes.Call(ctx, a.target, http.MethodPost, "/threads/"+a.targetThread+"/stop", nil, nil); err == nil {
		resp.Body.Close()
	}
	return nil
}
