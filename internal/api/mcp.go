package api

import (
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/ncecere/pi-local/internal/elicitations"
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
	m.HandleFunc("POST /api/mcp/servers/{slug}/reveal", a.revealMCP)
	m.HandleFunc("POST /api/mcp/servers/{slug}/login", a.startMCPLogin)
	m.HandleFunc("GET /api/mcp/servers/{slug}/login", a.mcpLogin)
	m.HandleFunc("DELETE /api/mcp/servers/{slug}/login", a.cancelMCPLogin)
	m.HandleFunc("GET /api/mcp/import", a.importSources)
	m.HandleFunc("GET /api/elicitations", a.listElicitations)
	m.HandleFunc("POST /api/elicitations/{id}", a.answerElicitation)
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

// startMCPLogin runs a local server's sign-in command (202: it runs on; the `mcp-login` event follows it).
func (a *API) startMCPLogin(w http.ResponseWriter, r *http.Request) {
	st, err := a.MCP.Login(r.Context(), r.PathValue("slug"))
	if err != nil {
		mcpFailure(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": st})
}

func (a *API) mcpLogin(w http.ResponseWriter, r *http.Request) {
	st, err := a.MCP.LoginState(r.Context(), r.PathValue("slug"))
	if err != nil {
		mcpFailure(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	ok(w, st)
}

func (a *API) cancelMCPLogin(w http.ResponseWriter, r *http.Request) {
	st, err := a.MCP.CancelLogin(r.Context(), r.PathValue("slug"))
	if err != nil {
		mcpFailure(w, err)
		return
	}
	ok(w, st)
}

// revealMCP shows one stored env value or header. POST with a JSON body, so a page elsewhere can't read it (a cross-origin
// JSON POST needs a preflight this server never grants); never logged.
func (a *API) revealMCP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		fail(w, http.StatusUnsupportedMediaType, "json_required", "Send JSON.")
		return
	}
	var in struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	v, err := a.MCP.Secret(r.Context(), r.PathValue("slug"), in.Kind, in.Name)
	if err != nil {
		mcpFailure(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	ok(w, map[string]string{"value": v})
}

// listElicitations: MCP servers' questions waiting for the person.
func (a *API) listElicitations(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ok(w, a.Elicitations.Pending())
}

// answerElicitation: the person's answer, {action: accept|decline|cancel, content?}.
func (a *API) answerElicitation(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Action  string         `json:"action"`
		Content map[string]any `json:"content"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	e, err := a.Elicitations.Answer(r.PathValue("id"), in.Action, in.Content)
	if err != nil {
		var ee *elicitations.Error
		if errors.As(err, &ee) {
			fail(w, ee.Status, ee.Code, ee.Message)
			return
		}
		fail(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	ok(w, e)
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
