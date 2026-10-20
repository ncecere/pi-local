package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/models"
	"github.com/ncecere/pi-local/internal/usage"
)

func (a *API) modelRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/providers", a.listProviders)
	m.HandleFunc("POST /api/providers", a.createProvider)
	m.HandleFunc("PATCH /api/providers/{provider}", a.updateProvider)
	m.HandleFunc("DELETE /api/providers/{provider}", a.deleteProvider)
	m.HandleFunc("POST /api/providers/{provider}/discover", a.discover)
	m.HandleFunc("PUT /api/providers/{provider}/models/{model...}", a.putModel)
	m.HandleFunc("DELETE /api/providers/{provider}/models/{model...}", a.deleteModel)
	m.HandleFunc("PUT /api/settings/default-model", a.setDefaultModel)
	m.HandleFunc("GET /api/me/usage", a.usageReport)
}

func catalogFailure(w http.ResponseWriter, err error) {
	var me *models.Error
	if errors.As(err, &me) {
		body := map[string]any{"code": me.Code, "message": me.Message}
		if me.Details != nil {
			body["details"] = me.Details
		}
		writeJSON(w, me.Status, map[string]any{"error": body})
		return
	}
	slog.Error("model catalog", "err", err)
	fail(w, http.StatusInternalServerError, "internal", "Something went wrong: "+err.Error())
}

func (a *API) listProviders(w http.ResponseWriter, r *http.Request) {
	list, err := a.Catalog.Providers(r.Context())
	if err != nil {
		catalogFailure(w, err)
		return
	}
	ok(w, map[string]any{
		"kinds":          models.Kinds,
		"presets":        models.Presets,
		"providers":      a.Catalog.WithUsage(list),
		"defaultModelId": a.Catalog.DefaultModel(r.Context()),
	})
}

func (a *API) providerJSON(r *http.Request, id string) (*models.Provider, error) {
	p, err := a.Catalog.Provider(r.Context(), id)
	if err != nil {
		return nil, err
	}
	a.Catalog.WithUsage([]*models.Provider{p})
	return p, nil
}

func (a *API) createProvider(w http.ResponseWriter, r *http.Request) {
	var in models.ProviderInput
	if !decodeBody(w, r, &in) {
		return
	}
	p, err := a.Catalog.CreateProvider(r.Context(), in)
	if err != nil {
		catalogFailure(w, err)
		return
	}
	created(w, p)
}

func (a *API) updateProvider(w http.ResponseWriter, r *http.Request) {
	var in models.ProviderInput
	if !decodeBody(w, r, &in) {
		return
	}
	if _, err := a.Catalog.UpdateProvider(r.Context(), r.PathValue("provider"), in); err != nil {
		catalogFailure(w, err)
		return
	}
	p, err := a.providerJSON(r, r.PathValue("provider"))
	if err != nil {
		catalogFailure(w, err)
		return
	}
	ok(w, p)
}

func (a *API) deleteProvider(w http.ResponseWriter, r *http.Request) {
	if err := a.Catalog.DeleteProvider(r.Context(), r.PathValue("provider")); err != nil {
		catalogFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

func (a *API) discover(w http.ResponseWriter, r *http.Request) {
	list, err := a.Catalog.Discover(r.Context(), r.PathValue("provider"))
	if err != nil {
		catalogFailure(w, err)
		return
	}
	ok(w, map[string]any{"models": list})
}

func (a *API) putModel(w http.ResponseWriter, r *http.Request) {
	var in models.ModelInput
	if !decodeBody(w, r, &in) {
		return
	}
	m, err := a.Catalog.PutModel(r.Context(), r.PathValue("provider"), r.PathValue("model"), in)
	if err != nil {
		catalogFailure(w, err)
		return
	}
	m.UsedBy = len(a.Catalog.UsedBy(m.ID))
	ok(w, m)
}

func (a *API) deleteModel(w http.ResponseWriter, r *http.Request) {
	if err := a.Catalog.DeleteModel(r.Context(), r.PathValue("provider"), r.PathValue("model")); err != nil {
		catalogFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

func (a *API) setDefaultModel(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ModelID string `json:"modelId"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if err := a.Catalog.SetDefaultModel(r.Context(), in.ModelID); err != nil {
		catalogFailure(w, err)
		return
	}
	ok(w, map[string]string{"defaultModelId": a.Catalog.DefaultModel(r.Context())})
}

func (a *API) usageReport(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days != 7 && days != 30 && days != 90 {
		days = 30
	}
	ctx := r.Context()
	report, err := a.Usage.Report(ctx, days,
		func(model string) (float64, float64, bool) {
			m, err := a.Catalog.Model(ctx, model)
			if err != nil || m.InputPrice == nil || m.OutputPrice == nil {
				return 0, 0, false
			}
			return *m.InputPrice, *m.OutputPrice, true
		},
		usage.Names{
			Agent: func(id string) (string, bool) {
				ag, err := a.Agents.Get(id)
				if err != nil {
					return "", false
				}
				return ag.Config.Name, true
			},
			Model: func(id string) (string, bool) {
				if m, err := a.Catalog.Model(ctx, id); err == nil {
					return m.Name, true
				}
				return "", false
			},
		})
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not read usage")
		return
	}
	ok(w, report)
}

// modelRef turns "provider/modelId" into an agent.yaml model reference.
func modelRef(id string) (agents.ModelRef, bool) {
	provider, model, found := models.SplitModelID(id)
	if !found {
		return agents.ModelRef{}, false
	}
	return agents.ModelRef{Provider: provider, ID: model}, true
}
