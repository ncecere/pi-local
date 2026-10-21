package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArtifactsToolManualEditsScopingAndDownloads(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	scripted(t, h)
	agent := h.agentOn("Writer", "script/s1", nil)
	h.sendAndWait(agent, "t", `CALL:artifact:{"title":"Report","type":"markdown","content":"# First"}`, "r1")
	base := "/api/agents/" + agent + "/threads/t"
	doc := decodeInto[struct {
		Value struct {
			Artifacts []struct {
				ID       string
				Revision int
				Content  string
			}
		}
	}](t, h.mustDo("GET", base+"/documents/artifacts", nil, 200))
	if len(doc.Value.Artifacts) != 1 {
		t.Fatalf("document: %+v", doc)
	}
	id := doc.Value.Artifacts[0].ID
	path := base + "/artifacts/" + id
	toolView := decodeInto[struct {
		Messages []struct {
			Role, Name string
			Details    map[string]any
		}
	}](t, h.mustDo("GET", base, nil, 200))
	for _, message := range toolView.Messages {
		if message.Role == "tool" && message.Name == "artifact" {
			if message.Details["id"] != id || message.Details["reference"] != "artifacts/"+id || message.Details["content"] != nil {
				t.Fatalf("artifact details: %+v", message.Details)
			}
		}
	}
	edit := map[string]any{"title": "Report", "type": "markdown", "content": "Manual draft", "expectedRevision": 1}
	h.mustDo("PUT", path, edit, 200)
	h.mustDo("PUT", path, edit, 409)
	h.mustDo("PUT", path, map[string]any{"title": "Report", "type": "markdown", "content": "lost"}, 400)
	history := string(h.mustDo("GET", path+"/history", nil, 200))
	if !strings.Contains(history, "# First") {
		t.Fatalf("history: %s", history)
	}
	if got := string(h.mustDo("GET", path+"/download", nil, 200)); got != "Manual draft" {
		t.Fatalf("download: %s", got)
	}
	h.mustDo("POST", path+"/download", nil, 501)
	target := filepath.Join(t.TempDir(), "report.md")
	h.app.API.SaveDialog = func(name string) (string, error) {
		if name != id+".md" {
			t.Errorf("filename: %s", name)
		}
		return target, nil
	}
	h.mustDo("POST", path+"/download", nil, 200)
	if data, err := os.ReadFile(target); err != nil || string(data) != "Manual draft" {
		t.Fatalf("saved: %s %v", data, err)
	}
	h.app.API.SaveDialog = func(string) (string, error) { return "", nil }
	if body := string(h.mustDo("POST", path+"/download", nil, 200)); !strings.Contains(body, "cancelled") {
		t.Fatal(body)
	}
	h.mustDo("POST", path+"/workspace", map[string]any{"path": "report.md", "expectedRevision": 2}, 403)
	// Existence and authorization are resolved through the scoped agent/thread, not a global artifact lookup.
	other := h.agentOn("Other", "script/s1", nil)
	h.sendAndWait(agent, "empty", "hello", "r1")
	h.sendAndWait(other, "t", "hello", "r1")
	h.mustDo("GET", "/api/agents/"+agent+"/threads/empty/artifacts/"+id, nil, 404)
	h.mustDo("PUT", "/api/agents/"+other+"/threads/t/artifacts/"+id, edit, 404)
	h.mustDo("GET", base+"/artifacts/bad.id", nil, 400)
	h.mustDo("GET", "/api/agents/not-an-agent/threads/t/artifacts/"+id, nil, 404)
	h.mustDo("PUT", path, map[string]any{"title": "Report", "type": "code", "content": strings.Repeat("x", 65537), "expectedRevision": 2}, 422)
	h.mustDo("PUT", path, map[string]any{"content": strings.Repeat("x", 300000)}, 413)
	// A real SQLite runtime sleeps and reopens with the content and history intact.
	h.mustDo("POST", "/api/agents/"+agent+"/sleep", nil, 200)
	if got := string(h.mustDo("GET", path, nil, 200)); !strings.Contains(got, "Manual draft") || !strings.Contains(got, "# First") {
		t.Fatal(got)
	}
	reply := lastReply(h.sendAndWait(agent, "t", `CALL:artifact:{"action":"read","id":"`+id+`"}`, "r2"))
	if !strings.Contains(reply, "Manual draft") {
		t.Fatalf("model didn't read manual edit: %q", reply)
	}
	h.sendAndWait(agent, "t", `CALL:artifact:{"id":"`+id+`","title":"Report","type":"markdown","content":"Manual draft, revised by agent","expectedRevision":2}`, "r3")
	updated := decodeInto[struct {
		ID, Content string
		Revision    int
	}](t, h.mustDo("GET", path, nil, 200))
	if updated.ID != id || updated.Revision != 3 || updated.Content != "Manual draft, revised by agent" {
		t.Fatalf("tool update: %+v", updated)
	}
	// Export/import carries the conversation document, stable IDs and history in SQLite.
	code, _, archive := h.raw("GET", "/api/agents/"+agent+"/export?conversations=true", "", nil)
	if code != 200 {
		t.Fatalf("export: %d", code)
	}
	code, _, body := h.raw("POST", "/api/agents/import", "application/zip", archive)
	if code != 201 {
		t.Fatalf("import: %d %s", code, body)
	}
	imported := decodeInto[struct{ Data struct{ ID string } }](t, body).Data.ID
	if got := string(h.mustDo("GET", "/api/agents/"+imported+"/threads/t/artifacts/"+id, nil, 200)); !strings.Contains(got, "Manual draft") || !strings.Contains(got, "# First") {
		t.Fatal(got)
	}
}

func TestArtifactWorkspaceSaveUsesTheExecutionEnvironment(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	scripted(t, h)
	root := t.TempDir()
	outside := t.TempDir()
	for name, target := range map[string]string{
		"escape":          outside,
		"dangling-final":  filepath.Join(outside, "new.md"),
		"dangling-parent": filepath.Join(outside, "missing-directory"),
	} {
		if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
			t.Fatal(err)
		}
	}
	agent := h.agentOn("Writer", "script/s1", map[string]any{"workspace": map[string]any{"folder": root, "tools": []string{"write"}}})
	h.sendAndWait(agent, "t", `CALL:artifact:{"title":"Code","type":"code","language":"js","content":"throw new Error('never run')"}`, "r1")
	doc := decodeInto[struct {
		Value struct{ Artifacts []struct{ ID string } }
	}](t, h.mustDo("GET", "/api/agents/"+agent+"/threads/t/documents/artifacts", nil, 200))
	path := "/api/agents/" + agent + "/threads/t/artifacts/" + doc.Value.Artifacts[0].ID + "/workspace"
	for _, p := range []string{"../escape.txt", filepath.Join(outside, "absolute.txt"), "escape/symlink.txt", "dangling-final", "dangling-parent/file.md"} {
		h.mustDo("POST", path, map[string]any{"path": p, "expectedRevision": 1}, 400)
	}
	h.mustDo("POST", path, map[string]any{"path": "code.js", "expectedRevision": 9}, 409)
	h.mustDo("POST", path, map[string]any{"path": "code.js", "expectedRevision": 1}, 200)
	data, err := os.ReadFile(filepath.Join(root, "code.js"))
	if err != nil || string(data) != "throw new Error('never run')" {
		t.Fatalf("saved: %s %v", data, err)
	}
	// No bytes were written through the symlink.
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("escape: %v %v", entries, err)
	}
}
