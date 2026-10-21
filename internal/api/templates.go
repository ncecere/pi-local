package api

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/templates"
)

func (a *API) templateRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/templates", a.listTemplates)
	m.HandleFunc("POST /api/templates", a.importTemplate)
	m.HandleFunc("GET /api/templates/{id}/export", a.exportTemplate)
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
	return a.Templates.List()
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
