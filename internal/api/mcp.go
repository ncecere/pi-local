package api

import (
	"errors"
	"log/slog"
	"net/http"
	"sort"

	"github.com/ncecere/pi-local/internal/mcp"
)

func (a *API) mcpRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/mcp/servers", a.listMCP)
	m.HandleFunc("POST /api/mcp/servers", a.createMCP)
	m.HandleFunc("PATCH /api/mcp/servers/{slug}", a.updateMCP)
	m.HandleFunc("DELETE /api/mcp/servers/{slug}", a.deleteMCP)
	m.HandleFunc("POST /api/mcp/servers/{slug}/test", a.testMCP)
	m.HandleFunc("POST /api/mcp/servers/{slug}/sign-in", a.signInMCP)
	m.HandleFunc("POST /api/mcp/servers/{slug}/sign-out", a.signOutMCP)
	m.HandleFunc("GET /api/mcp/import", a.importSources)
	m.HandleFunc("POST /api/mcp/import", a.importMCP)
}

func mcpFailure(w http.ResponseWriter, err error) {
	var me *mcp.Error
	if errors.As(err, &me) {
		body := map[string]any{"code": me.Code, "message": me.Message}
		if me.Details != nil {
			body["details"] = me.Details
		}
		writeJSON(w, me.Status, map[string]any{"error": body})
		return
	}
	slog.Error("mcp", "err", err)
	fail(w, http.StatusInternalServerError, "internal", "Something went wrong: "+err.Error())
}

func (a *API) listMCP(w http.ResponseWriter, r *http.Request) {
	list, err := a.MCP.List(r.Context())
	if err != nil {
		mcpFailure(w, err)
		return
	}
	ok(w, list)
}

func (a *API) createMCP(w http.ResponseWriter, r *http.Request) {
	var in mcp.Input
	if !decodeBody(w, r, &in) {
		return
	}
	s, err := a.MCP.Create(r.Context(), in, "")
	if err != nil {
		mcpFailure(w, err)
		return
	}
	created(w, s)
}

func (a *API) updateMCP(w http.ResponseWriter, r *http.Request) {
	var in mcp.Input
	if !decodeBody(w, r, &in) {
		return
	}
	s, err := a.MCP.Update(r.Context(), r.PathValue("slug"), in)
	if err != nil {
		mcpFailure(w, err)
		return
	}
	ok(w, s)
}

func (a *API) deleteMCP(w http.ResponseWriter, r *http.Request) {
	if err := a.MCP.Delete(r.Context(), r.PathValue("slug")); err != nil {
		mcpFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

func (a *API) testMCP(w http.ResponseWriter, r *http.Request) {
	s, err := a.MCP.Test(r.Context(), r.PathValue("slug"))
	if err != nil {
		mcpFailure(w, err)
		return
	}
	ok(w, s)
}

func (a *API) signInMCP(w http.ResponseWriter, r *http.Request) {
	u, err := a.MCP.SignIn(r.Context(), r.PathValue("slug"))
	if err != nil {
		mcpFailure(w, err)
		return
	}
	var authorize any
	if u != "" {
		authorize = u
	}
	ok(w, map[string]any{"authorizeUrl": authorize})
}

func (a *API) signOutMCP(w http.ResponseWriter, r *http.Request) {
	s, err := a.MCP.SignOut(r.Context(), r.PathValue("slug"))
	if err != nil {
		mcpFailure(w, err)
		return
	}
	ok(w, s)
}

func (a *API) importSources(w http.ResponseWriter, r *http.Request) {
	var searched []string
	for _, paths := range mcp.SourcePaths() {
		searched = append(searched, paths...)
	}
	sort.Strings(searched)
	ok(w, map[string]any{"sources": a.MCP.Sources(), "searched": searched})
}

func (a *API) importMCP(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Source string   `json:"source"`
		Names  []string `json:"names"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	added, skipped, err := a.MCP.Import(r.Context(), in.Source, in.Names)
	if err != nil {
		mcpFailure(w, err)
		return
	}
	ok(w, map[string]any{"servers": added, "skipped": skipped})
}
