package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/schedules"
	"github.com/ncecere/pi-local/internal/search"
)

func (a *API) alwaysRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/schedules", a.listSchedules)
	m.HandleFunc("GET /api/agents/{agent}/schedules", a.withAgent(a.agentSchedules))
	m.HandleFunc("POST /api/agents/{agent}/schedules", a.withAgent(a.createSchedule))
	m.HandleFunc("PATCH /api/schedules/{id}", a.updateSchedule)
	m.HandleFunc("DELETE /api/schedules/{id}", a.deleteSchedule)
	m.HandleFunc("POST /api/schedules/{id}/run", a.runSchedule)
	m.HandleFunc("GET /api/schedules/{id}/runs", a.scheduleRuns)
	m.HandleFunc("GET /api/search", a.searchMessages)
	m.HandleFunc("GET /api/update", a.getUpdate)
	m.HandleFunc("POST /api/update/check", a.checkUpdate)
	m.HandleFunc("POST /api/update/install", a.installUpdate)
	m.HandleFunc("PUT /api/update/settings", a.updateSettings)
	m.HandleFunc("GET /api/settings/desktop", a.getDesktop)
	m.HandleFunc("PUT /api/settings/desktop", a.putDesktop)
}

func scheduleFailure(w http.ResponseWriter, err error) {
	var se *schedules.Error
	if errors.As(err, &se) {
		fail(w, se.Status, se.Code, se.Message)
		return
	}
	fail(w, http.StatusInternalServerError, "internal", "Something went wrong with the schedule.")
}

func (a *API) listSchedules(w http.ResponseWriter, r *http.Request) {
	list, err := a.Schedules.List(r.Context(), "")
	if err != nil {
		scheduleFailure(w, err)
		return
	}
	ok(w, list)
}

func (a *API) agentSchedules(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	list, err := a.Schedules.List(r.Context(), ag.ID)
	if err != nil {
		scheduleFailure(w, err)
		return
	}
	ok(w, list)
}

func (a *API) createSchedule(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	var in schedules.Input
	if !decodeBody(w, r, &in) {
		return
	}
	s, err := a.Schedules.Create(r.Context(), ag.ID, "user", "", in)
	if err != nil {
		scheduleFailure(w, err)
		return
	}
	created(w, s)
}

func (a *API) updateSchedule(w http.ResponseWriter, r *http.Request) {
	var in schedules.Input
	if !decodeBody(w, r, &in) {
		return
	}
	s, err := a.Schedules.Update(r.Context(), r.PathValue("id"), in)
	if err != nil {
		scheduleFailure(w, err)
		return
	}
	ok(w, s)
}

func (a *API) deleteSchedule(w http.ResponseWriter, r *http.Request) {
	if _, err := a.Schedules.Delete(r.Context(), r.PathValue("id"), ""); err != nil {
		scheduleFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

func (a *API) runSchedule(w http.ResponseWriter, r *http.Request) {
	run, err := a.Schedules.Fire(r.Context(), r.PathValue("id"))
	if err != nil {
		scheduleFailure(w, err)
		return
	}
	ok(w, run)
}

func (a *API) scheduleRuns(w http.ResponseWriter, r *http.Request) {
	n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if n <= 0 || n > 200 {
		n = 50
	}
	runs, err := a.Schedules.Runs(r.Context(), r.PathValue("id"), n)
	if err != nil {
		scheduleFailure(w, err)
		return
	}
	ok(w, runs)
}

func (a *API) searchMessages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if len(q) > 200 {
		q = q[:200]
	}
	hits, err := a.Search.Search(r.Context(), q, 30)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "search failed")
		return
	}
	// Conversations of agents that are gone are left out.
	out := hits[:0]
	for _, h := range hits {
		if a.Agents.Exists(h.AgentID) {
			out = append(out, h)
		}
	}
	ok(w, map[string]any{"results": out})
}

// getThreadIndexed relays a thread's whole view and keeps its text searchable.
func (a *API) getThreadIndexed(w http.ResponseWriter, r *http.Request, ag *agents.Agent, t string) {
	resp, err := a.Runtimes.Call(r.Context(), ag.ID, http.MethodGet, "/threads/"+t, nil, nil)
	if err != nil {
		runtimeFailure(w, r, ag, err)
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return
	}
	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	w.Write(body)
	if resp.StatusCode == http.StatusOK && a.Search != nil {
		go func() {
			var title string
			if th, err := a.Threads.Get(context.Background(), ag.ID, t); err == nil {
				title = th.Title
			}
			var wrapped struct {
				Data json.RawMessage `json:"data"`
			}
			if json.Unmarshal(body, &wrapped) == nil {
				a.Search.Put(context.Background(), ag.ID, t, title, search.Text([]byte(wrapped.Data)))
			}
		}()
	}
}

// Desktop is what the desktop app's settings say (launch at login), nil in the headless server.
type Desktop interface {
	LaunchAtLogin() (bool, error)
	SetLaunchAtLogin(on bool) error
}

func (a *API) getDesktop(w http.ResponseWriter, r *http.Request) {
	if a.Desktop == nil {
		ok(w, map[string]any{"available": false, "launchAtLogin": false})
		return
	}
	on, err := a.Desktop.LaunchAtLogin()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	ok(w, map[string]any{"available": true, "launchAtLogin": on})
}

func (a *API) putDesktop(w http.ResponseWriter, r *http.Request) {
	if a.Desktop == nil {
		fail(w, http.StatusNotImplemented, "not_supported", "Launching at login needs the desktop app.")
		return
	}
	var in struct {
		LaunchAtLogin bool `json:"launchAtLogin"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if err := a.Desktop.SetLaunchAtLogin(in.LaunchAtLogin); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "Could not change launching at login: "+err.Error())
		return
	}
	ok(w, map[string]any{"available": true, "launchAtLogin": in.LaunchAtLogin})
}

// --- updates ------------------------------------------------------------------------------------------------------

func (a *API) getUpdate(w http.ResponseWriter, r *http.Request) {
	if a.Updater == nil {
		fail(w, http.StatusNotImplemented, "not_supported", "Updates aren't available here.")
		return
	}
	ok(w, a.Updater.Status())
}

func (a *API) checkUpdate(w http.ResponseWriter, r *http.Request) {
	if a.Updater == nil {
		fail(w, http.StatusNotImplemented, "not_supported", "Updates aren't available here.")
		return
	}
	ok(w, a.Updater.Check(r.Context()))
}

func (a *API) installUpdate(w http.ResponseWriter, r *http.Request) {
	if a.Updater == nil {
		fail(w, http.StatusNotImplemented, "not_supported", "Updates aren't available here.")
		return
	}
	if err := a.Updater.Install(r.Context()); err != nil {
		fail(w, http.StatusConflict, "cannot_install", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": a.Updater.Status()})
}

func (a *API) updateSettings(w http.ResponseWriter, r *http.Request) {
	if a.Updater == nil {
		fail(w, http.StatusNotImplemented, "not_supported", "Updates aren't available here.")
		return
	}
	var in struct {
		AutoCheck bool `json:"autoCheck"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if err := a.Updater.SaveAutoCheck(in.AutoCheck); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not save the setting")
		return
	}
	ok(w, a.Updater.Status())
}
