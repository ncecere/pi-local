package app

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestTheNewAgentChoicesAreTheTemplates(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	cat := decodeInto[struct {
		Templates []struct{ ID string } `json:"templates"`
	}](t, h.mustDo("GET", "/api/agents/catalog", nil, 200))
	var ids []string
	for _, k := range cat.Templates {
		ids = append(ids, k.ID)
	}
	if strings.Join(ids, ",") != "assistant,researcher,writer,daily-briefing,translator,planner,coding,agent-builder,concierge" {
		t.Fatalf("choices: %v", ids)
	}
	// Triage is retired, not removed: an agent made with it still saves and runs.
	h.mustDo("POST", "/api/agents", map[string]any{"name": "Old triage", "templateId": "triage"}, 201)
	h.mustDo("POST", "/api/agents", map[string]any{"name": "Nope", "templateId": "nonsense"}, 400)
}

func TestACodingAgentWorksInItsProjectFolderWithItsInstructions(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	fake := newFakeProvider(t, "openai", "plain reply")
	h.mustDo("POST", "/api/providers", map[string]any{"id": "script", "name": "Script", "kind": "openai-compatible", "baseUrl": fake.URL + "/v1"}, 201)
	h.mustDo("PUT", "/api/providers/script/models/s1", map[string]any{"name": "Scripted"}, 200)

	// A project: a repository with an AGENTS.md at its root, worked on from a folder inside it.
	home, _ := os.UserHomeDir()
	repo, err := os.MkdirTemp(home, ".pi-local-test-repo-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(repo) })
	os.Mkdir(filepath.Join(repo, ".git"), 0o755)
	os.WriteFile(filepath.Join(repo, "AGENTS.md"), []byte("Always run the tests with make check."), 0o644)
	project := filepath.Join(repo, "app")
	os.Mkdir(project, 0o755)
	os.WriteFile(filepath.Join(project, "CLAUDE.md"), []byte("This folder is the app."), 0o644)
	os.WriteFile(filepath.Join(project, "hello.txt"), []byte("hi from the project"), 0o644)

	// Refused: not a folder, a relative path, the home folder itself.
	for _, bad := range []string{filepath.Join(project, "hello.txt"), "relative/path", home} {
		h.mustDo("POST", "/api/agents", map[string]any{"name": "Bad", "templateId": "coding", "modelId": "script/s1", "workspace": map[string]any{"folder": bad}}, 400)
	}

	created := decodeInto[struct {
		ID        string
		Workspace struct {
			Tools  []string `json:"tools"`
			Folder string   `json:"folder"`
		} `json:"workspace"`
	}](t, h.mustDo("POST", "/api/agents", map[string]any{
		"name": "Coder", "templateId": "coding", "modelId": "script/s1", "instructions": "Prefer small diffs.",
		"workspace": map[string]any{"folder": project},
	}, 201))
	if !slices.Equal(created.Workspace.Tools, []string{"read", "write", "edit", "bash"}) || created.Workspace.Folder != project {
		t.Fatalf("a coding agent's defaults: %+v", created.Workspace)
	}
	if ag, _ := h.app.Agents.Get(created.ID); ag.Config.Approvals.Profile != "balanced" {
		t.Fatalf("a coding agent should ask before commands (the balanced profile): %+v", ag.Config.Approvals)
	}
	// As the New agent dialog makes one: its tools and project folder given, nothing said about approvals.
	viaDialog := decodeInto[struct{ ID string }](t, h.mustDo("POST", "/api/agents", map[string]any{
		"name": "Coder 2", "templateId": "coding", "modelId": "script/s1",
		"workspace": map[string]any{"tools": []string{"read", "write", "edit", "bash"}, "folder": project},
	}, 201))
	if ag, _ := h.app.Agents.Get(viaDialog.ID); ag.Config.Approvals.Profile != "balanced" {
		t.Fatalf("a coding agent made with its tools should still ask before commands: %+v", ag.Config.Approvals)
	}

	v := h.sendAndWait(created.ID, "t1", "READ:hello.txt", "r1")
	if last := v.Messages[len(v.Messages)-1]; !strings.Contains(last.Text, "hi from the project") {
		t.Fatalf("reading in the project: %q", last.Text)
	}
	h.sendAndWait(created.ID, "t1", "WRITE:notes/out.md:written by the agent", "r2")
	if got, _ := os.ReadFile(filepath.Join(project, "notes", "out.md")); string(got) != "written by the agent" {
		t.Fatalf("writing in the project: %q", got)
	}
	// Its prompt: pi's coding prompt, the person's instructions added, both context files (root first), the folder.
	var prompt string
	for _, r := range fake.chats() {
		prompt = string(r.Body)
	}
	for _, want := range []string{"expert coding assistant", "Prefer small diffs.", "Always run the tests with make check.", "This folder is the app.", "<cwd>"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("the prompt lacks %q", want)
		}
	}
	if strings.Index(prompt, "make check") > strings.Index(prompt, "This folder is the app") {
		t.Error("the repository's AGENTS.md should come before the folder's CLAUDE.md")
	}
	// Attachments don't land in the project.
	code, _, body := h.raw("POST", "/api/agents/"+created.ID+"/attachments?name=pic.png", "image/png", []byte("png bytes"))
	if code != 201 || strings.Contains(string(body), project) {
		t.Fatalf("attachment: %d %s", code, body)
	}
	if _, err := os.Stat(filepath.Join(project, "attachments")); err == nil {
		t.Fatal("an attachment was saved in the project folder")
	}
}
