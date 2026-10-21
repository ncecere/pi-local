package app

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/supervisor"
)

func (h *harness) raw(method, path, contentType string, body []byte) (int, http.Header, []byte) {
	h.t.Helper()
	req, _ := http.NewRequest(method, h.srv.URL+path, bytes.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, data
}

func TestTheAgentManager(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	agent := h.createAgent("Original")

	// The raw agent.yaml, edited and saved; a typo'd field is refused with where it is.
	cfg := decodeInto[struct{ YAML string }](t, h.mustDo("GET", "/api/agents/"+agent+"/config", nil, 200)).YAML
	if !strings.Contains(cfg, "name: Original") {
		t.Fatalf("agent.yaml: %s", cfg)
	}
	edited := strings.Replace(cfg, "name: Original", "name: Edited\ninstructions: Be brief.", 1)
	if got := string(h.mustDo("PUT", "/api/agents/"+agent+"/config", map[string]string{"yaml": edited}, 200)); !strings.Contains(got, `"name":"Edited"`) || !strings.Contains(got, `"instructions":"Be brief."`) {
		t.Fatalf("after saving agent.yaml: %s", got)
	}
	if code, data := h.do("PUT", "/api/agents/"+agent+"/config", map[string]string{"yaml": "name: X\nmodle: {}\n"}); code != 400 || !strings.Contains(string(data), "invalid_yaml") || !strings.Contains(string(data), "modle") {
		t.Fatalf("a typo in agent.yaml: %d %s", code, data)
	}
	// Kind settings.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"templateId": "researcher", "kindSettings": map[string]any{"maxPlanSteps": 4}}, 200)

	// Wake, sleep, logs.
	h.mustDo("POST", "/api/agents/"+agent+"/wake", nil, 200)
	if s := h.status(agent); s != supervisor.Awake {
		t.Fatalf("after wake: %s", s)
	}
	logs := decodeInto[struct {
		Lines []string `json:"lines"`
	}](t, h.mustDo("GET", "/api/agents/"+agent+"/logs?lines=50", nil, 200))
	if len(logs.Lines) == 0 || !strings.Contains(strings.Join(logs.Lines, "\n"), "agent researcher") {
		t.Fatalf("logs: %v", logs.Lines)
	}
	h.mustDo("POST", "/api/agents/"+agent+"/sleep", nil, 200)
	if s := h.status(agent); s != supervisor.Asleep {
		t.Fatalf("after sleep: %s", s)
	}

	// Duplicate: same configuration, no conversations.
	h.sendAndWait(agent, "t1", "remember this", "r1")
	dup := decodeInto[struct {
		ID, Name, AgentKind string
	}](t, h.mustDo("POST", "/api/agents/"+agent+"/duplicate", map[string]string{}, 201))
	if dup.Name != "Edited copy" || dup.AgentKind != "researcher" || len(h.threads(dup.ID)) != 0 {
		t.Fatalf("duplicate: %+v", dup)
	}

	// Export with conversations, import: a new agent with the same conversation.
	code, header, archive := h.raw("GET", "/api/agents/"+agent+"/export?conversations=true", "", nil)
	if code != 200 || header.Get("Content-Type") != "application/zip" || !strings.Contains(header.Get("Content-Disposition"), `filename="Edited-with-conversations.zip"`) {
		t.Fatalf("export: %d %v", code, header)
	}
	zr, _ := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	if strings.Join(names, ",") != "agent.yaml,state.sqlite" {
		t.Fatalf("exported files: %v", names)
	}
	code, _, body := h.raw("POST", "/api/agents/import", "application/zip", archive)
	if code != 201 {
		t.Fatalf("import: %d %s", code, body)
	}
	imported := decodeInto[struct{ Data struct{ ID, Name string } }](t, body).Data
	if imported.ID == agent || imported.Name != "Edited (2)" { // the original is still here: a name of its own
		t.Fatalf("imported: %+v", imported)
	}
	// Its conversation came along: opening it (by its thread ID) wakes the agent with the old messages.
	if v := h.view(imported.ID, "t1"); len(v.Messages) < 2 || v.Messages[0].Text != "remember this" {
		t.Fatalf("the imported agent's conversation: %+v", v.Messages)
	}
	// Junk is refused.
	if code, _, body := h.raw("POST", "/api/agents/import", "application/zip", []byte("not a zip")); code != 400 || !strings.Contains(string(body), "invalid_archive") {
		t.Fatalf("a bad archive: %d %s", code, body)
	}
	if code, _, body := h.raw("POST", "/api/agents/import", "application/zip", nil); code != 400 || !strings.Contains(string(body), "Blob") {
		t.Fatalf("an empty archive: %d %s", code, body)
	}

	// About.
	if got := string(h.mustDo("GET", "/api/about", nil, 200)); !strings.Contains(got, `"piDurableVersion":"1.3.0"`) || !strings.Contains(got, `"agents":3`) {
		t.Fatalf("about: %s", got)
	}
}

func TestTeams(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	lead, m1, m2 := h.createAgent("Lead"), h.createAgent("One"), h.createAgent("Two")
	if code, data := h.do("POST", "/api/teams", map[string]any{"name": "Empty", "leadId": lead, "memberIds": []string{lead}}); code != 400 || !strings.Contains(string(data), "invalid_members") {
		t.Fatalf("a team of only its lead: %d %s", code, data)
	}
	team := decodeInto[struct{ ID string }](t, h.mustDo("POST", "/api/teams", map[string]any{"name": "Crew", "leadId": lead, "memberIds": []string{m1, m2}}, 201)).ID
	// Members don't ask each other until membersTalk.
	agentsJSON := string(h.mustDo("GET", "/api/agents", nil, 200))
	if !strings.Contains(agentsJSON, `"callable":[]`) {
		t.Fatalf("members shouldn't be able to ask yet: %s", agentsJSON)
	}
	h.mustDo("PATCH", "/api/teams/"+team, map[string]any{"membersTalk": true}, 200)
	time.Sleep(50 * time.Millisecond)
	if got := string(h.mustDo("GET", "/api/agents", nil, 200)); strings.Contains(got, `"callable":[]`) {
		t.Fatalf("with membersTalk everyone may ask someone: %s", got)
	}
	// A deleted member leaves the team; a deleted lead takes the team with it.
	h.mustDo("DELETE", "/api/agents/"+m2, nil, 200)
	if got := string(h.mustDo("GET", "/api/teams", nil, 200)); strings.Contains(got, m2) {
		t.Fatalf("a deleted member is still in the team: %s", got)
	}
	h.mustDo("DELETE", "/api/agents/"+lead, nil, 200)
	if got := string(h.mustDo("GET", "/api/teams", nil, 200)); got != "[]" {
		t.Fatalf("the lead's team should be gone: %s", got)
	}
}
