package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/templates"
)

func (a *API) templateRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/templates", a.listTemplates)
	m.HandleFunc("POST /api/templates", a.importTemplate)
	m.HandleFunc("GET /api/templates/{id}/export", a.exportTemplate)
	m.HandleFunc("POST /api/templates/{id}/export-save", a.exportTemplateSave)
	m.HandleFunc("DELETE /api/templates/{id}", a.deleteTemplate)
	m.HandleFunc("POST /api/agents/{agent}/save-template", a.withAgent(a.saveAsTemplate))
}

func templateFailure(w http.ResponseWriter, err error) {
	var te *templates.Error
	if errors.As(err, &te) {
		fail(w, te.Status, te.Code, te.Message)
		return
	}
	fail(w, http.StatusInternalServerError, "internal", err.Error())
}

// templateList is every template for the New agent gallery (empty without a store).
func (a *API) templateList() []templates.Template {
	if a.Templates == nil {
		return []templates.Template{}
	}
	list := []templates.Template{}
	for _, t := range a.Templates.List() {
		if a.templateAvailable(&t) {
			list = append(list, t)
		}
	}
	return list
}

// Capability-dependent templates are offered and accepted only with a tested, enabled connection.
func (a *API) templateAvailable(t *templates.Template) bool {
	if !t.Builtin || t.ID != "meeting-helper" {
		return true
	}
	if a.MCP == nil {
		return false
	}
	list, err := a.MCP.Connections(context.Background())
	if err != nil {
		return false
	}
	for _, c := range list {
		if c.ID != "apple_calendar" || c.State != "connected" || c.Server == nil || c.Server.Slug != "apple_calendar" {
			continue
		}
		for _, tool := range c.Server.Tools {
			if tool.Name == "calendar" && tool.ModelVisible {
				return true
			}
		}
	}
	return false
}

func (a *API) listTemplates(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]any{"templates": a.templateList(), "categories": templates.Categories})
}

// importTemplate keeps a shared template file (its YAML as the body).
func (a *API) importTemplate(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 256<<10))
	if err != nil || len(raw) == 0 {
		fail(w, http.StatusBadRequest, "empty_file", "The file is empty. (Send its bytes, not a Blob.)")
		return
	}
	t, err := a.Templates.Import(raw)
	if err != nil {
		templateFailure(w, err)
		return
	}
	created(w, t)
}

func (a *API) exportTemplate(w http.ResponseWriter, r *http.Request) {
	t, err := a.Templates.Get(r.PathValue("id"))
	if err != nil {
		templateFailure(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.pi-template.yaml"`, t.ID))
	w.Write(templates.Marshal(t))
}

// exportTemplateSave asks where to save the file (the desktop app's Save dialog) and writes it; 501 without a dialog
// (the UI downloads GET …/export instead).
func (a *API) exportTemplateSave(w http.ResponseWriter, r *http.Request) {
	if a.SaveDialog == nil {
		fail(w, http.StatusNotImplemented, "not_supported", "Saving through a dialog needs the desktop app.")
		return
	}
	t, err := a.Templates.Get(r.PathValue("id"))
	if err != nil {
		templateFailure(w, err)
		return
	}
	path, err := a.SaveDialog(t.ID + ".pi-template.yaml")
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "The save dialog failed: "+err.Error())
		return
	}
	if path == "" {
		ok(w, map[string]any{"cancelled": true})
		return
	}
	if err := os.WriteFile(path, templates.Marshal(t), 0o600); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "Could not write "+path+": "+err.Error())
		return
	}
	ok(w, map[string]any{"path": path})
}

func (a *API) deleteTemplate(w http.ResponseWriter, r *http.Request) {
	if err := a.Templates.Delete(r.PathValue("id")); err != nil {
		templateFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

// saveAsTemplate makes a template of the person's from an agent: {name?, description?}.
func (a *API) saveAsTemplate(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	var in struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if r.ContentLength != 0 && !decodeBody(w, r, &in) {
		return
	}
	cfg := ag.Config
	if strings.TrimSpace(in.Name) != "" {
		cfg.Name = strings.TrimSpace(in.Name)
	}
	if strings.TrimSpace(in.Description) != "" {
		cfg.Description = strings.TrimSpace(in.Description)
	}
	t, err := a.Templates.Save(templates.FromAgent(templates.Slug(cfg.Name), cfg))
	if err != nil {
		templateFailure(w, err)
		return
	}
	created(w, t)
}
