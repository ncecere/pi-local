package api

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/approvals"
)

func (a *API) toolRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/approvals", a.listApprovals)
	m.HandleFunc("GET /api/agents/{agent}/approvals", a.withAgent(a.agentApprovals))
	m.HandleFunc("POST /api/agents/{agent}/approvals/{approval}", a.withAgent(a.decideApproval))
	m.HandleFunc("POST /api/agents/{agent}/attachments", a.withAgent(a.uploadAttachment))
}

func (a *API) listApprovals(w http.ResponseWriter, r *http.Request) {
	list, err := a.Approvals.List(r.Context(), r.URL.Query().Get("status") == "all")
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not read approvals")
		return
	}
	ok(w, list)
}

func (a *API) agentApprovals(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	list, err := a.Approvals.ForAgent(r.Context(), ag.ID, r.URL.Query().Get("thread"))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not read approvals")
		return
	}
	ok(w, list)
}

func (a *API) decideApproval(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	var in struct {
		Decision string `json:"decision"`
		Reason   string `json:"reason"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if in.Decision != "approve" && in.Decision != "deny" {
		fail(w, http.StatusBadRequest, "invalid_decision", "Approve or deny.")
		return
	}
	got, err := a.Approvals.Decide(r.Context(), ag.ID, r.PathValue("approval"), in.Decision == "approve", in.Reason)
	switch {
	case errors.Is(err, approvals.ErrNotFound):
		fail(w, http.StatusNotFound, "approval_not_found", "That request is not here.")
	case errors.Is(err, approvals.ErrDecided):
		fail(w, http.StatusConflict, "approval_decided", "That request no longer waits: it was decided, timed out or cancelled.")
	case err != nil:
		fail(w, http.StatusInternalServerError, "internal", "could not record the decision")
	default:
		ok(w, got)
	}
}

const maxAttachmentBytes = 100 << 20

// cleanFileName keeps a file's name readable and harmless: no directories, no control characters, no leading dot.
func cleanFileName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '/' || r == ':' {
			return -1
		}
		return r
	}, name)
	name = strings.TrimLeft(strings.TrimSpace(name), ".")
	if r := []rune(name); len(r) > 120 {
		ext := filepath.Ext(name)
		if len([]rune(ext)) > 20 {
			ext = ""
		}
		name = string(r[:120-len([]rune(ext))]) + ext
	}
	if name == "" {
		name = "file"
	}
	return name
}

// uploadAttachment saves a file in the agent's workspace (attachments/<day>/<name>), for its read tool to open.
func (a *API) uploadAttachment(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	if !slices.Contains(ag.Config.Workspace.Tools, "read") {
		fail(w, http.StatusConflict, "no_read_tool", ag.Config.Name+" can't open files: give it the read tool (its Tools settings) to attach files.")
		return
	}
	name := cleanFileName(r.URL.Query().Get("name"))
	day := time.Now().Format(time.DateOnly)
	base, relative := ag.AttachmentsDir()
	dir := filepath.Join(base, day)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not make the attachments folder")
		return
	}
	// A name already taken gets " (2)", " (3)" … ; O_EXCL so two uploads never share one.
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	var f *os.File
	var final string
	for i := 1; i < 1000; i++ {
		final = name
		if i > 1 {
			final = fmt.Sprintf("%s (%d)%s", stem, i, ext)
		}
		var err error
		f, err = os.OpenFile(filepath.Join(dir, final), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrExist) {
			fail(w, http.StatusInternalServerError, "internal", "could not save the file")
			return
		}
	}
	if f == nil {
		fail(w, http.StatusConflict, "name_taken", "Too many files are called "+name+" today.")
		return
	}
	n, err := io.Copy(f, io.LimitReader(r.Body, maxAttachmentBytes+1))
	f.Close()
	path := filepath.Join(dir, final)
	if err != nil || n > maxAttachmentBytes || n == 0 {
		os.Remove(path)
		switch {
		case n > maxAttachmentBytes:
			fail(w, http.StatusRequestEntityTooLarge, "too_large", "A file is at most 100 MiB.")
		case n == 0:
			fail(w, http.StatusBadRequest, "empty_file", "The file is empty. (Send its bytes, not a Blob.)")
		default:
			fail(w, http.StatusBadRequest, "upload_failed", "The file couldn't be received.")
		}
		return
	}
	mediaType := mime.TypeByExtension(strings.ToLower(ext))
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	// The path the agent's read tool takes: relative to its own workspace, or absolute in its temporary folder.
	shown := filepath.Join(dir, final)
	if relative {
		shown = filepath.Join("attachments", day, final)
	}
	created(w, map[string]any{"path": filepath.ToSlash(shown), "name": final, "size": n, "mediaType": mediaType})
}
