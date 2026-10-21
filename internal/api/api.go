// Package api is the UI's API (docs/api.md): one local person, their agents and threads, preferences, and live
// events. Thread views and streams are the runtime's, relayed; thread lists come from the app's own index, so
// listing never starts an agent.
package api

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/user"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/approvals"
	"github.com/ncecere/pi-local/internal/elicitations"
	"github.com/ncecere/pi-local/internal/events"
	"github.com/ncecere/pi-local/internal/mcp"
	"github.com/ncecere/pi-local/internal/models"
	"github.com/ncecere/pi-local/internal/schedules"
	"github.com/ncecere/pi-local/internal/search"
	"github.com/ncecere/pi-local/internal/supervisor"
	"github.com/ncecere/pi-local/internal/teams"
	"github.com/ncecere/pi-local/internal/threads"
	"github.com/ncecere/pi-local/internal/update"
	"github.com/ncecere/pi-local/internal/usage"
	"github.com/ncecere/pi-local/internal/web"
)

// Runtimes is what the API needs from the supervisor.
type Runtimes interface {
	Call(ctx context.Context, id, method, pathAndQuery string, body []byte, header http.Header) (*http.Response, error)
	Status(id string) (supervisor.Status, string)
	Forget(id string)
	Wake(ctx context.Context, id string) error
	Stop(id string)
}

// API serves /api.
type API struct {
	DB        *sql.DB
	Agents    *agents.Store
	Threads   *threads.Index
	Runtimes  Runtimes
	Hub       *events.Hub
	Catalog   *models.Catalog
	Usage     *usage.Store
	Teams     *teams.Store
	Manager   Manager
	Approvals *approvals.Store
	MCP       *mcp.Catalog
	Schedules *schedules.Store
	Search    *search.Store
	// Desktop is the desktop app's own settings (nil in the headless server).
	Desktop Desktop
	Updater *update.Updater
	// Web: the search service's settings (and a test search).
	Web *web.Service
	// Elicitations: MCP servers' questions to the person.
	Elicitations *elicitations.Store
	// SaveDialog asks where to save a file (the desktop app's native dialog); "" means cancelled. Nil: no dialog.
	SaveDialog func(defaultName string) (string, error)
	// FolderDialog asks for a folder (the desktop app's native dialog); "" means cancelled. Nil: no dialog.
	FolderDialog func(title string) (string, error)
	// OpenURL opens a web page in the person's browser (the desktop app, whose web view can't open windows). Nil: the
	// UI is in a browser already.
	OpenURL func(url string) error
	// KeepAlive is how often an idle event stream gets a comment (default 15 s).
	KeepAlive time.Duration

	mux http.Handler
}

const (
	maxBodyBytes     = 256 << 10
	maxMessageChars  = 32_000
	maxTitleChars    = 200
	keepAliveDefault = 15 * time.Second
)

var threadIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

var prefLimits = map[string]int{"inbox": 512 << 10, "appearance": 16 << 10}

// Handler builds the routes.
func (a *API) Handler() http.Handler {
	if a.mux != nil {
		return a.mux
	}
	if a.KeepAlive == 0 {
		a.KeepAlive = keepAliveDefault
	}
	m := http.NewServeMux()
	m.HandleFunc("GET /api/me", a.me)
	m.HandleFunc("GET /api/auth/config", a.authConfig)
	m.HandleFunc("GET /api/me/prefs", a.getPrefs)
	m.HandleFunc("PUT /api/me/prefs/{key}", a.putPref)

	m.HandleFunc("GET /api/agents", a.listAgents)
	m.HandleFunc("GET /api/agents/catalog", a.catalog)
	m.HandleFunc("POST /api/agents", a.createAgent)
	m.HandleFunc("PATCH /api/agents/{agent}", a.withAgent(a.updateAgent))
	m.HandleFunc("DELETE /api/agents/{agent}", a.withAgent(a.deleteAgent))

	m.HandleFunc("GET /api/agents/{agent}/threads", a.withAgent(a.listThreads))
	m.HandleFunc("GET /api/agents/{agent}/threads/{thread}", a.withThread(a.getThread))
	m.HandleFunc("GET /api/agents/{agent}/threads/{thread}/events", a.withThread(a.threadEvents))
	m.HandleFunc("GET /api/agents/{agent}/threads/{thread}/documents/{kind}", a.withThread(a.threadDocument))
	m.HandleFunc("POST /api/agents/{agent}/threads/{thread}/messages", a.withThread(a.sendMessage))
	m.HandleFunc("POST /api/agents/{agent}/threads/{thread}/stop", a.withThread(a.stopThread))
	m.HandleFunc("POST /api/agents/{agent}/threads/{thread}/fork", a.withThread(a.forkThread))
	m.HandleFunc("PATCH /api/agents/{agent}/threads/{thread}", a.withThread(a.renameThread))
	m.HandleFunc("DELETE /api/agents/{agent}/threads/{thread}", a.withThread(a.deleteThread))

	m.HandleFunc("GET /api/events", a.events)
	a.modelRoutes(m)
	a.manageRoutes(m)
	a.toolRoutes(m)
	a.mcpRoutes(m)
	a.alwaysRoutes(m)
	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { fail(w, http.StatusNotFound, "not_found", "Not found") })
	a.mux = m
	if os.Getenv("PI_LOCAL_TRACE") == "1" {
		a.mux = trace(m)
	}
	return a.mux
}

// trace logs each request's start, first byte and end (PI_LOCAL_TRACE=1, for finding what waits). Paths only: no
// bodies, headers or query values.
func trace(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		slog.Info("api →", "method", r.Method, "path", r.URL.Path)
		tw := &traceWriter{ResponseWriter: w, start: start}
		next.ServeHTTP(tw, r)
		slog.Info("api ←", "method", r.Method, "path", r.URL.Path, "status", tw.status, "firstByte", tw.first, "total", time.Since(start).Round(time.Millisecond))
	})
}

type traceWriter struct {
	http.ResponseWriter
	start  time.Time
	status int
	first  time.Duration
}

func (t *traceWriter) WriteHeader(code int) {
	if t.status == 0 {
		t.status, t.first = code, time.Since(t.start).Round(time.Millisecond)
	}
	t.ResponseWriter.WriteHeader(code)
}

func (t *traceWriter) Write(b []byte) (int, error) {
	if t.status == 0 {
		t.WriteHeader(http.StatusOK)
	}
	return t.ResponseWriter.Write(b)
}

func (t *traceWriter) Flush() {
	if f, ok := t.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// --- helpers ------------------------------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func ok(w http.ResponseWriter, data any) { writeJSON(w, http.StatusOK, map[string]any{"data": data}) }
func created(w http.ResponseWriter, data any) {
	writeJSON(w, http.StatusCreated, map[string]any{"data": data})
}
func fail(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid_request", "could not read the request")
		return nil, false
	}
	if len(body) > maxBodyBytes {
		fail(w, http.StatusRequestEntityTooLarge, "too_large", "Request body too large")
		return nil, false
	}
	return body, true
}

func decodeBody(w http.ResponseWriter, r *http.Request, into any) bool {
	body, good := readBody(w, r)
	if !good {
		return false
	}
	if err := json.Unmarshal(body, into); err != nil {
		fail(w, http.StatusBadRequest, "invalid_json", "invalid JSON")
		return false
	}
	return true
}

type agentKey struct{}

// withAgent resolves {agent}; an unknown or malformed ID is a 404.
func (a *API) withAgent(next func(http.ResponseWriter, *http.Request, *agents.Agent)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("agent")
		if !agents.ValidID(id) {
			fail(w, http.StatusNotFound, "not_found", "Agent not found")
			return
		}
		ag, err := a.Agents.Get(id)
		if err != nil {
			fail(w, http.StatusNotFound, "not_found", "Agent not found")
			return
		}
		next(w, r, ag)
	}
}

func (a *API) withThread(next func(http.ResponseWriter, *http.Request, *agents.Agent, string)) http.HandlerFunc {
	return a.withAgent(func(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
		t := r.PathValue("thread")
		if !threadIDPattern.MatchString(t) {
			fail(w, http.StatusBadRequest, "invalid_thread_id", "Thread IDs are 1-64 letters, digits, dashes or underscores")
			return
		}
		next(w, r, ag, t)
	})
}

// --- session (compatibility) ----------------------------------------------------------------------------------

func localName() string {
	if u, err := user.Current(); err == nil {
		if u.Name != "" {
			return u.Name
		}
		return u.Username
	}
	return "You"
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]any{
		"user":      map[string]string{"id": "local", "name": localName(), "email": "", "role": "admin"},
		"csrfToken": "",
		"features":  map[string]bool{"messageSearch": a.Search != nil, "folderDialog": a.FolderDialog != nil, "updates": a.Updater != nil && a.Updater.Status().CanInstall},
		"platform":  map[string]any{"mode": "local", "account": nil},
	})
}

func (a *API) authConfig(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]any{
		"oidcEnabled": false, "devAuthEnabled": false, "devAccounts": []any{},
		"instance": map[string]any{"name": "Pi Local", "logoUrl": nil, "colorTheme": "neutral", "defaultTheme": "system", "orgName": "", "supportUrl": nil},
	})
}

func (a *API) getPrefs(w http.ResponseWriter, r *http.Request) {
	rows, err := a.DB.QueryContext(r.Context(), `SELECT key, value FROM prefs`)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not read preferences")
		return
	}
	defer rows.Close()
	out := map[string]json.RawMessage{}
	for rows.Next() {
		var k, v string
		if rows.Scan(&k, &v) == nil {
			out[k] = json.RawMessage(v)
		}
	}
	ok(w, out)
}

func (a *API) putPref(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	limit, known := prefLimits[key]
	if !known {
		fail(w, http.StatusNotFound, "unknown_pref", "Unknown preference")
		return
	}
	body, good := readBody(w, r)
	if !good {
		return
	}
	if len(body) > limit+64 {
		fail(w, http.StatusRequestEntityTooLarge, "too_large", "Preference too large")
		return
	}
	var parsed struct {
		Value json.RawMessage `json:"value"`
	}
	if json.Unmarshal(body, &parsed) != nil {
		fail(w, http.StatusBadRequest, "invalid_json", "invalid JSON")
		return
	}
	var obj map[string]any
	if json.Unmarshal(parsed.Value, &obj) != nil || obj == nil {
		fail(w, http.StatusBadRequest, "invalid_value", "value must be an object")
		return
	}
	if _, err := a.DB.ExecContext(r.Context(), `INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, string(parsed.Value), time.Now().UnixMilli()); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not save the preference")
		return
	}
	ok(w, map[string]bool{"ok": true})
}

// --- agents ---------------------------------------------------------------------------------------------------

// AgentJSON is an agent as the UI sees it (docs/api.md, Agent).
func (a *API) AgentJSON(ag *agents.Agent) map[string]any {
	status, lastErr := a.Runtimes.Status(ag.ID)
	var lastUsed any
	if ag.LastUsedAt != nil {
		lastUsed = ag.LastUsedAt.UTC().Format(time.RFC3339Nano)
	}
	var lastError any
	if lastErr != "" {
		lastError = lastErr
	}
	return map[string]any{
		"id":               ag.ID,
		"name":             ag.Config.Name,
		"description":      ag.Config.Description,
		"instructions":     ag.Config.Instructions,
		"kind":             "personal",
		"agentKind":        ag.Config.Kind,
		"status":           string(status),
		"running":          status == supervisor.Awake,
		"lastError":        lastError,
		"model":            a.modelJSON(ag.Config.Model),
		"enabled":          true,
		"lastUsedAt":       lastUsed,
		"revision":         ag.Revision,
		"createdAt":        ag.CreatedAt.UTC().Format(time.RFC3339Nano),
		"updatedAt":        ag.UpdatedAt.UTC().Format(time.RFC3339Nano),
		"kindSettings":     kindSettings(ag.Config.KindSettings),
		"canCall":          nonNil(ag.Config.CanCall),
		"callable":         a.callable(ag.ID),
		"dir":              ag.Dir,
		"piDurableVersion": nullIfEmpty(ag.PiDurableVersion),
		"workspace":        map[string]any{"tools": nonNil(ag.Config.Workspace.Tools), "folder": ag.Config.Workspace.Folder, "dir": ag.WorkspaceDir()},
		"web":              ag.Config.Web,
		"approvals":        map[string]any{"tools": nonNil(ag.Config.Approvals.Tools), "timeoutSeconds": ag.Config.Approvals.Timeout()},
		"pendingApprovals": a.pendingApprovals(ag.ID),
		"mcp":              mcpChoices(ag.Config.MCP),
		"schedules":        ag.Config.Schedules,
	}
}

func kindSettings(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func nonNil(ids []string) []string {
	if ids == nil {
		return []string{}
	}
	return ids
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func mcpChoices(list []agents.MCPChoice) []map[string]any {
	out := []map[string]any{}
	for _, m := range list {
		var tools any
		if m.Tools != nil {
			tools = m.Tools
		}
		out = append(out, map[string]any{"server": m.Server, "tools": tools})
	}
	return out
}

func (a *API) pendingApprovals(id string) int {
	if a.Approvals == nil {
		return 0
	}
	return a.Approvals.PendingCount(context.Background(), id)
}

// callable is everyone an agent may ask, with names.
func (a *API) callable(id string) []map[string]string {
	out := []map[string]string{}
	if a.Teams == nil {
		return out
	}
	list, err := a.Teams.Callable(context.Background(), id)
	if err != nil {
		return out
	}
	for _, c := range list {
		out = append(out, map[string]string{"id": c.ID, "name": a.Agents.NameOf(c.ID), "via": c.Via})
	}
	return out
}

func (a *API) modelJSON(m agents.ModelRef) map[string]string {
	return map[string]string{"id": m.String(), "name": a.Catalog.ModelName(context.Background(), m.String()), "provider": m.Provider}
}

func (a *API) listAgents(w http.ResponseWriter, r *http.Request) {
	out := []map[string]any{}
	for _, ag := range a.Agents.List() {
		out = append(out, a.AgentJSON(ag))
	}
	ok(w, out)
}

func (a *API) catalog(w http.ResponseWriter, r *http.Request) {
	choices, err := a.Catalog.Choices(r.Context())
	if err != nil {
		catalogFailure(w, err)
		return
	}
	ok(w, map[string]any{
		"templates":        agents.Kinds,
		"models":           choices,
		"defaultModelId":   a.Catalog.DefaultModel(r.Context()),
		"allowModelChoice": true,
		"limit":            1000,
		"used":             len(a.Agents.List()),
	})
}

type agentInput struct {
	Name         *string                `json:"name"`
	Description  *string                `json:"description"`
	TemplateID   *string                `json:"templateId"`
	ModelID      *string                `json:"modelId"`
	Instructions *string                `json:"instructions"`
	KindSettings *map[string]any        `json:"kindSettings"`
	CanCall      *[]string              `json:"canCall"`
	Workspace    *agents.Workspace      `json:"workspace"`
	Approvals    *agents.Approvals      `json:"approvals"`
	MCP          *[]agents.MCPChoice    `json:"mcp"`
	Schedules    *agents.AgentSchedules `json:"schedules"`
	Web          *agents.WebTools       `json:"web"`
}

func (in agentInput) apply(c *agents.Config) error {
	if in.Name != nil {
		c.Name = *in.Name
	}
	if in.Description != nil {
		c.Description = *in.Description
	}
	if in.Instructions != nil {
		c.Instructions = *in.Instructions
	}
	if in.TemplateID != nil && *in.TemplateID != "" {
		c.Kind = *in.TemplateID
	}
	if in.KindSettings != nil {
		c.KindSettings = *in.KindSettings
		if len(c.KindSettings) == 0 {
			c.KindSettings = nil
		}
	}
	if in.CanCall != nil {
		c.CanCall = *in.CanCall
	}
	if in.Workspace != nil {
		c.Workspace = *in.Workspace
	}
	if in.Web != nil {
		c.Web = *in.Web
	}
	if in.MCP != nil {
		c.MCP = *in.MCP
	}
	if in.Schedules != nil {
		c.Schedules = *in.Schedules
	}
	if in.Approvals != nil {
		c.Approvals = *in.Approvals
		if c.Approvals.TimeoutSeconds == agents.DefaultApprovalTimeout {
			c.Approvals.TimeoutSeconds = 0 // the default stays implicit in agent.yaml
		}
	}
	if in.ModelID != nil && *in.ModelID != "" {
		m, good := modelRef(*in.ModelID)
		if !good {
			return &agents.InvalidError{Code: "invalid_model", Message: "Choose one of the models offered."}
		}
		c.Model = m
	}
	return nil
}

func agentFailure(w http.ResponseWriter, err error) {
	var inv *agents.InvalidError
	switch {
	case errors.As(err, &inv):
		fail(w, http.StatusBadRequest, inv.Code, inv.Message)
	case errors.Is(err, agents.ErrNotFound):
		fail(w, http.StatusNotFound, "not_found", "Agent not found")
	default:
		slog.Error("agent change", "err", err)
		fail(w, http.StatusInternalServerError, "internal", "Something went wrong saving the agent.")
	}
}

func (a *API) createAgent(w http.ResponseWriter, r *http.Request) {
	var in agentInput
	if !decodeBody(w, r, &in) {
		return
	}
	var cfg agents.Config
	if in.ModelID == nil || *in.ModelID == "" {
		def := a.Catalog.DefaultModel(r.Context())
		in.ModelID = &def
	}
	if err := in.apply(&cfg); err != nil {
		agentFailure(w, err)
		return
	}
	agents.KindDefaults(cfg.Kind, &cfg)
	// New agents can search and read the web unless the request says otherwise (read-only tools).
	if in.Web == nil {
		cfg.Web = agents.WebTools{Search: true, Fetch: true}
	}
	ag, err := a.Agents.Create(r.Context(), cfg)
	if err != nil {
		agentFailure(w, err)
		return
	}
	created(w, a.AgentJSON(ag))
}

func (a *API) updateAgent(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	var in agentInput
	if !decodeBody(w, r, &in) {
		return
	}
	var applyErr error
	updated, err := a.Agents.Update(r.Context(), ag.ID, func(c *agents.Config) { applyErr = in.apply(c) })
	if applyErr != nil {
		agentFailure(w, applyErr)
		return
	}
	if err != nil {
		agentFailure(w, err)
		return
	}
	ok(w, a.AgentJSON(updated))
}

func (a *API) deleteAgent(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	a.Runtimes.Forget(ag.ID)
	if err := a.Agents.Delete(r.Context(), ag.ID); err != nil {
		agentFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

// --- threads --------------------------------------------------------------------------------------------------

func (a *API) listThreads(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	list, err := a.Threads.List(r.Context(), ag.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not list the conversations")
		return
	}
	ok(w, list)
}

// runtimeFailure answers for a runtime that couldn't be reached.
func runtimeFailure(w http.ResponseWriter, r *http.Request, ag *agents.Agent, err error) {
	if r.Context().Err() != nil {
		return // the client went away
	}
	var se *supervisor.StartError
	if errors.As(err, &se) {
		fail(w, http.StatusServiceUnavailable, "agent_unavailable", ag.Config.Name+" could not start: "+se.Message)
		return
	}
	if errors.Is(err, agents.ErrNotFound) {
		fail(w, http.StatusNotFound, "not_found", "Agent not found")
		return
	}
	slog.Warn("reaching an agent's runtime", "agent", ag.ID, "err", err)
	fail(w, http.StatusServiceUnavailable, "agent_unavailable", ag.Config.Name+" is not answering. Try again in a moment.")
}

// relay sends a request to the agent's runtime and passes the answer through; event streams are flushed as they come.
func (a *API) relay(w http.ResponseWriter, r *http.Request, ag *agents.Agent, method, path string, body []byte, header http.Header) {
	resp, err := a.Runtimes.Call(r.Context(), ag.ID, method, path, body, header)
	if err != nil {
		runtimeFailure(w, r, ag, err)
		return
	}
	defer resp.Body.Close()
	for _, name := range []string{"Content-Type", "Cache-Control", "ETag"} {
		if v := resp.Header.Get(name); v != "" {
			w.Header().Set(name, v)
		}
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	buf := make([]byte, 32<<10)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil || r.Context().Err() != nil {
			return
		}
	}
}

func (a *API) getThread(w http.ResponseWriter, r *http.Request, ag *agents.Agent, t string) {
	if r.URL.RawQuery == "" {
		a.getThreadIndexed(w, r, ag, t)
		return
	}
	path := "/threads/" + t
	if q := r.URL.RawQuery; q != "" {
		path += "?" + q
	}
	a.relay(w, r, ag, http.MethodGet, path, nil, nil)
}

func (a *API) threadEvents(w http.ResponseWriter, r *http.Request, ag *agents.Agent, t string) {
	path := "/threads/" + t + "/events"
	if q := r.URL.RawQuery; q != "" {
		path += "?" + q
	}
	header := http.Header{"Accept": {"text/event-stream"}}
	if id := r.Header.Get("Last-Event-ID"); id != "" {
		header.Set("Last-Event-ID", id)
	}
	a.relay(w, r, ag, http.MethodGet, path, nil, header)
}

// threadDocument relays a document the agent exposes for a thread (a triage queue, a research plan …).
func (a *API) threadDocument(w http.ResponseWriter, r *http.Request, ag *agents.Agent, t string) {
	kind := r.PathValue("kind")
	if !documentKind.MatchString(kind) {
		fail(w, http.StatusNotFound, "document_not_found", "No such document")
		return
	}
	a.relay(w, r, ag, http.MethodGet, "/threads/"+t+"/documents/"+kind, nil, nil)
}

var documentKind = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)

func (a *API) sendMessage(w http.ResponseWriter, r *http.Request, ag *agents.Agent, t string) {
	body, good := readBody(w, r)
	if !good {
		return
	}
	var msg struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(body, &msg) != nil {
		fail(w, http.StatusBadRequest, "invalid_request", "invalid JSON")
		return
	}
	if strings.TrimSpace(msg.Text) == "" || utf8.RuneCountInString(msg.Text) > maxMessageChars {
		fail(w, http.StatusBadRequest, "invalid_text", "A message is 1 to 32,000 characters.")
		return
	}
	// Recorded before relaying, so the thread is listed (and busy) from the first instant, even if the runtime is
	// still starting; taken away again if the runtime refuses the first message.
	createdNow, err := a.Threads.Sending(r.Context(), ag.ID, t, msg.Text, nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not record the conversation")
		return
	}
	defer a.Threads.Sent(ag.ID, t)
	a.Agents.Touch(r.Context(), ag.ID)
	resp, err := a.Runtimes.Call(r.Context(), ag.ID, http.MethodPost, "/threads/"+t+"/messages", body, http.Header{"Content-Type": {"application/json"}})
	if err != nil {
		if createdNow {
			a.Threads.Delete(context.WithoutCancel(r.Context()), ag.ID, t)
		}
		runtimeFailure(w, r, ag, err)
		return
	}
	defer resp.Body.Close()
	answer, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 && resp.StatusCode < 500 && createdNow {
		a.Threads.Delete(context.WithoutCancel(r.Context()), ag.ID, t)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	w.Write(answer)
}

// forkThread makes a new thread from this one (edit a message: beforeMessageId; branch: afterMessageId).
func (a *API) forkThread(w http.ResponseWriter, r *http.Request, ag *agents.Agent, t string) {
	var in struct {
		BeforeMessageID string `json:"beforeMessageId,omitempty"`
		AfterMessageID  string `json:"afterMessageId,omitempty"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	source, err := a.Threads.Get(r.Context(), ag.ID, t)
	if err != nil {
		fail(w, http.StatusNotFound, "thread_not_found", "Conversation not found")
		return
	}
	newID := newThreadID()
	// The runtime wants exactly one of the two.
	payload := map[string]string{"threadId": newID}
	if in.BeforeMessageID != "" {
		payload["beforeMessageId"] = in.BeforeMessageID
	}
	if in.AfterMessageID != "" {
		payload["afterMessageId"] = in.AfterMessageID
	}
	body, _ := json.Marshal(payload)
	resp, err := a.Runtimes.Call(r.Context(), ag.ID, http.MethodPost, "/threads/"+t+"/fork", body, http.Header{"Content-Type": {"application/json"}})
	if err != nil {
		runtimeFailure(w, r, ag, err)
		return
	}
	defer resp.Body.Close()
	answer, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusCreated {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		w.Write(answer)
		return
	}
	if err := a.Threads.Adopt(r.Context(), ag.ID, newID, source.Title); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not record the new conversation")
		return
	}
	th, _ := a.Threads.Get(r.Context(), ag.ID, newID)
	created(w, th)
}

// newThreadID makes a thread ID like the UI's (a UUID).
func newThreadID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func (a *API) stopThread(w http.ResponseWriter, r *http.Request, ag *agents.Agent, t string) {
	a.relay(w, r, ag, http.MethodPost, "/threads/"+t+"/stop", nil, nil)
}

func (a *API) renameThread(w http.ResponseWriter, r *http.Request, ag *agents.Agent, t string) {
	var in struct {
		Title string `json:"title"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	title := strings.Join(strings.Fields(in.Title), " ")
	if title == "" || utf8.RuneCountInString(title) > maxTitleChars {
		fail(w, http.StatusBadRequest, "invalid_title", "A conversation's name is 1 to 200 characters.")
		return
	}
	th, err := a.Threads.Rename(r.Context(), ag.ID, t, title)
	if errors.Is(err, threads.ErrNotFound) {
		fail(w, http.StatusNotFound, "thread_not_found", "Conversation not found")
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not rename the conversation")
		return
	}
	ok(w, th)
}

func (a *API) deleteThread(w http.ResponseWriter, r *http.Request, ag *agents.Agent, t string) {
	resp, err := a.Runtimes.Call(r.Context(), ag.ID, http.MethodDelete, "/threads/"+t, nil, nil)
	if err != nil {
		runtimeFailure(w, r, ag, err)
		return
	}
	resp.Body.Close()
	// A thread the runtime doesn't have (never reached it) is gone from the index all the same.
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		fail(w, http.StatusBadGateway, "agent_error", "The agent could not delete the conversation.")
		return
	}
	if err := a.Threads.Delete(r.Context(), ag.ID, t); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not delete the conversation")
		return
	}
	if a.Search != nil {
		a.Search.Forget(r.Context(), ag.ID, t)
	}
	ok(w, map[string]bool{"ok": true})
}

// --- live events ----------------------------------------------------------------------------------------------

func (a *API) events(w http.ResponseWriter, r *http.Request) {
	flusher, canFlush := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	ch, unsubscribe := a.Hub.Subscribe()
	defer unsubscribe()
	write := func(s string) bool {
		if _, err := io.WriteString(w, s); err != nil {
			return false
		}
		if canFlush {
			flusher.Flush()
		}
		return true
	}
	if !write("event: ready\ndata: {}\n\n") {
		return
	}
	ticker := time.NewTicker(a.KeepAlive)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !write(": keep-alive\n\n") {
				return
			}
		case ev, open := <-ch:
			if !open {
				return
			}
			if !write("event: " + ev.Name + "\ndata: " + string(ev.Data) + "\n\n") {
				return
			}
		}
	}
}
