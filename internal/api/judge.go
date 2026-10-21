package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/ncecere/pi-local/internal/judge"
)

func (a *API) judgeRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/settings/judgments", a.judgeSettings)
	m.HandleFunc("PUT /api/settings/judgments", a.saveJudgeSettings)
	m.HandleFunc("GET /api/settings/judgments/models", a.judgeModels)
	m.HandleFunc("POST /api/settings/judgments/test", a.testJudge)
	m.HandleFunc("POST /api/route", a.routeMessage)
}

func judgeFailure(w http.ResponseWriter, err error) {
	var je *judge.Error
	if errors.As(err, &je) {
		fail(w, je.Status, je.Code, je.Message)
		return
	}
	fail(w, http.StatusInternalServerError, "internal", err.Error())
}

func (a *API) judgeSettings(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]any{"settings": a.Judge.Settings(), "uses": judge.Uses, "defaultUrl": judge.DefaultURL, "defaultModel": judge.DefaultModel})
}

func (a *API) saveJudgeSettings(w http.ResponseWriter, r *http.Request) {
	var in judge.Input
	if !decodeBody(w, r, &in) {
		return
	}
	st, err := a.Judge.Save(in)
	if err != nil {
		judgeFailure(w, err)
		return
	}
	ok(w, st)
}

func (a *API) judgeModels(w http.ResponseWriter, r *http.Request) {
	names, err := a.Judge.Models(r.Context())
	if err != nil {
		judgeFailure(w, err)
		return
	}
	ok(w, names)
}

// testJudge asks one yes/no question with the saved settings, to check the service, key and model.
func (a *API) testJudge(w http.ResponseWriter, r *http.Request) {
	answers, model, err := a.Judge.Ask(r.Context(), "Please refund the duplicate charge on my bill.", map[string]judge.Question{
		"billing": {Type: "noul", Instructions: "Is this message about billing?"},
	})
	if err != nil {
		judgeFailure(w, err)
		return
	}
	ok(w, map[string]any{"model": model, "answer": answers["billing"]})
}

// routeMessage picks the agent for a message sent without one (agent routing): {text} → a route. 409 off: the UI
// asks the person instead.
func (a *API) routeMessage(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text string `json:"text"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Text) == "" {
		fail(w, http.StatusBadRequest, "invalid_text", "Say what the message is.")
		return
	}
	var candidates []judge.Candidate
	for _, ag := range a.Agents.List() {
		candidates = append(candidates, judge.Candidate{ID: ag.ID, Name: ag.Config.Name, Description: ag.Config.Description, Kind: ag.Config.Kind})
	}
	route, err := a.Judge.RouteMessage(r.Context(), in.Text, candidates)
	if err != nil {
		judgeFailure(w, err)
		return
	}
	ok(w, route)
}
