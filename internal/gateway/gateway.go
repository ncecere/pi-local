// Package gateway serves what agent runtimes call back into (docs/runtime-contract.md, "Reports to the platform"),
// on a loopback port of its own, each runtime authenticated by the key it was started with (PLATFORM_KEY).
package gateway

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"

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

// Handler is the gateway's routes.
type Handler struct {
	Keys    Keys
	Threads Threads
	Usage   Usage
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
	default:
		// Approvals, schedules and MCP sign-in state come in later phases. A runtime treats 404 as "the host doesn't
		// offer this" (docs/runtime-contract.md).
		fail(w, http.StatusNotFound, "not_found", "not offered")
	}
}
