package prompts

import (
	"archive/zip"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImportZipSafety(t *testing.T) {
	for _, name := range []string{"../escape.md", "/escape.md", "folder/../../escape.md", `C:\escape.md`} {
		s := newStore(t)
		_, _, err := s.Import(zipOf(t, map[string]string{name: "Prompt text"}), "x.zip")
		wantCode(t, err, "invalid_archive")
		if len(s.List()) != 0 {
			t.Fatal("unsafe import wrote a prompt")
		}
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	h := &zip.FileHeader{Name: "link.md"}
	h.SetMode(os.ModeSymlink | 0o777)
	w, _ := zw.CreateHeader(h)
	w.Write([]byte("/etc/passwd"))
	zw.Close()
	_, _, err := newStore(t).Import(buf.Bytes(), "x.zip")
	wantCode(t, err, "invalid_archive")
	files := map[string]string{}
	for i := 0; i < 1001; i++ {
		files[fmt.Sprintf("%d.txt", i)] = "x"
	}
	_, _, err = newStore(t).Import(zipOf(t, files), "x.zip")
	wantCode(t, err, "too_large")
	files = map[string]string{}
	for i := 0; i < 430; i++ {
		files[fmt.Sprintf("%d.md", i)] = strings.Repeat("x", MaxBodyChars)
	}
	s := newStore(t)
	_, _, err = s.Import(zipOf(t, files), "x.zip")
	wantCode(t, err, "too_large")
	if len(s.List()) != 0 {
		t.Fatal("overlarge import partially saved")
	}
	_, _, err = s.Import(make([]byte, MaxImportBytes+1), "x.md")
	wantCode(t, err, "too_large")
}

func TestPromptSymlinksAreNotReadOrWrittenThrough(t *testing.T) {
	s := newStore(t)
	target := filepath.Join(t.TempDir(), "outside.md")
	os.WriteFile(target, []byte("Secret text"), 0o600)
	os.Symlink(target, filepath.Join(s.Dir(), "linked.md"))
	os.Symlink(target, filepath.Join(s.Dir(), "new.md.tmp"))
	if len(s.List()) != 0 {
		t.Fatal("symlink listed")
	}
	_, err := s.Get("linked")
	wantCode(t, err, "not_found")
	_, err = s.Create(Input{Title: "New", Body: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(target)
	if string(raw) != "Secret text" {
		t.Fatal("writing followed a symlink")
	}
}
