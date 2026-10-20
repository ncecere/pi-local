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
	"github.com/ncecere/pi-local/internal/threads"
	"github.com/ncecere/pi-local/internal/usage"
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

// Handler is the gateway's routes.
type Handler struct {
	Keys      Keys
	Threads   Threads
	Usage     Usage
	Asks      Asks
	Approvals Approvals
	OAuth     OAuth
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
	case h.OAuth != nil && strings.HasPrefix(r.URL.Path, "/mcp/oauth/"):
		h.serveOAuth(w, r, agentID)
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
