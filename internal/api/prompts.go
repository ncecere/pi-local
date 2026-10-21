package api

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"

	"github.com/ncecere/pi-local/internal/prompts"
)

func (a *API) promptRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/prompts", a.listPrompts)
	m.HandleFunc("POST /api/prompts", a.createPrompt)
	m.HandleFunc("POST /api/prompts/import", a.importPrompts)
	m.HandleFunc("GET /api/prompts/export", a.exportPrompts)
	m.HandleFunc("POST /api/prompts/export-save", a.exportPromptsSave)
	m.HandleFunc("GET /api/prompts/{id}", a.getPrompt)
	m.HandleFunc("PUT /api/prompts/{id}", a.updatePrompt)
	m.HandleFunc("DELETE /api/prompts/{id}", a.deletePrompt)
	m.HandleFunc("GET /api/prompts/{id}/export", a.exportPrompt)
}

func promptFailure(w http.ResponseWriter, err error) {
	var pe *prompts.Error
	if errors.As(err, &pe) {
		fail(w, pe.Status, pe.Code, pe.Message)
		return
	}
	slog.Error("prompts", "err", err)
	fail(w, http.StatusInternalServerError, "internal", "Something went wrong with the prompt.")
}

func (a *API) listPrompts(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]any{"prompts": a.Prompts.List()})
}

func (a *API) createPrompt(w http.ResponseWriter, r *http.Request) {
	var in prompts.Input
	if !decodeBody(w, r, &in) {
		return
	}
	p, err := a.Prompts.Create(in)
	if err != nil {
		promptFailure(w, err)
		return
	}
	created(w, p)
}

func (a *API) getPrompt(w http.ResponseWriter, r *http.Request) {
	p, err := a.Prompts.Get(r.PathValue("id"))
	if err != nil {
		promptFailure(w, err)
		return
	}
	ok(w, p)
}

func (a *API) updatePrompt(w http.ResponseWriter, r *http.Request) {
	var in prompts.Input
	if !decodeBody(w, r, &in) {
		return
	}
	p, err := a.Prompts.Update(r.PathValue("id"), in)
	if err != nil {
		promptFailure(w, err)
		return
	}
	ok(w, p)
}

func (a *API) deletePrompt(w http.ResponseWriter, r *http.Request) {
	if err := a.Prompts.Delete(r.PathValue("id")); err != nil {
		promptFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

// importPrompts keeps prompts from a file's raw bytes: one Markdown file (?name= is its file name, the title of one
// without front matter) or a zip of them, an export.
func (a *API) importPrompts(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, prompts.MaxImportBytes+1))
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid_request", "The upload could not be received.")
		return
	}
	imported, skipped, err := a.Prompts.Import(raw, r.URL.Query().Get("name"))
	if err != nil {
		promptFailure(w, err)
		return
	}
	created(w, map[string]any{"prompts": imported, "skipped": skipped})
}

func (a *API) exportPrompt(w http.ResponseWriter, r *http.Request) {
	p, err := a.Prompts.Get(r.PathValue("id"))
	if err != nil {
		promptFailure(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.md"`, p.ID))
	w.Write(prompts.Marshal(*p))
}

func (a *API) exportPrompts(w http.ResponseWriter, r *http.Request) {
	data, err := a.Prompts.ExportZip()
	if err != nil {
		promptFailure(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="pi-local-prompts.zip"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

// exportPromptsSave asks where to save the library's zip (the desktop app's Save dialog) and writes it; 501 without a
// dialog (the UI downloads GET /api/prompts/export instead).
func (a *API) exportPromptsSave(w http.ResponseWriter, r *http.Request) {
	if a.SaveDialog == nil {
		fail(w, http.StatusNotImplemented, "not_supported", "Saving through a dialog needs the desktop app.")
		return
	}
	data, err := a.Prompts.ExportZip()
	if err != nil {
		promptFailure(w, err)
		return
	}
	path, err := a.SaveDialog("pi-local-prompts.zip")
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
