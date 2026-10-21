package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func skillZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(content))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

const releaseNotes = "---\nname: release-notes\ndescription: Write release notes from a changelog.\n---\n\n# Release notes\n\nGroup changes by area. Style guide: references/style.md\n"

// upload sends raw bytes and returns the status and the "data" of the answer.
func (h *harness) upload(path string, body []byte) (int, json.RawMessage) {
	h.t.Helper()
	code, _, raw := h.raw("POST", path, "application/zip", body)
	var out struct {
		Data json.RawMessage `json:"data"`
	}
	json.Unmarshal(raw, &out)
	if out.Data == nil {
		return code, raw
	}
	return code, out.Data
}

type skillJSON struct {
	Name        string                      `json:"name"`
	Description string                      `json:"description"`
	Problem     string                      `json:"problem"`
	FileCount   int                         `json:"fileCount"`
	UsedBy      []struct{ ID, Name string } `json:"usedBy"`
	Enabled     bool                        `json:"enabled"`
}

func TestSkillsAreListedInTheSystemPromptAndReadWithTheSkillTool(t *testing.T) {
	data := t.TempDir()
	h := start(t, data, Config{})
	defer h.close()
	fake := newFakeProvider(t, "openai", "ok")
	h.mustDo("POST", "/api/providers", map[string]any{"id": "script", "name": "Script", "kind": "openai-compatible", "baseUrl": fake.URL + "/v1"}, 201)
	h.mustDo("PUT", "/api/providers/script/models/s1", map[string]any{"name": "Scripted"}, 200)

	// A shared skill, added from a zip with its folder around it (as a download from a repository comes).
	code, added := h.upload("/api/skills", skillZip(t, map[string]string{
		"release-notes/SKILL.md":            releaseNotes,
		"release-notes/references/style.md": "Use the past tense.",
	}))
	if code != 201 {
		t.Fatalf("add: %d %s", code, added)
	}
	if sk := decodeInto[skillJSON](t, added); sk.Name != "release-notes" || sk.FileCount != 2 {
		t.Fatalf("added: %+v", sk)
	}
	if _, err := os.Stat(filepath.Join(data, "skills", "release-notes", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	if code, _ := h.upload("/api/skills", skillZip(t, map[string]string{"SKILL.md": releaseNotes})); code != 409 {
		t.Fatalf("a second skill of that name: %d", code)
	}
	if code, _ := h.upload("/api/skills?replace=true", skillZip(t, map[string]string{"SKILL.md": releaseNotes, "references/style.md": "Use the past tense."})); code != 201 {
		t.Fatalf("replace: %d", code)
	}
	if code, _ := h.upload("/api/skills", []byte("not a zip")); code != 400 {
		t.Fatalf("not a zip: %d", code)
	}
	if code, _ := h.upload("/api/skills", nil); code != 400 {
		t.Fatalf("empty: %d", code)
	}
	if code, _ := h.upload("/api/skills", skillZip(t, map[string]string{"SKILL.md": "---\nname: x\n---\nno description"})); code != 400 {
		t.Fatalf("no description: %d", code)
	}

	// Without picking it, an agent has no skills in its prompt.
	helper := h.agentOn("Helper", "script/s1", nil)
	h.sendAndWait(helper, "t1", "hello", "r1")
	if strings.Contains(lastChat(fake), "available_skills") {
		t.Fatal("an agent that picked no skill has them in its prompt")
	}

	// Picking it: the next message lists it (name, description, where SKILL.md is).
	h.mustDo("PUT", "/api/agents/"+helper+"/skills", map[string]any{"enabled": []string{"nope"}}, 400)
	got := h.mustDo("PUT", "/api/agents/"+helper+"/skills", map[string]any{"enabled": []string{"release-notes"}}, 200)
	if !strings.Contains(string(got), `"skills":["release-notes"]`) {
		t.Fatalf("the agent's skills: %s", got)
	}
	h.sendAndWait(helper, "t1", "write the notes", "r2")
	prompt := lastChat(fake)
	for _, want := range []string{"available_skills", "<name>release-notes</name>", "Write release notes from a changelog.", filepath.Join(data, "skills", "release-notes", "SKILL.md")} {
		if !strings.Contains(prompt, want) {
			t.Errorf("the prompt lacks %q", want)
		}
	}

	// The model reads it with the skill tool: the instructions and the folder come back, and another file of it.
	reply := lastReply(h.sendAndWait(helper, "t1", `CALL:skill:{"name":"release-notes"}`, "r3"))
	for _, want := range []string{"Group changes by area", "Folder: " + filepath.Join(data, "skills", "release-notes"), "references/style.md"} {
		if !strings.Contains(reply, want) {
			t.Errorf("the skill tool's answer lacks %q: %q", want, reply)
		}
	}
	if reply := lastReply(h.sendAndWait(helper, "t1", `CALL:skill:{"name":"release-notes","file":"references/style.md"}`, "r4")); !strings.Contains(reply, "Use the past tense.") {
		t.Fatalf("a file of the skill: %q", reply)
	}
	if reply := lastReply(h.sendAndWait(helper, "t1", `CALL:skill:{"name":"release-notes","file":"../../../../etc/hosts"}`, "r5")); !strings.Contains(reply, "outside the skill's folder") && !strings.Contains(reply, "isn't in the skill") {
		t.Fatalf("a file outside the skill: %q", reply)
	}

	// The lists: who uses it; the agent's view of shared and own skills.
	list := decodeInto[struct{ Skills []skillJSON }](t, h.mustDo("GET", "/api/skills", nil, 200))
	if len(list.Skills) != 1 || len(list.Skills[0].UsedBy) != 1 || list.Skills[0].UsedBy[0].ID != helper {
		t.Fatalf("shared: %+v", list)
	}
	detail := decodeInto[struct {
		Skill struct {
			Body   string
			Folder string
			Files  []struct{ Path string }
		}
	}](t, h.mustDo("GET", "/api/skills/release-notes", nil, 200))
	if !strings.Contains(detail.Skill.Body, "Group changes by area") || strings.Contains(detail.Skill.Body, "description:") || len(detail.Skill.Files) != 2 {
		t.Fatalf("detail: %+v", detail)
	}
	file := decodeInto[struct{ Content string }](t, h.mustDo("GET", "/api/skills/release-notes/file?path=references/style.md", nil, 200))
	if file.Content != "Use the past tense." {
		t.Fatalf("file: %+v", file)
	}
	h.mustDo("GET", "/api/skills/release-notes/file?path=../../app.db", nil, 400)
	h.mustDo("GET", "/api/skills/nope", nil, 404)

	// An agent's own skill: in its folder, on for it alone.
	other := h.agentOn("Other", "script/s1", nil)
	if code, body := h.upload("/api/agents/"+helper+"/skills", skillZip(t, map[string]string{"SKILL.md": "---\nname: house-style\ndescription: Our house style for emails.\n---\nShort. Warm.\n"})); code != 201 {
		t.Fatalf("own skill: %d %s", code, body)
	}
	h.sendAndWait(helper, "t1", "again", "r6")
	prompt = lastChat(fake)
	if !strings.Contains(prompt, "<name>house-style</name>") || !strings.Contains(prompt, "<name>release-notes</name>") {
		t.Fatalf("both skills are in the prompt:\n%s", prompt)
	}
	h.sendAndWait(other, "t1", "hello", "r1")
	if strings.Contains(lastChat(fake), "house-style") || strings.Contains(lastChat(fake), "release-notes") {
		t.Fatal("another agent saw the skills")
	}
	mine := decodeInto[struct {
		Own    []skillJSON
		Shared []skillJSON
	}](t, h.mustDo("GET", "/api/agents/"+helper+"/skills", nil, 200))
	if len(mine.Own) != 1 || mine.Own[0].Name != "house-style" || len(mine.Shared) != 1 || !mine.Shared[0].Enabled {
		t.Fatalf("the agent's skills: %+v", mine)
	}
	h.mustDo("GET", "/api/agents/"+helper+"/skills/house-style", nil, 200)
	h.mustDo("GET", "/api/agents/"+other+"/skills/house-style", nil, 404)

	// Deleting a shared skill takes it off the agents that picked it; deleting the own one removes it.
	h.mustDo("DELETE", "/api/skills/release-notes", nil, 200)
	agents := string(h.mustDo("GET", "/api/agents", nil, 200))
	if strings.Contains(agents, `"skills":["release-notes"]`) {
		t.Fatalf("the agent still lists it: %s", agents)
	}
	h.mustDo("DELETE", "/api/agents/"+helper+"/skills/house-style", nil, 200)
	h.mustDo("DELETE", "/api/agents/"+helper+"/skills/house-style", nil, 404)
	h.sendAndWait(helper, "t1", "and now", "r7")
	if strings.Contains(lastChat(fake), "available_skills") {
		t.Fatal("a deleted skill is still in the prompt")
	}
}

func TestPromptLibraryAPI(t *testing.T) {
	data := t.TempDir()
	h := start(t, data, Config{})
	defer h.close()

	created := decodeInto[struct {
		ID           string
		Placeholders []string
	}](t, h.mustDo("POST", "/api/prompts", map[string]any{"title": "Summarize a document", "description": "Short", "body": "Summarize {{document}} for {{audience}}."}, 201))
	if created.ID != "summarize-a-document" || len(created.Placeholders) != 2 {
		t.Fatalf("created: %+v", created)
	}
	if _, err := os.Stat(filepath.Join(data, "prompts", "summarize-a-document.md")); err != nil {
		t.Fatal(err)
	}
	h.mustDo("POST", "/api/prompts", map[string]any{"title": "", "body": "x"}, 400)
	h.mustDo("GET", "/api/prompts/nope", nil, 404)
	h.mustDo("PUT", "/api/prompts/"+created.ID, map[string]any{"title": "Summarize", "body": "Summarize {{document}}."}, 200)
	list := decodeInto[struct{ Prompts []struct{ ID, Title string } }](t, h.mustDo("GET", "/api/prompts", nil, 200))
	if len(list.Prompts) != 1 || list.Prompts[0].Title != "Summarize" || list.Prompts[0].ID != created.ID {
		t.Fatalf("list: %+v", list)
	}

	// Export one (Markdown) and all (zip); import them back.
	code, header, md := h.raw("GET", "/api/prompts/"+created.ID+"/export", "", nil)
	if code != 200 || !strings.Contains(header.Get("Content-Disposition"), created.ID+".md") || !strings.Contains(string(md), "title: \"Summarize\"") {
		t.Fatalf("export one: %d %v %s", code, header, md)
	}
	code, header, archive := h.raw("GET", "/api/prompts/export", "", nil)
	if code != 200 || header.Get("Content-Type") != "application/zip" {
		t.Fatalf("export all: %d %v", code, header)
	}
	code, _, body := h.raw("POST", "/api/prompts/import?name=ideas.md", "text/markdown", []byte("---\ntitle: Brainstorm\n---\nIdeas about {{topic}}"))
	if code != 201 || !strings.Contains(string(body), `"title":"Brainstorm"`) {
		t.Fatalf("import a file: %d %s", code, body)
	}
	code, _, body = h.raw("POST", "/api/prompts/import", "application/zip", archive)
	if code != 201 || !strings.Contains(string(body), `"skipped":0`) {
		t.Fatalf("import the export: %d %s", code, body)
	}
	if code, _, _ := h.raw("POST", "/api/prompts/import", "text/markdown", nil); code != 400 {
		t.Fatalf("import nothing: %d", code)
	}
	if list := decodeInto[struct{ Prompts []struct{ ID string } }](t, h.mustDo("GET", "/api/prompts", nil, 200)); len(list.Prompts) != 3 {
		t.Fatalf("after importing: %+v", list)
	}
	h.mustDo("DELETE", "/api/prompts/"+created.ID, nil, 200)
	h.mustDo("DELETE", "/api/prompts/"+created.ID, nil, 404)
	// The headless server has no save dialog.
	h.mustDo("POST", "/api/prompts/export-save", nil, 501)
}
