// Package gateway serves what agent runtimes call back into (docs/runtime-contract.md, "Reports to the platform"),
// on a loopback port of its own, each runtime authenticated by the key it was started with (PLATFORM_KEY).
package gateway

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ncecere/pi-local/internal/approvals"
	"github.com/ncecere/pi-local/internal/asks"
	"github.com/ncecere/pi-local/internal/elicitations"
	"github.com/ncecere/pi-local/internal/judge"
	"github.com/ncecere/pi-local/internal/schedules"
	"github.com/ncecere/pi-local/internal/threads"
	"github.com/ncecere/pi-local/internal/usage"
	"github.com/ncecere/pi-local/internal/web"
)

// Keys tells which agent a runtime key belongs to.
type Keys interface {
	AgentForKey(key string) (string, bool)
}

// Threads is where thread reports go.
type Threads interface {
	Report(ctx context.Context, agentID string, s threads.Status) error
	Sync(ctx context.Context, agentID string, statuses []threads.Status, at int64) error
}

// Usage records a runtime's model usage.
type Usage interface {
	RecordUsage(ctx context.Context, agentID, model string, c usage.Counts) error
}

// Asks is one agent asking another (internal/asks).
type Asks interface {
	Peers(ctx context.Context, caller string) []Peer
	Start(ctx context.Context, caller string, req asks.Request) (*asks.Started, error)
	Wait(ctx context.Context, caller, id string, wait time.Duration) (*asks.State, error)
	Stop(ctx context.Context, caller, id string) error
}

// Peer is an agent another may ask (list_agents).
type Peer struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Kind        string `json:"kind,omitempty"`
	Via         string `json:"via"`
}

// Approvals keeps tool calls waiting for a person.
type Approvals interface {
	ReportOne(ctx context.Context, agentID string, r approvals.Report) (approvals.Answer, bool)
	Sync(ctx context.Context, agentID string, reports []approvals.Report, at int64) []approvals.Answer
}

// OAuth is MCP servers' OAuth state, which runtimes read and refresh.
type OAuth interface {
	// Uses reports whether an agent uses an MCP server ("" for the app's own probe, which may use any).
	Uses(agentID, slug string) bool
	OAuthState(slug string) (json.RawMessage, error)
	SaveOAuthState(slug string, state json.RawMessage) error
}

// Memory is an agent's memory tools and the section it sees each turn.
type Memory interface {
	Context(ctx context.Context, agentID string) (aboutYou, notes string, err error)
	Remember(ctx context.Context, agentID string, in RememberInput) (map[string]any, error)
	Recall(ctx context.Context, agentID, query string, limit int) (map[string]any, error)
	Forget(ctx context.Context, agentID, id string, present bool) error
}

// RememberInput is the remember tool's call, with what the runtime knows about the run (present: the person started
// it; a schedule or another agent didn't).
type RememberInput struct {
	About    string `json:"about"` // you | myself
	Text     string `json:"text"`
	Category string `json:"category"`
	Source   string `json:"source"` // person | inferred | outside
	Present  bool   `json:"present"`
	ThreadID string `json:"threadId"`
}

// Web is web search and page reading, for agents allowed each tool.
type Web interface {
	Allowed(agentID, tool string) bool
	Search(ctx context.Context, query string, count int) ([]web.Result, error)
	Fetch(ctx context.Context, url string, offset, maxChars int) (*web.Page, error)
}

// Handler is the gateway's routes.
type Handler struct {
	Keys      Keys
	Threads   Threads
	Usage     Usage
	Asks      Asks
	Approvals Approvals
	OAuth     OAuth
	Schedules *schedules.Store
	// Web: search and page reading for agents (nil: not offered).
	Web Web
	// Memory: what an agent knows about the person and itself (nil: not offered).
	Memory Memory
	// ModelEnv is what a runtime needs to use a model the person chose for a conversation (the same variables as its
	// own model's); nil: not offered.
	ModelEnv func(ctx context.Context, agentID, modelID string) (map[string]string, error)
	// Notify sends the person a notification from an agent (notify_person); false when rate-limited.
	Notify func(agentID, threadID, title, message string) bool
	// PickTools: fast-judgment tool preselection (nil: not offered; it answers none when off).
	PickTools func(ctx context.Context, message string, tools []judge.Tool, limit int) ([]string, error)
	// JudgeApproval: fast-judgment tightening of approvals (nil: not offered; it answers not risky when off).
	JudgeApproval func(ctx context.Context, tool string, arguments json.RawMessage) (bool, error)
	// Elicitations: MCP servers' questions to the person, relayed by the runtime (nil: not offered).
	Elicitations *elicitations.Store
	// AppKey authenticates the app's own MCP probe, for /mcp/oauth only.
	AppKey string
}

const maxBody = 4 << 20

func fail(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func ok(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"data": data})
}

func (h *Handler) agent(r *http.Request) (string, bool) {
	key, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !found {
		return "", false
	}
	return h.Keys.AgentForKey(key)
}

func decode(w http.ResponseWriter, r *http.Request, into any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(into); err != nil {
		fail(w, http.StatusBadRequest, "invalid_request", "invalid JSON")
		return false
	}
	return true
}

// ServeHTTP routes a runtime's call.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if key, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); found && h.AppKey != "" &&
		subtle.ConstantTimeCompare([]byte(key), []byte(h.AppKey)) == 1 {
		if h.OAuth != nil && strings.HasPrefix(r.URL.Path, "/mcp/oauth/") {
			h.serveOAuth(w, r, "")
			return
		}
		fail(w, http.StatusForbidden, "forbidden", "the app's key opens only the MCP sign-in state")
		return
	}
	agentID, authed := h.agent(r)
	if !authed {
		fail(w, http.StatusUnauthorized, "unauthorized", "unknown runtime key")
		return
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/threads/sync":
		var body struct {
			Threads []threads.Status `json:"threads"`
			At      int64            `json:"at"`
		}
		if !decode(w, r, &body) {
			return
		}
		if err := h.Threads.Sync(r.Context(), agentID, body.Threads, body.At); err != nil {
			slog.Error("thread sync", "agent", agentID, "err", err)
			fail(w, http.StatusInternalServerError, "internal", "could not record the threads")
			return
		}
		ok(w, map[string]bool{"ok": true})
	case r.Method == http.MethodPost && r.URL.Path == "/threads/report":
		var body threads.Status
		if !decode(w, r, &body) {
			return
		}
		if err := h.Threads.Report(r.Context(), agentID, body); err != nil {
			slog.Error("thread report", "agent", agentID, "err", err)
			fail(w, http.StatusInternalServerError, "internal", "could not record the thread")
			return
		}
		ok(w, map[string]bool{"ok": true})
	case r.Method == http.MethodPost && r.URL.Path == "/usage":
		// MODEL_USAGE_URL names the model the runtime was started on (?model=provider/id), so a report that arrives
		// after the agent moved to another model still counts for the one that answered.
		var counts usage.Counts
		if !decode(w, r, &counts) {
			return
		}
		model := r.URL.Query().Get("model")
		if model == "" || !counts.Valid() {
			fail(w, http.StatusBadRequest, "invalid_usage", "usage needs a model and whole, positive counts")
			return
		}
		if h.Usage != nil {
			if err := h.Usage.RecordUsage(r.Context(), agentID, model, counts); err != nil {
				slog.Error("recording usage", "agent", agentID, "err", err)
				fail(w, http.StatusInternalServerError, "internal", "could not record usage")
				return
			}
		}
		w.WriteHeader(http.StatusNoContent)
	case h.Approvals != nil && r.Method == http.MethodPost && r.URL.Path == "/approvals/report":
		var report approvals.Report
		if !decode(w, r, &report) {
			return
		}
		answer, good := h.Approvals.ReportOne(r.Context(), agentID, report)
		if !good {
			fail(w, http.StatusBadRequest, "invalid_approval", "the request couldn't be recorded")
			return
		}
		ok(w, answer)
	case h.Approvals != nil && r.Method == http.MethodPost && r.URL.Path == "/approvals/sync":
		var body struct {
			Approvals []approvals.Report `json:"approvals"`
			At        int64              `json:"at"`
		}
		if !decode(w, r, &body) {
			return
		}
		if len(body.Approvals) > 1000 {
			body.Approvals = body.Approvals[:1000]
		}
		ok(w, h.Approvals.Sync(r.Context(), agentID, body.Approvals, body.At))
	case h.Schedules != nil && (r.URL.Path == "/schedules" || strings.HasPrefix(r.URL.Path, "/schedules/")):
		h.serveSchedules(w, r, agentID)
	case h.OAuth != nil && strings.HasPrefix(r.URL.Path, "/mcp/oauth/"):
		h.serveOAuth(w, r, agentID)
	case h.Elicitations != nil && r.Method == http.MethodPost && r.URL.Path == "/person/ask":
		// ask_person: the agent's own question, as a card like an MCP server's (answered through /mcp/elicitations).
		var body struct {
			Message  string          `json:"message"`
			Schema   json.RawMessage `json:"requestedSchema"`
			ThreadID string          `json:"threadId"`
		}
		if !decode(w, r, &body) {
			return
		}
		e, err := h.Elicitations.Create(agentID, elicitations.Request{Server: "agent", Tool: "ask_person", ThreadID: body.ThreadID, Message: body.Message, Schema: body.Schema})
		if err != nil {
			var ee *elicitations.Error
			if errors.As(err, &ee) {
				fail(w, ee.Status, ee.Code, ee.Message)
				return
			}
			fail(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		ok(w, map[string]any{"id": e.ID, "expiresAt": e.ExpiresAt})
	case h.ModelEnv != nil && r.Method == http.MethodGet && r.URL.Path == "/models/env":
		env, err := h.ModelEnv(r.Context(), agentID, r.URL.Query().Get("id"))
		if err != nil {
			fail(w, http.StatusConflict, "model_unavailable", err.Error())
			return
		}
		ok(w, map[string]any{"env": env})
	case h.Notify != nil && r.Method == http.MethodPost && r.URL.Path == "/person/notify":
		var body struct {
			Title    string `json:"title"`
			Message  string `json:"message"`
			ThreadID string `json:"threadId"`
		}
		if !decode(w, r, &body) {
			return
		}
		if !h.Notify(agentID, body.ThreadID, body.Title, body.Message) {
			fail(w, http.StatusTooManyRequests, "rate_limited", "Not sent: you notified the person very recently. Put it in your reply instead.")
			return
		}
		ok(w, map[string]bool{"sent": true})
	case h.PickTools != nil && r.Method == http.MethodPost && r.URL.Path == "/judge/tools":
		var body struct {
			Message string       `json:"message"`
			Tools   []judge.Tool `json:"tools"`
			Limit   int          `json:"limit"`
		}
		if !decode(w, r, &body) {
			return
		}
		if body.Limit <= 0 || body.Limit > 12 {
			body.Limit = 8
		}
		names, err := h.PickTools(r.Context(), body.Message, body.Tools, body.Limit)
		if err != nil {
			// A failed judgment is no judgment: the model still has tool_search.
			names = []string{}
		}
		ok(w, map[string]any{"tools": names})
	case h.JudgeApproval != nil && r.Method == http.MethodPost && r.URL.Path == "/judge/approval":
		var body struct {
			Tool      string          `json:"tool"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if !decode(w, r, &body) {
			return
		}
		if body.Tool == "" || len(body.Tool) > 200 {
			fail(w, http.StatusBadRequest, "invalid_request", "name the tool")
			return
		}
		// Only ever tightens: a failed judgment is no judgment, and the rules stand.
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		risky, err := h.JudgeApproval(ctx, body.Tool, body.Arguments)
		ok(w, map[string]any{"risky": err == nil && risky})
	case h.Memory != nil && strings.HasPrefix(r.URL.Path, "/memory/"):
		h.serveMemory(w, r, agentID)
	case h.Web != nil && r.Method == http.MethodPost && (r.URL.Path == "/web/search" || r.URL.Path == "/web/fetch"):
		h.serveWeb(w, r, agentID)
	case h.Elicitations != nil && (r.URL.Path == "/mcp/elicitations" || strings.HasPrefix(r.URL.Path, "/mcp/elicitations/")):
		h.serveElicitations(w, r, agentID)
	case h.Asks != nil && strings.HasPrefix(r.URL.Path, "/a2a/"):
		h.serveAsks(w, r, agentID)
	default:
		// Approvals, schedules and MCP sign-in state come in later phases. A runtime treats 404 as "the host doesn't
		// offer this" (docs/runtime-contract.md).
		fail(w, http.StatusNotFound, "not_found", "not offered")
	}
}

func (h *Handler) serveAsks(w http.ResponseWriter, r *http.Request, caller string) {
	refused := func(err error) bool {
		var refusal *asks.Error
		if errors.As(err, &refusal) {
			fail(w, http.StatusForbidden, "refused", refusal.Message)
			return true
		}
		if errors.Is(err, asks.ErrNotFound) {
			fail(w, http.StatusNotFound, "not_found", "no such ask")
			return true
		}
		return false
	}
	path := strings.TrimPrefix(r.URL.Path, "/a2a/")
	switch {
	case r.Method == http.MethodGet && path == "agents":
		ok(w, h.Asks.Peers(r.Context(), caller))
	case r.Method == http.MethodPost && path == "asks":
		var req asks.Request
		if !decode(w, r, &req) {
			return
		}
		started, err := h.Asks.Start(r.Context(), caller, req)
		if err != nil {
			if !refused(err) {
				slog.Error("starting an ask", "agent", caller, "err", err)
				fail(w, http.StatusInternalServerError, "internal", "the ask could not be started")
			}
			return
		}
		ok(w, started)
	case strings.HasPrefix(path, "asks/"):
		rest := strings.TrimPrefix(path, "asks/")
		id, action, _ := strings.Cut(rest, "/")
		switch {
		case r.Method == http.MethodGet && action == "":
			wait, _ := strconv.Atoi(r.URL.Query().Get("waitMs"))
			if wait <= 0 || wait > 30_000 {
				wait = 25_000
			}
			state, err := h.Asks.Wait(r.Context(), caller, id, time.Duration(wait)*time.Millisecond)
			if err != nil {
				if r.Context().Err() == nil && !refused(err) {
					fail(w, http.StatusInternalServerError, "internal", "could not read the ask")
				}
				return
			}
			ok(w, state)
		case r.Method == http.MethodPost && action == "stop":
			if err := h.Asks.Stop(r.Context(), caller, id); err != nil && !refused(err) {
				fail(w, http.StatusInternalServerError, "internal", "could not stop the ask")
				return
			}
			ok(w, map[string]bool{"ok": true})
		default:
			fail(w, http.StatusNotFound, "not_found", "not offered")
		}
	default:
		fail(w, http.StatusNotFound, "not_found", "not offered")
	}
}

// serveMemory: GET /memory/context → {aboutYou, notes}; POST /memory/remember, /memory/recall, /memory/forget.
func (h *Handler) serveMemory(w http.ResponseWriter, r *http.Request, agentID string) {
	failWith := func(err error) {
		var me interface{ HTTPStatus() (int, string, string) }
		if errors.As(err, &me) {
			status, code, msg := me.HTTPStatus()
			fail(w, status, code, msg)
			return
		}
		fail(w, http.StatusInternalServerError, "internal", err.Error())
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/memory/context":
		about, notes, err := h.Memory.Context(r.Context(), agentID)
		if err != nil {
			failWith(err)
			return
		}
		ok(w, map[string]string{"aboutYou": about, "notes": notes})
	case r.Method == http.MethodPost && r.URL.Path == "/memory/remember":
		var in RememberInput
		if !decode(w, r, &in) {
			return
		}
		res, err := h.Memory.Remember(r.Context(), agentID, in)
		if err != nil {
			failWith(err)
			return
		}
		ok(w, res)
	case r.Method == http.MethodPost && r.URL.Path == "/memory/recall":
		var in struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if !decode(w, r, &in) {
			return
		}
		res, err := h.Memory.Recall(r.Context(), agentID, in.Query, in.Limit)
		if err != nil {
			failWith(err)
			return
		}
		ok(w, res)
	case r.Method == http.MethodPost && r.URL.Path == "/memory/forget":
		var in struct {
			ID      string `json:"id"`
			Present bool   `json:"present"`
		}
		if !decode(w, r, &in) {
			return
		}
		if err := h.Memory.Forget(r.Context(), agentID, in.ID, in.Present); err != nil {
			failWith(err)
			return
		}
		ok(w, map[string]bool{"ok": true})
	default:
		fail(w, http.StatusNotFound, "not_found", "no such route")
	}
}

// serveWeb: POST /web/search {query, count} → {results}; POST /web/fetch {url, offset, maxChars} → a page.
func (h *Handler) serveWeb(w http.ResponseWriter, r *http.Request, agentID string) {
	tool := strings.TrimPrefix(r.URL.Path, "/web/")
	if !h.Web.Allowed(agentID, tool) {
		fail(w, http.StatusForbidden, "forbidden", "this agent's web "+tool+" tool is turned off")
		return
	}
	var body struct {
		Query    string `json:"query"`
		Count    int    `json:"count"`
		URL      string `json:"url"`
		Offset   int    `json:"offset"`
		MaxChars int    `json:"maxChars"`
	}
	if !decode(w, r, &body) {
		return
	}
	failWith := func(err error) {
		var we *web.Error
		if errors.As(err, &we) {
			fail(w, we.Status, we.Code, we.Message)
			return
		}
		fail(w, http.StatusInternalServerError, "internal", err.Error())
	}
	if tool == "search" {
		results, err := h.Web.Search(r.Context(), body.Query, body.Count)
		if err != nil {
			failWith(err)
			return
		}
		ok(w, map[string]any{"results": results})
		return
	}
	page, err := h.Web.Fetch(r.Context(), body.URL, body.Offset, body.MaxChars)
	if err != nil {
		failWith(err)
		return
	}
	ok(w, page)
}

// serveElicitations: an MCP server's question to the person, for the runtime that relays it.
//
//	POST   /mcp/elicitations              {server, serverName, tool, threadId, message, requestedSchema} → {id, expiresAt}
//	GET    /mcp/elicitations/{id}?wait=s  → {done, action, content}: the answer, or done false after s seconds (≤ 30)
//	DELETE /mcp/elicitations/{id}         the server or the call gave up
func (h *Handler) serveElicitations(w http.ResponseWriter, r *http.Request, agentID string) {
	id := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/mcp/elicitations"), "/")
	failWith := func(err error) {
		var ee *elicitations.Error
		if errors.As(err, &ee) {
			fail(w, ee.Status, ee.Code, ee.Message)
			return
		}
		fail(w, http.StatusInternalServerError, "internal", err.Error())
	}
	switch {
	case r.Method == http.MethodPost && id == "":
		var body elicitations.Request
		if !decode(w, r, &body) {
			return
		}
		// Only for a server the agent uses (the app's catalog says which).
		if h.OAuth == nil || !h.OAuth.Uses(agentID, body.Server) {
			fail(w, http.StatusForbidden, "forbidden", "this agent doesn't use that MCP server")
			return
		}
		e, err := h.Elicitations.Create(agentID, body)
		if err != nil {
			failWith(err)
			return
		}
		ok(w, map[string]any{"id": e.ID, "expiresAt": e.ExpiresAt})
	case r.Method == http.MethodGet && id != "" && !strings.Contains(id, "/"):
		wait := 25 * time.Second
		if s, err := strconv.Atoi(r.URL.Query().Get("wait")); err == nil && s >= 0 && s <= 30 {
			wait = time.Duration(s) * time.Second
		}
		answer, done, err := h.Elicitations.Wait(r.Context(), agentID, id, wait)
		if err != nil {
			if r.Context().Err() != nil {
				return
			}
			failWith(err)
			return
		}
		if !done {
			ok(w, map[string]any{"done": false})
			return
		}
		ok(w, map[string]any{"done": true, "action": answer.Action, "content": answer.Content})
	case r.Method == http.MethodDelete && id != "" && !strings.Contains(id, "/"):
		if err := h.Elicitations.Withdraw(agentID, id); err != nil {
			failWith(err)
			return
		}
		ok(w, map[string]bool{"ok": true})
	default:
		fail(w, http.StatusNotFound, "not_found", "no such route")
	}
}

// serveOAuth: GET and PUT /mcp/oauth/{slug}, the server's OAuth state (pi-mcp's McpOAuthState, opaque here).
func (h *Handler) serveOAuth(w http.ResponseWriter, r *http.Request, agentID string) {
	slug := strings.TrimPrefix(r.URL.Path, "/mcp/oauth/")
	if slug == "" || strings.Contains(slug, "/") || !h.OAuth.Uses(agentID, slug) {
		fail(w, http.StatusNotFound, "not_found", "no such MCP server for this agent")
		return
	}
	switch r.Method {
	case http.MethodGet:
		state, err := h.OAuth.OAuthState(slug)
		if err != nil {
			fail(w, http.StatusInternalServerError, "internal", "could not read the sign-in state")
			return
		}
		if state == nil {
			fail(w, http.StatusNotFound, "not_found", "not signed in")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":`))
		w.Write(state)
		w.Write([]byte(`}`))
	case http.MethodPut:
		raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<10+1))
		if err != nil || len(raw) > 64<<10 {
			fail(w, http.StatusRequestEntityTooLarge, "too_large", "sign-in state too large")
			return
		}
		if err := h.OAuth.SaveOAuthState(slug, raw); err != nil {
			fail(w, http.StatusBadRequest, "invalid_state", err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		fail(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or PUT")
	}
}

// agentSchedule is a schedule as an agent's schedule tools read it (runtime schedule.ts, AgentSchedule).
func agentSchedule(s *schedules.Schedule) map[string]any {
	var next any
	if s.NextFireAt != nil {
		next = time.UnixMilli(*s.NextFireAt).UTC().Format(time.RFC3339)
	}
	out := map[string]any{"id": s.ID, "name": s.Name, "once": s.Once, "timezone": s.Timezone, "message": s.Message,
		"threadId": s.ThreadID, "originThreadId": s.OriginThreadID, "nextFireAt": next, "paused": s.Paused}
	if s.Cron != nil {
		out["cron"] = *s.Cron
	}
	if s.PausedReason != nil {
		out["pausedReason"] = *s.PausedReason
	}
	return out
}

// serveSchedules: an agent's own schedules (its schedule, list_schedules and cancel_schedule tools).
func (h *Handler) serveSchedules(w http.ResponseWriter, r *http.Request, agentID string) {
	refusal := func(err error) {
		var se *schedules.Error
		if errors.As(err, &se) {
			fail(w, se.Status, se.Code, se.Message)
			return
		}
		fail(w, http.StatusInternalServerError, "internal", "the schedule could not be saved")
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/schedules":
		var body struct {
			At       string `json:"at"`
			Cron     string `json:"cron"`
			Timezone string `json:"timezone"`
			Message  string `json:"message"`
			Thread   string `json:"thread"`
			ThreadID string `json:"threadId"`
			Name     string `json:"name"`
		}
		if !decode(w, r, &body) {
			return
		}
		in := schedules.Input{Message: &body.Message, Timezone: &body.Timezone}
		if body.Name != "" {
			in.Name = &body.Name
		}
		if body.At != "" {
			in.At = &body.At
		} else {
			in.Cron = &body.Cron
		}
		where, why := "new", ""
		mode := "new"
		if body.Thread != "new" {
			if body.ThreadID != "" {
				mode, where = "this", "this"
				in.ThreadID = &body.ThreadID
			} else {
				why = "this conversation isn't a thread of its own (a subagent's)"
			}
		}
		in.ThreadMode = &mode
		created, err := h.Schedules.Create(r.Context(), agentID, "agent", body.ThreadID, in)
		if err != nil {
			refusal(err)
			return
		}
		answer := map[string]any{"schedule": agentSchedule(created), "where": where}
		if why != "" {
			answer["whyNotHere"] = why
		}
		ok(w, answer)
	case r.Method == http.MethodGet && r.URL.Path == "/schedules":
		list, err := h.Schedules.List(r.Context(), agentID)
		if err != nil {
			refusal(err)
			return
		}
		out := []map[string]any{}
		for _, s := range list {
			if s.MadeBy == "agent" {
				out = append(out, agentSchedule(s))
			}
		}
		ok(w, out)
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/schedules/"):
		id := strings.TrimPrefix(r.URL.Path, "/schedules/")
		sc, err := h.Schedules.Get(r.Context(), id)
		if err != nil || sc.AgentID != agentID || sc.MadeBy != "agent" {
			fail(w, http.StatusNotFound, "not_found", "No schedule of yours has that ID (list_schedules shows them).")
			return
		}
		deleted, err := h.Schedules.Delete(r.Context(), id, agentID)
		if err != nil {
			refusal(err)
			return
		}
		ok(w, agentSchedule(deleted))
	default:
		fail(w, http.StatusNotFound, "not_found", "not offered")
	}
}
