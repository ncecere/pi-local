package skills

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeZip builds a zip from name → content ("name/" is a folder; a content starting with "link:" is a symlink).
func makeZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		hdr := &zip.FileHeader{Name: name, Method: zip.Deflate}
		switch {
		case strings.HasSuffix(name, "/"):
			hdr.SetMode(os.ModeDir | 0o755)
		case strings.HasPrefix(content, "link:"):
			hdr.SetMode(os.ModeSymlink | 0o777)
			content = strings.TrimPrefix(content, "link:")
		case strings.HasSuffix(name, ".sh"):
			hdr.SetMode(0o755)
		}
		w, err := zw.CreateHeader(hdr)
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

const skillMD = "---\nname: release-notes\ndescription: Write release notes from a changelog.\n---\n\n# Release notes\n\nRead references/style.md first.\n"

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var se *Error
	if !errors.As(err, &se) || se.Code != code {
		t.Fatalf("error = %v, want code %q", err, code)
	}
}

func TestAddAZipWithSkillMDAtTheTop(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "skills"))
	sk, err := s.AddZip(makeZip(t, map[string]string{
		"SKILL.md":            skillMD,
		"references/style.md": "Be brief.",
		"scripts/run.sh":      "echo hi",
		".DS_Store":           "junk",
		"__MACOSX/._SKILL.md": "junk",
		".git/config":         "junk",
		"references/.hidden":  "junk",
		"references/":         "",
	}), false)
	if err != nil {
		t.Fatal(err)
	}
	if sk.Name != "release-notes" || sk.Description != "Write release notes from a changelog." || sk.Files != 3 {
		t.Fatalf("skill: %+v", sk)
	}
	for _, gone := range []string{".DS_Store", "__MACOSX", ".git", "references/.hidden"} {
		if _, err := os.Stat(filepath.Join(s.Root, "release-notes", gone)); err == nil {
			t.Errorf("%s was kept", gone)
		}
	}
	info, err := os.Stat(filepath.Join(s.Root, "release-notes", "scripts", "run.sh"))
	if err != nil || info.Mode()&0o100 == 0 {
		t.Fatalf("a script keeps its executable bit: %v %v", info, err)
	}
	if entries, _ := os.ReadDir(s.Root); len(entries) != 1 {
		t.Fatalf("nothing but the skill is left in the folder: %v", entries)
	}
}

func TestAddAZipWithOneFolder(t *testing.T) {
	s := New(t.TempDir())
	// A folder named differently from the skill: the skill's own name wins.
	sk, err := s.AddZip(makeZip(t, map[string]string{"my-download/": "", "my-download/SKILL.md": skillMD, "my-download/notes.txt": "x", "__MACOSX/my-download/._SKILL.md": "junk"}), false)
	if err != nil || sk.Name != "release-notes" || sk.Files != 2 {
		t.Fatalf("%+v %v", sk, err)
	}
	if _, err := os.Stat(filepath.Join(s.Root, "release-notes", "notes.txt")); err != nil {
		t.Fatal(err)
	}
}

func TestAZipThatIsNotASkillIsRefused(t *testing.T) {
	s := New(t.TempDir())
	_, err := s.AddZip([]byte("not a zip"), false)
	wantCode(t, err, "invalid_archive")
	_, err = s.AddZip(makeZip(t, map[string]string{"README.md": "hi"}), false)
	wantCode(t, err, "invalid_archive")
	_, err = s.AddZip(makeZip(t, map[string]string{"a/SKILL.md": skillMD, "b/SKILL.md": skillMD}), false)
	wantCode(t, err, "invalid_archive")
	if err == nil || !strings.Contains(err.Error(), "one at a time") {
		t.Fatalf("a collection says so: %v", err)
	}
	_, err = s.AddZip(makeZip(t, map[string]string{"a/SKILL.md": skillMD, "README.md": "beside it"}), false)
	wantCode(t, err, "invalid_archive")

	for name, md := range map[string]string{
		"no front matter": "# Just text",
		"no name":         "---\ndescription: d\n---\nbody",
		"bad name":        "---\nname: Release Notes\ndescription: d\n---\nbody",
		"no description":  "---\nname: ok\n---\nbody",
		"long":            "---\nname: ok\ndescription: " + strings.Repeat("x", MaxDescriptionChars+1) + "\n---\nbody",
	} {
		_, err := s.AddZip(makeZip(t, map[string]string{"SKILL.md": md}), false)
		wantCode(t, err, "invalid_skill")
		if err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if entries, _ := os.ReadDir(s.Root); len(entries) != 0 {
		t.Fatalf("a refused zip leaves nothing behind: %v", entries)
	}
}

func TestAZipCannotWriteOutsideOrLink(t *testing.T) {
	root := t.TempDir()
	s := New(filepath.Join(root, "skills"))
	for name, files := range map[string]map[string]string{
		"parent":    {"SKILL.md": skillMD, "../evil.txt": "x"},
		"deep":      {"SKILL.md": skillMD, "a/../../evil.txt": "x"},
		"absolute":  {"SKILL.md": skillMD, "/etc/evil": "x"},
		"backslash": {"SKILL.md": skillMD, `..\evil.txt`: "x"},
		"symlink":   {"SKILL.md": skillMD, "link": "link:/etc/passwd"},
	} {
		_, err := s.AddZip(makeZip(t, files), false)
		wantCode(t, err, "invalid_archive")
		if err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "evil.txt")); err == nil {
		t.Fatal("a file escaped")
	}
}

func TestAZipTooBig(t *testing.T) {
	s := New(t.TempDir())
	_, err := s.AddZip(makeZip(t, map[string]string{"SKILL.md": skillMD, "big.bin": strings.Repeat("a", MaxFileBytes+1)}), false)
	wantCode(t, err, "too_large")
	files := map[string]string{"SKILL.md": skillMD}
	for i := 0; i < MaxFiles; i++ {
		files["f/"+strings.Repeat("a", 3)+string(rune('a'+i%26))+string(rune('a'+i/26%26))+string(rune('a'+i/676))+".txt"] = "x"
	}
	_, err = s.AddZip(makeZip(t, files), false)
	wantCode(t, err, "too_large")
}

func TestReplacingAndDeleting(t *testing.T) {
	s := New(t.TempDir())
	if _, err := s.AddZip(makeZip(t, map[string]string{"SKILL.md": skillMD, "old.txt": "old"}), false); err != nil {
		t.Fatal(err)
	}
	_, err := s.AddZip(makeZip(t, map[string]string{"SKILL.md": skillMD}), false)
	wantCode(t, err, "exists")
	sk, err := s.AddZip(makeZip(t, map[string]string{"SKILL.md": skillMD, "new.txt": "new"}), true)
	if err != nil || sk.Files != 2 {
		t.Fatalf("%+v %v", sk, err)
	}
	if _, err := os.Stat(filepath.Join(s.Root, "release-notes", "old.txt")); err == nil {
		t.Fatal("replacing keeps the old files")
	}
	if entries, _ := os.ReadDir(s.Root); len(entries) != 1 {
		t.Fatalf("leftovers: %v", entries)
	}
	if err := s.Delete("release-notes"); err != nil {
		t.Fatal(err)
	}
	wantCode(t, s.Delete("release-notes"), "not_found")
	wantCode(t, s.Delete("../x"), "not_found")
}

func TestListGetAndReadFile(t *testing.T) {
	root := t.TempDir()
	s := New(filepath.Join(root, "skills"))
	if got := s.List(); got == nil || len(got) != 0 {
		t.Fatalf("an empty folder lists as an empty list: %#v", got)
	}
	if _, err := s.AddZip(makeZip(t, map[string]string{"SKILL.md": skillMD, "references/style.md": "Be brief.", "blob.bin": "a\x00b"}), false); err != nil {
		t.Fatal(err)
	}
	// A folder made by hand: without a description it is listed with its problem, and is not usable.
	os.MkdirAll(filepath.Join(s.Root, "handmade"), 0o700)
	os.WriteFile(filepath.Join(s.Root, "handmade", "SKILL.md"), []byte("---\nname: handmade\n---\nbody"), 0o600)
	os.MkdirAll(filepath.Join(s.Root, "empty"), 0o700)
	os.MkdirAll(filepath.Join(s.Root, ".incoming-x"), 0o700)
	os.MkdirAll(filepath.Join(s.Root, "Not_A_Name"), 0o700)

	list := s.List()
	if len(list) != 3 || list[0].Name != "empty" || list[1].Name != "handmade" || list[2].Name != "release-notes" {
		t.Fatalf("list: %+v", list)
	}
	if list[0].Problem == "" || list[1].Problem == "" || list[2].Problem != "" {
		t.Fatalf("problems: %+v", list)
	}
	if got := s.Names(); len(got) != 1 || got[0] != "release-notes" {
		t.Fatalf("names: %v", got)
	}
	if !s.Has("release-notes") || s.Has("handmade") || s.Has("nope") || s.Has("../skills") {
		t.Fatal("Has")
	}

	d, err := s.Get("release-notes")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(d.Body, "description:") || !strings.Contains(d.Body, "Read references/style.md first.") {
		t.Fatalf("body: %q", d.Body)
	}
	if len(d.Items) != 3 || d.Items[0].Path != "SKILL.md" || d.Folder != filepath.Join(s.Root, "release-notes") {
		t.Fatalf("detail: %+v", d)
	}
	wantCode(t, func() error { _, err := s.Get("nope"); return err }(), "not_found")

	content, truncated, err := s.ReadFile("release-notes", "references/style.md")
	if err != nil || content != "Be brief." || truncated {
		t.Fatalf("%q %v %v", content, truncated, err)
	}
	_, _, err = s.ReadFile("release-notes", "blob.bin")
	wantCode(t, err, "binary_file")
	_, _, err = s.ReadFile("release-notes", "missing.md")
	wantCode(t, err, "not_found")
	_, _, err = s.ReadFile("release-notes", "../handmade/SKILL.md")
	wantCode(t, err, "invalid_path")
	_, _, err = s.ReadFile("release-notes", "/etc/hosts")
	wantCode(t, err, "invalid_path")
	// A link inside the folder to a file outside it is not followed.
	secret := filepath.Join(root, "secret.txt")
	os.WriteFile(secret, []byte("TOP SECRET"), 0o600)
	os.Symlink(secret, filepath.Join(s.Root, "release-notes", "link.txt"))
	_, _, err = s.ReadFile("release-notes", "link.txt")
	wantCode(t, err, "invalid_path")
	// A long file is cut.
	os.WriteFile(filepath.Join(s.Root, "release-notes", "long.txt"), []byte(strings.Repeat("a", MaxViewBytes+10)), 0o600)
	content, truncated, err = s.ReadFile("release-notes", "long.txt")
	if err != nil || !truncated || len(content) != MaxViewBytes {
		t.Fatalf("long: %d %v %v", len(content), truncated, err)
	}
}

func TestValidName(t *testing.T) {
	for _, ok := range []string{"a", "release-notes", "pdf2", "a-b-c"} {
		if !ValidName(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, no := range []string{"", "A", "a_b", "-a", "a-", "a--b", "a b", "../a", strings.Repeat("a", 65)} {
		if ValidName(no) {
			t.Errorf("%q should be invalid", no)
		}
	}
}
