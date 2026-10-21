package api

import (
	"context"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/knowledge"
)

func (a *API) knowledgeRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/agents/{agent}/knowledge", a.withAgent(a.getKnowledge))
	m.HandleFunc("POST /api/agents/{agent}/knowledge/rescan", a.withAgent(a.rescanKnowledge))
	m.HandleFunc("GET /api/agents/{agent}/knowledge/problems", a.withAgent(a.knowledgeProblems))
	m.HandleFunc("GET /api/agents/{agent}/knowledge/search", a.withAgent(a.searchKnowledge))
	m.HandleFunc("GET /api/agents/{agent}/knowledge/file", a.withAgent(a.knowledgeFile))
	m.HandleFunc("POST /api/agents/{agent}/knowledge/open", a.withAgent(a.openKnowledgeFile))
}

// getKnowledge: the agent's folders with the index's status, and the limits.
func (a *API) getKnowledge(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	folders := []knowledge.FolderStatus{}
	for _, f := range ag.Config.Knowledge.Folders {
		folders = append(folders, a.Knowledge.Status(r.Context(), f))
	}
	ok(w, map[string]any{
		"folders": folders,
		"limits":  map[string]any{"maxFileBytes": knowledge.MaxFileBytes, "maxFiles": knowledge.MaxFiles},
	})
}

// rescanKnowledge reads a folder again now ({path}), or every folder of the agent.
func (a *API) rescanKnowledge(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	var in struct {
		Path string `json:"path"`
	}
	if r.ContentLength != 0 && !decodeBody(w, r, &in) {
		return
	}
	for _, f := range ag.Config.Knowledge.Folders {
		if in.Path == "" || filepath.Clean(in.Path) == f {
			a.Knowledge.Rescan(f)
		}
	}
	ok(w, map[string]bool{"ok": true})
}

// knowledgeProblems lists the files of one of the agent's folders that couldn't be read (?folder=).
func (a *API) knowledgeProblems(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	folder := filepath.Clean(r.URL.Query().Get("folder"))
	for _, f := range ag.Config.Knowledge.Folders {
		if f == folder {
			ok(w, a.Knowledge.Problems(r.Context(), folder, 200))
			return
		}
	}
	fail(w, http.StatusNotFound, "not_found", "That isn't one of this agent's knowledge folders.")
}

// searchKnowledge tries a search in the agent's folders (?q=): the index's own ranking, no fast judgments.
func (a *API) searchKnowledge(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || len(q) > 500 {
		fail(w, http.StatusBadRequest, "invalid_query", "Type what to look for.")
		return
	}
	hits, info, err := a.Knowledge.Search(r.Context(), ag.Config.Knowledge.Folders, q, 8)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "The documents could not be searched.")
		return
	}
	ok(w, map[string]any{"passages": hits, "searched": info})
}

// knowledgeFileOf resolves ?path= (or a body's path) to an indexed file of the agent: nothing else is ever opened.
func (a *API) knowledgeFileOf(ctx context.Context, ag *agents.Agent, path string) (string, bool) {
	if !filepath.IsAbs(path) {
		return "", false
	}
	path = filepath.Clean(path)
	if _, found := a.Knowledge.Indexed(ctx, ag.Config.Knowledge.Folders, path); !found {
		return "", false
	}
	if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	return path, true
}

// knowledgeFile serves an indexed file (the link a citation has): a PDF to look at, text as text, Office files as a
// download.
func (a *API) knowledgeFile(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	path, found := a.knowledgeFileOf(r.Context(), ag, r.URL.Query().Get("path"))
	if !found {
		fail(w, http.StatusNotFound, "not_found", "That file isn't in this agent's knowledge folders (or it was moved).")
		return
	}
	f, err := a.Knowledge.OpenIndexed(r.Context(), ag.Config.Knowledge.Folders, path)
	if err != nil {
		fail(w, http.StatusNotFound, "not_found", "That file can't be opened.")
		return
	}
	defer f.Close()
	kind := knowledge.KindOf(path)
	disposition, contentType := "attachment", mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	switch kind {
	case "pdf":
		disposition, contentType = "inline", "application/pdf"
	case "md", "text":
		// Never HTML or script, whatever the extension says.
		disposition, contentType = "inline", "text/plain; charset=utf-8"
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": filepath.Base(path)}))
	http.ServeContent(w, r, "", time.Time{}, f)
}

// openKnowledgeFile opens an indexed file in the application the system uses for it, or shows it in the Finder
// ({path, reveal}). POST with a JSON body, so a page elsewhere can't make it happen.
func (a *API) openKnowledgeFile(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		fail(w, http.StatusUnsupportedMediaType, "json_required", "Send JSON.")
		return
	}
	var in struct {
		Path   string `json:"path"`
		Reveal bool   `json:"reveal"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	path, found := a.knowledgeFileOf(r.Context(), ag, in.Path)
	if !found {
		fail(w, http.StatusNotFound, "not_found", "That file isn't in this agent's knowledge folders (or it was moved).")
		return
	}
	// Resolve ancestors only after the indexed-file check, then check the resolved target against the same
	// folders. The system opener must not follow a replaced parent symlink outside the knowledge folder.
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		fail(w, http.StatusNotFound, "not_found", "That file can't be opened.")
		return
	}
	allowed := false
	for _, folder := range ag.Config.Knowledge.Folders {
		canonical, err := filepath.EvalSymlinks(folder)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(canonical, real)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			allowed = true
			break
		}
	}
	if !allowed {
		fail(w, http.StatusNotFound, "not_found", "That file isn't in this agent's knowledge folders.")
		return
	}
	if err := a.Manager.OpenFile(real, in.Reveal); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "The file could not be opened: "+err.Error())
		return
	}
	ok(w, map[string]any{"ok": true, "path": path})
}
