package skills

import (
	"archive/zip"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSkillSymlinksCannotExposeOtherFolders(t *testing.T) {
	root := t.TempDir()
	s := New(filepath.Join(root, "skills"))
	outside := filepath.Join(root, "outside")
	os.MkdirAll(outside, 0o700)
	os.WriteFile(filepath.Join(outside, File), []byte(skillMD), 0o600)
	os.MkdirAll(s.Root, 0o700)
	os.Symlink(outside, filepath.Join(s.Root, "release-notes"))
	if s.Has("release-notes") || len(s.Names()) != 0 {
		t.Fatal("linked skill enabled")
	}
	if _, err := s.Get("release-notes"); err == nil {
		t.Fatal("linked folder viewed")
	}
	if _, _, err := s.ReadFile("release-notes", File); err == nil {
		t.Fatal("linked folder read")
	}
	os.Remove(filepath.Join(s.Root, "release-notes"))
	os.Mkdir(filepath.Join(s.Root, "release-notes"), 0o700)
	os.Symlink(filepath.Join(outside, File), filepath.Join(s.Root, "release-notes", File))
	if s.Has("release-notes") {
		t.Fatal("external SKILL.md enabled")
	}
	d, err := s.Get("release-notes")
	if err != nil || d.Body != "" || d.Problem == "" {
		t.Fatalf("external instructions exposed: %+v %v", d, err)
	}
	if _, _, err := s.ReadFile("release-notes", File); err == nil {
		t.Fatal("external SKILL.md read")
	}
}

func TestSkillNameMustMatchFolder(t *testing.T) {
	s := New(t.TempDir())
	os.Mkdir(filepath.Join(s.Root, "wrong-name"), 0o700)
	os.WriteFile(filepath.Join(s.Root, "wrong-name", File), []byte(skillMD), 0o600)
	if s.Has("wrong-name") {
		t.Fatal("mismatched name enabled")
	}
}

func TestSkillArchiveBoundsAndAliases(t *testing.T) {
	s := New(t.TempDir())
	for _, name := range []string{"C:/evil", "folder/../evil", "a\\evil"} {
		_, err := s.AddZip(makeZip(t, map[string]string{File: skillMD, name: "x"}), false)
		wantCode(t, err, "invalid_archive")
	}
	for _, alias := range []string{"SKILL.md", "./SKILL.md", "skill.md"} {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		for _, name := range []string{File, alias} {
			w, _ := zw.Create(name)
			w.Write([]byte(skillMD))
		}
		zw.Close()
		_, err := s.AddZip(buf.Bytes(), false)
		wantCode(t, err, "invalid_archive")
	}
	_, err := s.AddZip(makeZip(t, map[string]string{File: skillMD + strings.Repeat("x", MaxViewBytes)}), false)
	wantCode(t, err, "too_large")
	_, err = s.AddZip(make([]byte, MaxZipBytes+1), false)
	wantCode(t, err, "too_large")
	files := map[string]string{File: skillMD}
	for i := 0; i < 1001; i++ {
		files[fmt.Sprintf("empty-%d/", i)] = ""
	}
	_, err = s.AddZip(makeZip(t, files), false)
	wantCode(t, err, "too_large")
	files = map[string]string{File: skillMD}
	for i := 0; i < 5; i++ {
		files[fmt.Sprintf("file-%d", i)] = strings.Repeat("x", MaxFileBytes)
	}
	_, err = s.AddZip(makeZip(t, files), false)
	wantCode(t, err, "too_large")
	if len(s.List()) != 0 {
		t.Fatal("refused archive left a skill")
	}
}
