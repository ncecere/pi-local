package api

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/teams"
)

// Manager is what the API needs from the app itself for the agent manager.
type Manager interface {
	About() map[string]any
	Reveal(path string) error
}

func (a *API) manageRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/agents/{agent}/config", a.withAgent(a.getConfig))
	m.HandleFunc("PUT /api/agents/{agent}/config", a.withAgent(a.putConfig))
	m.HandleFunc("POST /api/agents/{agent}/duplicate", a.withAgent(a.duplicateAgent))
	m.HandleFunc("POST /api/agents/{agent}/wake", a.withAgent(a.wakeAgent))
	m.HandleFunc("POST /api/agents/{agent}/sleep", a.withAgent(a.sleepAgent))
	m.HandleFunc("GET /api/agents/{agent}/logs", a.withAgent(a.agentLogs))
	m.HandleFunc("GET /api/agents/{agent}/export", a.withAgent(a.exportAgent))
	m.HandleFunc("POST /api/agents/{agent}/export-save", a.withAgent(a.exportSave))
	m.HandleFunc("POST /api/choose-folder", a.chooseFolder)
	m.HandleFunc("POST /api/agents/import", a.importAgent)
	m.HandleFunc("GET /api/about", func(w http.ResponseWriter, r *http.Request) { ok(w, a.Manager.About()) })
	m.HandleFunc("POST /api/reveal", a.reveal)

	m.HandleFunc("GET /api/teams", a.listTeams)
	m.HandleFunc("POST /api/teams", a.createTeam)
	m.HandleFunc("PATCH /api/teams/{team}", a.updateTeam)
	m.HandleFunc("DELETE /api/teams/{team}", a.deleteTeam)
}

func (a *API) getConfig(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	raw, err := a.Agents.ConfigText(ag.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not read agent.yaml")
		return
	}
	ok(w, map[string]string{"yaml": string(raw)})
}

func (a *API) putConfig(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	var in struct {
		YAML string `json:"yaml"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	cfg, err := agents.ParseConfig([]byte(in.YAML))
	if err != nil {
		agentFailure(w, err)
		return
	}
	updated, err := a.Agents.Update(r.Context(), ag.ID, func(c *agents.Config) { *c = cfg })
	if err != nil {
		agentFailure(w, err)
		return
	}
	ok(w, a.AgentJSON(updated))
}

func (a *API) duplicateAgent(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	var in struct {
		Name string `json:"name"`
	}
	if r.ContentLength != 0 && !decodeBody(w, r, &in) {
		return
	}
	cfg := ag.Config
	cfg.CanCall = append([]string(nil), ag.Config.CanCall...)
	cfg.Name = strings.TrimSpace(in.Name)
	if cfg.Name == "" {
		cfg.Name = ag.Config.Name + " copy"
		if len([]rune(cfg.Name)) > agents.MaxNameChars {
			cfg.Name = string([]rune(ag.Config.Name)[:agents.MaxNameChars-5]) + " copy"
		}
	}
	dup, err := a.Agents.Create(r.Context(), cfg)
	if err != nil {
		agentFailure(w, err)
		return
	}
	created(w, a.AgentJSON(dup))
}

func (a *API) wakeAgent(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	if err := a.Runtimes.Wake(r.Context(), ag.ID); err != nil {
		runtimeFailure(w, r, ag, err)
		return
	}
	ok(w, a.AgentJSON(ag))
}

func (a *API) sleepAgent(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	a.Runtimes.Stop(ag.ID)
	ok(w, a.AgentJSON(ag))
}

func (a *API) agentLogs(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	n, _ := strconv.Atoi(r.URL.Query().Get("lines"))
	if n <= 0 {
		n = 300
	}
	n = min(n, 2000)
	path := filepath.Join(ag.LogDir(), "runtime.log")
	lines, err := tailLines(path, n)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		fail(w, http.StatusInternalServerError, "internal", "could not read the log")
		return
	}
	if lines == nil {
		lines = []string{}
	}
	ok(w, map[string]any{"path": path, "lines": lines})
}

// tailLines reads the last n lines of a file, reading at most its last 1 MiB.
func tailLines(path string, n int) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	const window = 1 << 20
	offset := max(info.Size()-window, 0)
	buf := make([]byte, info.Size()-offset)
	if _, err := f.ReadAt(buf, offset); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	text := strings.TrimRight(string(buf), "\n")
	if text == "" {
		return []string{}, nil
	}
	lines := strings.Split(text, "\n")
	if offset > 0 && len(lines) > 1 {
		lines = lines[1:] // the first was cut by the window
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines, nil
}

var unsafeFileChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// exportAgent zips agent.yaml and, with conversations, its storage (after putting the agent to sleep, so the file is
// whole and nothing writes it while it is read).
// exportArchive zips agent.yaml and, with conversations, its storage (after putting the agent to sleep, so the file
// is whole and nothing writes it while it is read). It returns the archive and a file name for it.
func (a *API) exportArchive(ag *agents.Agent, withConversations bool) ([]byte, string, error) {
	cfg, err := a.Agents.ConfigText(ag.ID)
	if err != nil {
		return nil, "", fmt.Errorf("could not read agent.yaml")
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name string, data []byte) error {
		f, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Now()})
		if err != nil {
			return err
		}
		_, err = f.Write(data)
		return err
	}
	if err := add("agent.yaml", cfg); err != nil {
		return nil, "", err
	}
	if withConversations {
		a.Runtimes.Stop(ag.ID)
		for _, name := range []string{"state.sqlite", "state.sqlite-wal"} {
			data, err := os.ReadFile(filepath.Join(ag.Dir, name))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, "", fmt.Errorf("could not read the agent's conversations")
			}
			if err := add(name, data); err != nil {
				return nil, "", err
			}
		}
	}
	if err := zw.Close(); err != nil {
		return nil, "", err
	}
	name := strings.Trim(unsafeFileChars.ReplaceAllString(ag.Config.Name, "-"), "-")
	if name == "" {
		name = "agent"
	}
	if withConversations {
		name += "-with-conversations"
	}
	return buf.Bytes(), name + ".zip", nil
}

func (a *API) exportAgent(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	data, name, err := a.exportArchive(ag, r.URL.Query().Get("conversations") == "true")
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

// exportSave asks where to save the archive (a native Save dialog, in the desktop app) and writes it there. Without
// a dialog (the headless server) it answers 501, and the UI downloads GET …/export instead.
func (a *API) exportSave(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	if a.SaveDialog == nil {
		fail(w, http.StatusNotImplemented, "not_supported", "Saving through a dialog needs the desktop app.")
		return
	}
	var in struct {
		Conversations bool `json:"conversations"`
	}
	if r.ContentLength != 0 && !decodeBody(w, r, &in) {
		return
	}
	data, name, err := a.exportArchive(ag, in.Conversations)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	path, err := a.SaveDialog(name)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "The save dialog failed: "+err.Error())
		return
	}
	if path == "" {
		ok(w, map[string]any{"cancelled": true})
		return
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "Could not write "+path+": "+err.Error())
		return
	}
	ok(w, map[string]any{"path": path})
}

// chooseFolder asks for a folder with the native dialog (a coding agent's project folder). 501 without one: the UI
// asks for the path instead.
func (a *API) chooseFolder(w http.ResponseWriter, r *http.Request) {
	if a.FolderDialog == nil {
		fail(w, http.StatusNotImplemented, "not_supported", "Choosing a folder needs the desktop app: type its path.")
		return
	}
	path, err := a.FolderDialog("Choose the project folder")
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "The folder dialog failed: "+err.Error())
		return
	}
	if path == "" {
		ok(w, map[string]any{"cancelled": true})
		return
	}
	ok(w, map[string]any{"path": path})
}

const maxImportBytes = 1 << 30

func (a *API) importAgent(w http.ResponseWriter, r *http.Request) {
	tmp, err := os.CreateTemp("", "pi-local-import-*.zip")
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not receive the archive")
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	n, err := io.Copy(tmp, io.LimitReader(r.Body, maxImportBytes+1))
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid_archive", "The archive could not be received.")
		return
	}
	if n > maxImportBytes {
		fail(w, http.StatusRequestEntityTooLarge, "too_large", "An agent archive is at most 1 GiB.")
		return
	}
	if n == 0 {
		fail(w, http.StatusBadRequest, "invalid_archive", "The archive is empty. (Send the file's bytes, not a Blob.)")
		return
	}
	zr, err := zip.NewReader(tmp, n)
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid_archive", "That isn't a zip file.")
		return
	}
	files := map[string][]byte{}
	// Only the files an export writes, at the top level; anything else is ignored (never written anywhere).
	for _, f := range zr.File {
		name := f.Name
		if name != "agent.yaml" && name != "state.sqlite" && name != "state.sqlite-wal" {
			continue
		}
		limit := int64(maxImportBytes)
		if name == "agent.yaml" {
			limit = 256 << 10
		}
		if f.UncompressedSize64 > uint64(limit) {
			fail(w, http.StatusBadRequest, "invalid_archive", name+" is too large.")
			return
		}
		rc, err := f.Open()
		if err != nil {
			fail(w, http.StatusBadRequest, "invalid_archive", "The archive is damaged.")
			return
		}
		data, err := io.ReadAll(io.LimitReader(rc, limit+1))
		rc.Close()
		if err != nil || int64(len(data)) > limit {
			fail(w, http.StatusBadRequest, "invalid_archive", "The archive is damaged.")
			return
		}
		files[name] = data
	}
	raw, found := files["agent.yaml"]
	if !found {
		fail(w, http.StatusBadRequest, "invalid_archive", "The archive has no agent.yaml: export an agent from Pi Local first.")
		return
	}
	if data, has := files["state.sqlite"]; has && !bytes.HasPrefix(data, []byte("SQLite format 3\x00")) {
		fail(w, http.StatusBadRequest, "invalid_archive", "The archive's state.sqlite isn't a SQLite database.")
		return
	}
	cfg, err := agents.ParseConfig(raw)
	if err != nil {
		var inv *agents.InvalidError
		if errors.As(err, &inv) {
			fail(w, http.StatusBadRequest, "invalid_archive", inv.Message)
			return
		}
		fail(w, http.StatusBadRequest, "invalid_archive", err.Error())
		return
	}
	delete(files, "agent.yaml")
	ag, err := a.Agents.Import(r.Context(), cfg, files)
	if err != nil {
		var inv *agents.InvalidError
		if errors.As(err, &inv) {
			fail(w, http.StatusBadRequest, "invalid_archive", inv.Message)
			return
		}
		agentFailure(w, err)
		return
	}
	created(w, a.AgentJSON(ag))
}

func (a *API) reveal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Target  string `json:"target"`
		AgentID string `json:"agentId"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	var path string
	switch in.Target {
	case "data":
		path, _ = a.Manager.About()["dataDir"].(string)
	case "agent", "workspace":
		ag, err := a.Agents.Get(in.AgentID)
		if err != nil {
			fail(w, http.StatusNotFound, "not_found", "Agent not found")
			return
		}
		path = ag.Dir
		if in.Target == "workspace" {
			path = ag.WorkspaceDir()
			os.MkdirAll(path, 0o700)
		}
	default:
		fail(w, http.StatusBadRequest, "invalid_target", "Show the data folder, an agent's folder or its workspace.")
		return
	}
	if err := a.Manager.Reveal(path); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not open the folder")
		return
	}
	ok(w, map[string]bool{"ok": true})
}

// --- teams ----------------------------------------------------------------------------------------------------

func teamFailure(w http.ResponseWriter, err error) {
	var te *teams.Error
	switch {
	case errors.As(err, &te):
		fail(w, http.StatusBadRequest, te.Code, te.Message)
	case errors.Is(err, teams.ErrNotFound):
		fail(w, http.StatusNotFound, "not_found", "Team not found")
	default:
		fail(w, http.StatusInternalServerError, "internal", "Something went wrong saving the team.")
	}
}

func (a *API) listTeams(w http.ResponseWriter, r *http.Request) {
	list, err := a.Teams.List(r.Context())
	if err != nil {
		teamFailure(w, err)
		return
	}
	ok(w, list)
}

func (a *API) createTeam(w http.ResponseWriter, r *http.Request) {
	var in teams.Input
	if !decodeBody(w, r, &in) {
		return
	}
	t, err := a.Teams.Create(r.Context(), in)
	if err != nil {
		teamFailure(w, err)
		return
	}
	created(w, t)
}

func (a *API) updateTeam(w http.ResponseWriter, r *http.Request) {
	var in teams.Input
	if !decodeBody(w, r, &in) {
		return
	}
	t, err := a.Teams.Update(r.Context(), r.PathValue("team"), in)
	if err != nil {
		teamFailure(w, err)
		return
	}
	ok(w, t)
}

func (a *API) deleteTeam(w http.ResponseWriter, r *http.Request) {
	if err := a.Teams.Delete(r.Context(), r.PathValue("team")); err != nil {
		teamFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}
