package app

import (
	"strings"
	"testing"
)

type templateJSON struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Category    string `json:"category"`
	Builtin     bool   `json:"builtin"`
	Description string `json:"description"`
}

func TestTemplates(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()

	// The gallery: the built-ins in order, all valid; the catalog offers them for New agent.
	list := decodeInto[struct{ Templates []templateJSON }](t, h.mustDo("GET", "/api/templates", nil, 200)).Templates
	var ids []string
	for _, tp := range list {
		ids = append(ids, tp.ID)
		if !tp.Builtin {
			t.Errorf("%s isn't marked built-in", tp.ID)
		}
	}
	if strings.Join(ids, ",") != "assistant,researcher,writer,daily-briefing,translator,planner,coding" {
		t.Fatalf("built-ins: %v", ids)
	}
	cat := decodeInto[struct{ Templates []templateJSON }](t, h.mustDo("GET", "/api/agents/catalog", nil, 200))
	if len(cat.Templates) != 7 || cat.Templates[3].Name != "Daily briefing" {
		t.Fatalf("catalog: %+v", cat.Templates)
	}

	// From a template: its instructions (an empty field in the dialog keeps them), tools and first schedule.
	briefing := decodeInto[struct{ ID string }](t, h.mustDo("POST", "/api/agents", map[string]any{"name": "Morning", "templateId": "daily-briefing", "instructions": ""}, 201)).ID
	ag, _ := h.app.Agents.Get(briefing)
	if ag.Config.Kind != "assistant" || !strings.Contains(ag.Config.Instructions, "daily briefing") || !ag.Config.Web.Search {
		t.Fatalf("briefing agent: %+v", ag.Config)
	}
	scheds, _ := h.app.Schedules.List(t.Context(), briefing)
	if len(scheds) != 1 || scheds[0].Name != "Morning briefing" || scheds[0].Cron == nil || *scheds[0].Cron != "30 7 * * 1-5" || scheds[0].ThreadMode != "this" || scheds[0].ThreadID == nil {
		t.Fatalf("briefing schedule: %+v", scheds)
	}
	// The writer's own web setting (no search) wins over the default for new agents.
	writer := decodeInto[struct{ ID string }](t, h.mustDo("POST", "/api/agents", map[string]any{"name": "Wren", "templateId": "writer"}, 201)).ID
	if w, _ := h.app.Agents.Get(writer); w.Config.Web.Search || !w.Config.Web.Fetch || strings.Join(w.Config.Workspace.Tools, ",") != "read,write,edit" {
		t.Fatalf("writer: %+v", w.Config)
	}
	// A kind ID still works (and the retired triage kind).
	h.mustDo("POST", "/api/agents", map[string]any{"name": "Old", "templateId": "triage"}, 201)

	// Save an agent as a template, export it, import it back (a new ID), delete it; built-ins stay.
	saved := decodeInto[templateJSON](t, h.mustDo("POST", "/api/agents/"+writer+"/save-template", map[string]any{"name": "My writer"}, 201))
	if saved.ID != "my-writer" || saved.Builtin || saved.Category != "yours" || saved.Kind != "assistant" {
		t.Fatalf("saved: %+v", saved)
	}
	code, _, raw := h.raw("GET", "/api/templates/my-writer/export", "", nil)
	if code != 200 || !strings.Contains(string(raw), "id: my-writer") || strings.Contains(string(raw), "model") {
		t.Fatalf("export: %d %s", code, raw)
	}
	code, _, body := h.raw("POST", "/api/templates", "application/yaml", raw)
	if code != 201 || !strings.Contains(string(body), `"id":"my-writer-2"`) {
		t.Fatalf("import: %d %s", code, body)
	}
	from := decodeInto[struct{ ID string }](t, h.mustDo("POST", "/api/agents", map[string]any{"name": "Wren 2", "templateId": "my-writer-2"}, 201)).ID
	if w, _ := h.app.Agents.Get(from); !strings.Contains(w.Config.Instructions, "careful writer") {
		t.Fatalf("from an imported template: %+v", w.Config)
	}
	if code, _, body := h.raw("POST", "/api/templates", "application/yaml", []byte("id: x\nname: X\nkind: nonsense\n")); code != 400 || !strings.Contains(string(body), "invalid_template") {
		t.Fatalf("a bad template: %d %s", code, body)
	}
	h.mustDo("DELETE", "/api/templates/my-writer", nil, 200)
	h.mustDo("DELETE", "/api/templates/assistant", nil, 409)
	if n := len(decodeInto[struct{ Templates []templateJSON }](t, h.mustDo("GET", "/api/templates", nil, 200)).Templates); n != 8 {
		t.Fatalf("after deleting one of two: %d", n)
	}
}
