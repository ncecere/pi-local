package api

import (
	"errors"
	"net/http"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/memory"
)

func (a *API) memoryRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/you", a.getYou)
	m.HandleFunc("PUT /api/you/basics", a.putBasics)
	m.HandleFunc("PUT /api/you/settings", a.guardSuggestions(a.putYouSettings))
	m.HandleFunc("GET /api/you/memories", a.listFacts)
	m.HandleFunc("POST /api/you/memories", a.addFact)
	m.HandleFunc("PATCH /api/you/memories/{id}", a.updateFact)
	m.HandleFunc("DELETE /api/you/memories/{id}", a.deleteFact)
	m.HandleFunc("POST /api/you/erase", a.eraseYou)
	m.HandleFunc("GET /api/you/export", a.exportYou)
	m.HandleFunc("GET /api/agents/{agent}/memory", a.withAgent(a.listNotes))
	m.HandleFunc("POST /api/agents/{agent}/memory", a.withAgent(a.addNote))
	m.HandleFunc("PATCH /api/agents/{agent}/memory/{note}", a.withAgent(a.updateNote))
	m.HandleFunc("DELETE /api/agents/{agent}/memory/{note}", a.withAgent(a.deleteNote))
	m.HandleFunc("DELETE /api/agents/{agent}/memory", a.withAgent(a.resetNotes))
}

func memoryFailure(w http.ResponseWriter, err error) {
	var me *memory.Error
	if errors.As(err, &me) {
		fail(w, me.Status, me.Code, me.Message)
		return
	}
	fail(w, http.StatusInternalServerError, "internal", err.Error())
}

// getYou: the About me card (or its defaults), whether it was saved, and the categories.
func (a *API) getYou(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]any{
		"basics":      a.Memory.GetBasics(a.MemoryDefaults()),
		"saved":       a.Memory.HasBasics(),
		"categories":  memory.Categories,
		"shareable":   memory.Shareable,
		"suggestions": a.suggestionSettings(),
	})
}

// suggestionSettings: whether agents suggest facts from conversations, and whether fast judgments filter them.
func (a *API) suggestionSettings() map[string]bool {
	return map[string]bool{"enabled": a.Memory.SuggestionsOn(), "judged": a.Judge != nil && a.Judge.On("memory")}
}

// putYouSettings: the one system-wide switch for suggestions from conversations.
func (a *API) putYouSettings(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Suggestions *bool `json:"suggestions"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if in.Suggestions != nil {
		if err := a.Memory.SetSuggestions(*in.Suggestions); err != nil {
			memoryFailure(w, err)
			return
		}
	}
	ok(w, a.suggestionSettings())
}

func (a *API) putBasics(w http.ResponseWriter, r *http.Request) {
	var in memory.Basics
	if !decodeBody(w, r, &in) {
		return
	}
	b, err := a.Memory.SetBasics(in)
	if err != nil {
		memoryFailure(w, err)
		return
	}
	ok(w, b)
}

// listFacts: ?status=active|suggested (all when absent).
func (a *API) listFacts(w http.ResponseWriter, r *http.Request) {
	facts, err := a.Memory.Facts(r.Context(), r.URL.Query().Get("status"))
	if err != nil {
		memoryFailure(w, err)
		return
	}
	if facts == nil {
		facts = []*memory.Fact{}
	}
	ok(w, facts)
}

// addFact: the person adds something about themselves {category, text} (their own words, known).
func (a *API) addFact(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Category string `json:"category"`
		Text     string `json:"text"`
		Pinned   bool   `json:"pinned"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	f, err := a.Memory.AddFact(r.Context(), memory.FactInput{Category: in.Category, Text: in.Text, Trust: "said", Active: true, Pinned: in.Pinned})
	if err != nil {
		memoryFailure(w, err)
		return
	}
	created(w, f)
}

func (a *API) updateFact(w http.ResponseWriter, r *http.Request) {
	var in memory.FactChange
	if !decodeBody(w, r, &in) {
		return
	}
	f, err := a.Memory.UpdateFact(r.Context(), r.PathValue("id"), in)
	if err != nil {
		memoryFailure(w, err)
		return
	}
	ok(w, f)
}

func (a *API) deleteFact(w http.ResponseWriter, r *http.Request) {
	if err := a.Memory.DeleteFact(r.Context(), r.PathValue("id")); err != nil {
		memoryFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

// eraseYou forgets everything about the person: {confirm: "erase"}.
func (a *API) eraseYou(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Confirm string `json:"confirm"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if in.Confirm != "erase" {
		fail(w, http.StatusBadRequest, "confirm", `Send {"confirm": "erase"} to forget everything about you.`)
		return
	}
	if err := a.Memory.EraseFacts(r.Context()); err != nil {
		memoryFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

// exportYou: everything about the person, as JSON.
func (a *API) exportYou(w http.ResponseWriter, r *http.Request) {
	facts, err := a.Memory.Facts(r.Context(), "")
	if err != nil {
		memoryFailure(w, err)
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="pi-local-about-you.json"`)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"basics": a.Memory.GetBasics(a.MemoryDefaults()), "memories": facts})
}

func (a *API) listNotes(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	notes, err := a.Memory.Notes(ag.Dir)
	if err != nil {
		memoryFailure(w, err)
		return
	}
	ok(w, notes)
}

func (a *API) addNote(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	var in struct {
		Text string `json:"text"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	n, err := a.Memory.AddNote(ag.ID, ag.Dir, in.Text, "")
	if err != nil {
		memoryFailure(w, err)
		return
	}
	created(w, n)
}

func (a *API) updateNote(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	var in struct {
		Text string `json:"text"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	n, err := a.Memory.UpdateNote(ag.ID, ag.Dir, r.PathValue("note"), in.Text)
	if err != nil {
		memoryFailure(w, err)
		return
	}
	ok(w, n)
}

func (a *API) deleteNote(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	if err := a.Memory.DeleteNote(ag.ID, ag.Dir, r.PathValue("note")); err != nil {
		memoryFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

func (a *API) resetNotes(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	if err := a.Memory.DeleteNote(ag.ID, ag.Dir, ""); err != nil {
		memoryFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}
