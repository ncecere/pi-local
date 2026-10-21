package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSkillAndPromptAPIsRefuseUnsafeImportsAndReads(t *testing.T) {
	data := t.TempDir()
	h := start(t, data, Config{})
	defer h.close()
	helper := h.agentOn("Helper", "demo/demo-1", nil)
	for _, route := range []string{"/api/skills", "/api/agents/" + helper + "/skills"} {
		code, _ := h.upload(route, skillZip(t, map[string]string{"SKILL.md": releaseNotes, "../escape.md": "outside"}))
		if code != 400 {
			t.Fatalf("unsafe skill upload: %s %d", route, code)
		}
		code, _ = h.upload(route, skillZip(t, map[string]string{"SKILL.md": releaseNotes}))
		if code != 201 {
			t.Fatalf("safe upload: %s %d", route, code)
		}
		h.mustDo("GET", route+"/release-notes/file?path=%2Fetc%2Fhosts", nil, 400)
		h.mustDo("GET", route+"/release-notes/file?path=..%2Fapp.db", nil, 400)
	}
	outside := filepath.Join(t.TempDir(), "outside.md")
	os.WriteFile(outside, []byte("private outside text"), 0o600)
	skillDir := filepath.Join(data, "skills", "release-notes")
	os.Symlink(outside, filepath.Join(skillDir, "link.md"))
	h.mustDo("GET", "/api/skills/release-notes/file?path=link.md", nil, 400)
	os.Remove(filepath.Join(skillDir, "SKILL.md"))
	os.Symlink(outside, filepath.Join(skillDir, "SKILL.md"))
	h.mustDo("GET", "/api/skills/release-notes/file?path=SKILL.md", nil, 400)
	h.mustDo("PUT", "/api/agents/"+helper+"/skills", map[string]any{"enabled": []string{"release-notes"}}, 400)
	if code, _, _ := h.raw("POST", "/api/prompts/import?name=unsafe.zip", "application/zip", skillZip(t, map[string]string{"../outside.md": "text"})); code != 400 {
		t.Fatalf("unsafe prompt zip: %d", code)
	}
	if _, err := os.Stat(filepath.Join(data, "escape.md")); !os.IsNotExist(err) {
		t.Fatal("zip slipped outside its folder")
	}
}
