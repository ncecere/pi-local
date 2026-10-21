package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"

	"github.com/ncecere/pi-local/internal/agents"
)

var artifactID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (a *API) artifactRoutes(m *http.ServeMux) {
	base := "/api/agents/{agent}/threads/{thread}/artifacts/{artifact}"
	m.HandleFunc("GET "+base, a.withThread(a.threadArtifact))
	m.HandleFunc("PUT "+base, a.withThread(a.threadArtifact))
	m.HandleFunc("GET "+base+"/history", a.withThread(a.threadArtifact))
	m.HandleFunc("POST "+base+"/workspace", a.withThread(a.threadArtifact))
	m.HandleFunc("GET "+base+"/download", a.withThread(a.downloadArtifact))
	m.HandleFunc("POST "+base+"/download", a.withThread(a.downloadArtifact))
}

// All paths are constructed from validated scoped IDs, never supplied by the caller.
func artifactPath(w http.ResponseWriter, r *http.Request, t string) (string, bool) {
	id := r.PathValue("artifact")
	if !artifactID.MatchString(id) {
		fail(w, 400, "invalid_artifact_id", "Invalid artifact ID")
		return "", false
	}
	return "/threads/" + t + "/artifacts/" + id, true
}

func (a *API) threadArtifact(w http.ResponseWriter, r *http.Request, ag *agents.Agent, t string) {
	path, good := artifactPath(w, r, t)
	if !good {
		return
	}
	var body []byte
	if r.Method == http.MethodPut || r.Method == http.MethodPost {
		body, good = readBody(w, r)
		if !good {
			return
		}
	}
	switch r.Pattern {
	case "GET /api/agents/{agent}/threads/{thread}/artifacts/{artifact}/history":
		path += "/history"
	case "POST /api/agents/{agent}/threads/{thread}/artifacts/{artifact}/workspace":
		path += "/workspace"
	}
	a.relay(w, r, ag, r.Method, path, body, http.Header{"Content-Type": {"application/json"}})
}

// Downloads read the artifact from its runtime, not a browser-uploaded body or an arbitrary host path.
func (a *API) downloadArtifact(w http.ResponseWriter, r *http.Request, ag *agents.Agent, t string) {
	path, good := artifactPath(w, r, t)
	if !good {
		return
	}
	if r.Method == http.MethodPost {
		if _, good := readBody(w, r); !good {
			return
		}
	}
	if r.Method == http.MethodPost && a.SaveDialog == nil {
		fail(w, 501, "not_supported", "Saving through a dialog needs the desktop app.")
		return
	}
	resp, err := a.Runtimes.Call(r.Context(), ag.ID, http.MethodGet, path, nil, nil)
	if err != nil {
		runtimeFailure(w, r, ag, err)
		return
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		fail(w, 502, "invalid_artifact", "The artifact could not be read.")
		return
	}
	if resp.StatusCode != http.StatusOK {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		w.Write(data)
		return
	}
	var result struct {
		Data struct {
			Content string `json:"content"`
			Type    string `json:"type"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &result) != nil || len(result.Data.Content) > 64<<10 {
		fail(w, 502, "invalid_artifact", "The artifact could not be read.")
		return
	}
	ext := map[string]string{"markdown": ".md", "code": ".txt", "html": ".html", "csv": ".csv"}[result.Data.Type]
	if ext == "" {
		fail(w, 502, "invalid_artifact", "Unknown artifact type.")
		return
	}
	name := r.PathValue("artifact") + ext
	if r.Method == http.MethodPost {
		target, err := a.SaveDialog(name)
		if err != nil {
			fail(w, 500, "save_failed", "The save dialog failed.")
			return
		}
		if target == "" {
			ok(w, map[string]any{"cancelled": true})
			return
		}
		if err := os.WriteFile(target, []byte(result.Data.Content), 0o600); err != nil {
			fail(w, 500, "save_failed", "Could not write the file: "+err.Error())
			return
		}
		ok(w, map[string]any{"path": target})
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(result.Data.Content))
}
