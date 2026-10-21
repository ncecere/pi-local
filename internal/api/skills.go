package api

import (
	"cmp"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/skills"
)

func (a *API) skillRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/skills", a.listSharedSkills)
	m.HandleFunc("POST /api/skills", a.addSharedSkill)
	m.HandleFunc("GET /api/skills/{name}", a.getSharedSkill)
	m.HandleFunc("GET /api/skills/{name}/file", a.sharedSkillFile)
	m.HandleFunc("DELETE /api/skills/{name}", a.deleteSharedSkill)

	m.HandleFunc("GET /api/agents/{agent}/skills", a.withAgent(a.agentSkills))
	m.HandleFunc("PUT /api/agents/{agent}/skills", a.withAgent(a.enableSkills))
	m.HandleFunc("POST /api/agents/{agent}/skills", a.withAgent(a.addOwnSkill))
	m.HandleFunc("GET /api/agents/{agent}/skills/{name}", a.withAgent(a.getOwnSkill))
	m.HandleFunc("GET /api/agents/{agent}/skills/{name}/file", a.withAgent(a.ownSkillFile))
	m.HandleFunc("DELETE /api/agents/{agent}/skills/{name}", a.withAgent(a.deleteOwnSkill))
}

func skillFailure(w http.ResponseWriter, err error) {
	var se *skills.Error
	if errors.As(err, &se) {
		fail(w, se.Status, se.Code, se.Message)
		return
	}
	slog.Error("skills", "err", err)
	fail(w, http.StatusInternalServerError, "internal", "Something went wrong with the skill.")
}

// agentRef is an agent named in a list.
type agentRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// sharedSkill is a shared skill in a list: with the agents that use it.
type sharedSkill struct {
	skills.Skill
	UsedBy []agentRef `json:"usedBy"`
}

func (a *API) usedBy(name string) []agentRef {
	out := []agentRef{}
	for _, ag := range a.Agents.UsingSkill(name) {
		out = append(out, agentRef{ID: ag.ID, Name: ag.Config.Name})
	}
	slices.SortFunc(out, func(x, y agentRef) int { return cmp.Compare(strings.ToLower(x.Name), strings.ToLower(y.Name)) })
	return out
}

// skillBytes reads an uploaded zip (the body's raw bytes).
func skillBytes(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	data, err := io.ReadAll(io.LimitReader(r.Body, skills.MaxZipBytes+1))
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid_request", "The upload could not be received.")
		return nil, false
	}
	if len(data) > skills.MaxZipBytes {
		fail(w, http.StatusRequestEntityTooLarge, "too_large", "A skill's zip is at most 25 MB.")
		return nil, false
	}
	if len(data) == 0 {
		fail(w, http.StatusBadRequest, "empty_file", "The file is empty. (Send its bytes, not a Blob.)")
		return nil, false
	}
	return data, true
}

func (a *API) skillFileReply(w http.ResponseWriter, r *http.Request, store *skills.Store, name string) {
	content, truncated, err := store.ReadFile(name, r.URL.Query().Get("path"))
	if err != nil {
		skillFailure(w, err)
		return
	}
	ok(w, map[string]any{"path": r.URL.Query().Get("path"), "content": content, "truncated": truncated})
}

// --- shared skills ----------------------------------------------------------------------------------------------------

func (a *API) listSharedSkills(w http.ResponseWriter, r *http.Request) {
	out := []sharedSkill{}
	for _, sk := range a.Skills.List() {
		out = append(out, sharedSkill{Skill: sk, UsedBy: a.usedBy(sk.Name)})
	}
	ok(w, map[string]any{"skills": out, "folder": a.Skills.Root})
}

// addSharedSkill: the body is a zip (SKILL.md at its top or in its one folder); ?replace=true replaces a skill of that name.
func (a *API) addSharedSkill(w http.ResponseWriter, r *http.Request) {
	data, good := skillBytes(w, r)
	if !good {
		return
	}
	sk, err := a.Skills.AddZip(data, r.URL.Query().Get("replace") == "true")
	if err != nil {
		skillFailure(w, err)
		return
	}
	created(w, sharedSkill{Skill: *sk, UsedBy: a.usedBy(sk.Name)})
}

func (a *API) getSharedSkill(w http.ResponseWriter, r *http.Request) {
	d, err := a.Skills.Get(r.PathValue("name"))
	if err != nil {
		skillFailure(w, err)
		return
	}
	ok(w, map[string]any{"skill": d, "usedBy": a.usedBy(d.Name)})
}

func (a *API) sharedSkillFile(w http.ResponseWriter, r *http.Request) {
	a.skillFileReply(w, r, a.Skills, r.PathValue("name"))
}

// deleteSharedSkill removes the skill and takes it off every agent that picked it.
func (a *API) deleteSharedSkill(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := a.Skills.Delete(name); err != nil {
		skillFailure(w, err)
		return
	}
	for _, ag := range a.Agents.UsingSkill(name) {
		if _, err := a.Agents.Update(r.Context(), ag.ID, func(c *agents.Config) {
			c.Skills = slices.DeleteFunc(slices.Clone(c.Skills), func(n string) bool { return n == name })
		}); err != nil {
			slog.Warn("taking a deleted skill off an agent", "agent", ag.ID, "skill", name, "err", err)
		}
	}
	ok(w, map[string]bool{"ok": true})
}

// --- an agent's skills ---------------------------------------------------------------------------------------------------

func (a *API) ownSkills(ag *agents.Agent) *skills.Store { return skills.New(ag.SkillsDir()) }

// agentSkills: the agent's own skills, and the shared ones with which it uses.
func (a *API) agentSkills(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	type shared struct {
		skills.Skill
		Enabled bool `json:"enabled"`
	}
	list := []shared{}
	present := map[string]bool{}
	for _, sk := range a.Skills.List() {
		present[sk.Name] = true
		list = append(list, shared{Skill: sk, Enabled: slices.Contains(ag.Config.Skills, sk.Name)})
	}
	missing := []string{}
	for _, n := range ag.Config.Skills {
		if !present[n] {
			missing = append(missing, n)
		}
	}
	ok(w, map[string]any{"own": a.ownSkills(ag).List(), "shared": list, "enabled": nonNil(ag.Config.Skills), "missing": missing, "folder": ag.SkillsDir()})
}

// enableSkills sets which shared skills the agent uses: {enabled: [names]}. Names must be shared skills (or ones it
// already has, so a skill that is gone can be taken off).
func (a *API) enableSkills(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	var in struct {
		Enabled []string `json:"enabled"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	for _, n := range in.Enabled {
		if !a.Skills.Has(n) && !slices.Contains(ag.Config.Skills, n) {
			fail(w, http.StatusBadRequest, "unknown_skill", "There is no shared skill called "+n+".")
			return
		}
	}
	updated, err := a.Agents.Update(r.Context(), ag.ID, func(c *agents.Config) { c.Skills = in.Enabled })
	if err != nil {
		agentFailure(w, err)
		return
	}
	ok(w, a.AgentJSON(updated))
}

func (a *API) changed(ag *agents.Agent) {
	if a.SkillsChanged != nil {
		a.SkillsChanged(ag.ID)
	}
}

func (a *API) addOwnSkill(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	data, good := skillBytes(w, r)
	if !good {
		return
	}
	sk, err := a.ownSkills(ag).AddZip(data, r.URL.Query().Get("replace") == "true")
	if err != nil {
		skillFailure(w, err)
		return
	}
	a.changed(ag)
	created(w, sk)
}

func (a *API) getOwnSkill(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	d, err := a.ownSkills(ag).Get(r.PathValue("name"))
	if err != nil {
		skillFailure(w, err)
		return
	}
	ok(w, map[string]any{"skill": d})
}

func (a *API) ownSkillFile(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	a.skillFileReply(w, r, a.ownSkills(ag), r.PathValue("name"))
}

func (a *API) deleteOwnSkill(w http.ResponseWriter, r *http.Request, ag *agents.Agent) {
	if err := a.ownSkills(ag).Delete(r.PathValue("name")); err != nil {
		skillFailure(w, err)
		return
	}
	a.changed(ag)
	ok(w, map[string]bool{"ok": true})
}
