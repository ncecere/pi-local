package prompts

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(filepath.Join(t.TempDir(), "prompts"))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var pe *Error
	if !errors.As(err, &pe) || pe.Code != code {
		t.Fatalf("error = %v, want code %q", err, code)
	}
}

func TestPlaceholders(t *testing.T) {
	got := PlaceholdersIn("Summarize {{document}} for {{ audience }}. Again {{document}}, and {{recipient name}} {{}} {{bad!}} { {x} }")
	if want := []string{"document", "audience", "recipient name"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("placeholders = %v, want %v", got, want)
	}
	if got := PlaceholdersIn("none"); got == nil || len(got) != 0 {
		t.Fatalf("no placeholders is an empty list: %#v", got)
	}
	filled := Fill("Hi {{name}}, {{ name }}! {{other}}", map[string]string{"name": "Ann"})
	if filled != "Hi Ann, Ann! {{other}}" {
		t.Fatalf("filled = %q", filled)
	}
}

func TestCreateReadUpdateDelete(t *testing.T) {
	s := newStore(t)
	p, err := s.Create(Input{Title: "  Summarize a document ", Description: "Short\nsummary", Body: "Summarize {{document}} for {{audience}}.\r\n\r\nDecisions last."})
	if err != nil {
		t.Fatal(err)
	}
	if p.ID != "summarize-a-document" || p.Title != "Summarize a document" || p.Description != "Short summary" || !reflect.DeepEqual(p.Placeholders, []string{"document", "audience"}) {
		t.Fatalf("prompt: %+v", p)
	}
	raw, err := os.ReadFile(filepath.Join(s.Dir(), p.ID+".md"))
	if err != nil || !strings.HasPrefix(string(raw), "---\ntitle: \"Summarize a document\"\ndescription: \"Short summary\"\n---\n\nSummarize {{document}}") {
		t.Fatalf("the file: %q %v", raw, err)
	}
	// The same title again is a new prompt.
	again, err := s.Create(Input{Title: "Summarize a document", Body: "Other"})
	if err != nil || again.ID != "summarize-a-document-2" {
		t.Fatalf("%+v %v", again, err)
	}
	// A title that makes the reserved ID never gets it.
	exp, err := s.Create(Input{Title: "Export", Body: "x"})
	if err != nil || exp.ID == "export" {
		t.Fatalf("export: %+v %v", exp, err)
	}

	updated, err := s.Update(p.ID, Input{Title: `He said "hi" \o/`, Body: "New {{thing}}"})
	if err != nil || updated.ID != p.ID || updated.Title != `He said "hi" \o/` || updated.Description != "" || !reflect.DeepEqual(updated.Placeholders, []string{"thing"}) {
		t.Fatalf("%+v %v", updated, err)
	}
	if got, _ := s.Get(p.ID); got.Title != `He said "hi" \o/` {
		t.Fatalf("a title with quotes and backslashes survives the file: %q", got.Title)
	}
	list := s.List()
	if len(list) != 3 || list[0].Title != "Export" {
		t.Fatalf("list sorted by title: %+v", list)
	}
	if err := s.Delete(p.ID); err != nil {
		t.Fatal(err)
	}
	wantCode(t, s.Delete(p.ID), "not_found")
	_, err = s.Get(p.ID)
	wantCode(t, err, "not_found")
	_, err = s.Update("nope", Input{Title: "a", Body: "b"})
	wantCode(t, err, "not_found")
	_, err = s.Get("../etc/passwd")
	wantCode(t, err, "not_found")
}

func TestChecks(t *testing.T) {
	s := newStore(t)
	for name, in := range map[string]Input{
		"no title":         {Body: "x"},
		"blank title":      {Title: " \n ", Body: "x"},
		"long title":       {Title: strings.Repeat("t", MaxTitleChars+1), Body: "x"},
		"long description": {Title: "t", Description: strings.Repeat("d", MaxDescriptionChars+1), Body: "x"},
		"no text":          {Title: "t"},
		"long text":        {Title: "t", Body: strings.Repeat("b", MaxBodyChars+1)},
	} {
		_, err := s.Create(in)
		wantCode(t, err, "invalid_prompt")
		if err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if len(s.List()) != 0 {
		t.Fatal("nothing was kept")
	}
}

func TestAFileMadeByHand(t *testing.T) {
	s := newStore(t)
	os.WriteFile(filepath.Join(s.Dir(), "weekly-update.md"), []byte("---\ntitle: Weekly update\ndescription: >\n  Status for the team\n---\nWrite the update for {{team}}.\n"), 0o600)
	os.WriteFile(filepath.Join(s.Dir(), "no-title.md"), []byte("---\ndescription: x\n---\nBody only\n"), 0o600)
	os.WriteFile(filepath.Join(s.Dir(), "Not An ID.md"), []byte("---\ntitle: Ignored\n---\nx"), 0o600)
	os.WriteFile(filepath.Join(s.Dir(), "empty.md"), []byte("---\ntitle: Empty\n---\n"), 0o600)
	os.WriteFile(filepath.Join(s.Dir(), "notes.txt"), []byte("x"), 0o600)
	list := s.List()
	if len(list) != 2 || list[0].Title != "no-title" || list[1].Title != "Weekly update" || list[1].Description != "Status for the team" || !reflect.DeepEqual(list[1].Placeholders, []string{"team"}) {
		t.Fatalf("list: %+v", list)
	}
}

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, _ := zw.Create(name)
		w.Write([]byte(content))
	}
	zw.Close()
	return buf.Bytes()
}

func TestImportAndExport(t *testing.T) {
	s := newStore(t)
	// One file with front matter; one without (titled by its file name); one with a heading.
	got, skipped, err := s.Import([]byte("---\ntitle: Brainstorm\n---\nGive me ideas about {{topic}}."), "ideas.md")
	if err != nil || skipped != 0 || len(got) != 1 || got[0].Title != "Brainstorm" {
		t.Fatalf("%+v %d %v", got, skipped, err)
	}
	got, _, err = s.Import([]byte("Plain text with {{x}}"), "my-plain_prompt.md")
	if err != nil || got[0].Title != "my plain prompt" {
		t.Fatalf("%+v %v", got, err)
	}
	got, _, err = s.Import([]byte("# A heading title\n\nThe text."), "x.md")
	if err != nil || got[0].Title != "A heading title" || got[0].Body != "The text." {
		t.Fatalf("%+v %v", got, err)
	}
	_, _, err = s.Import(nil, "x.md")
	wantCode(t, err, "empty_file")
	_, _, err = s.Import([]byte("   "), "x.md")
	wantCode(t, err, "invalid_prompt")
	_, _, err = s.Import([]byte("\xff\xfe\x00bad"), "x.md")
	wantCode(t, err, "invalid_prompt")

	// A round trip through an export into another library; the same titles don't replace anything.
	archive, err := s.ExportZip()
	if err != nil {
		t.Fatal(err)
	}
	other := newStore(t)
	other.Create(Input{Title: "Brainstorm", Body: "mine"})
	imported, skipped, err := other.Import(archive, "pi-local-prompts.zip")
	if err != nil || len(imported) != 3 || skipped != 0 {
		t.Fatalf("%d %d %v", len(imported), skipped, err)
	}
	if len(other.List()) != 4 {
		t.Fatalf("list: %+v", other.List())
	}
	// A zip with other things in it: only the Markdown files count, and a bad one is skipped.
	mixed := zipOf(t, map[string]string{"good.md": "---\ntitle: Good\n---\nBody", "bad.md": "---\ntitle: Bad\n---\n", "readme.txt": "x", "__MACOSX/._good.md": "x", ".hidden.md": "x", "sub/deep.md": "Deep text"})
	imported, skipped, err = newStore(t).Import(mixed, "x.zip")
	if err != nil || len(imported) != 2 || skipped != 1 {
		t.Fatalf("%d %d %v", len(imported), skipped, err)
	}
	_, _, err = newStore(t).Import(zipOf(t, map[string]string{"a.txt": "x"}), "x.zip")
	wantCode(t, err, "invalid_prompt")
	_, _, err = newStore(t).Import([]byte("PK\x03\x04 not really"), "x.zip")
	wantCode(t, err, "invalid_archive")
}

func TestTheLibraryHasALimit(t *testing.T) {
	s := newStore(t)
	for i := 0; i < MaxPrompts; i++ {
		os.WriteFile(filepath.Join(s.Dir(), "p"+strings.Repeat("a", 1)+string(rune('a'+i%26))+string(rune('a'+i/26%26))+string(rune('a'+i/676))+".md"), []byte("---\ntitle: T\n---\nx"), 0o600)
	}
	if len(s.List()) != MaxPrompts {
		t.Fatalf("setup: %d", len(s.List()))
	}
	_, err := s.Create(Input{Title: "One more", Body: "x"})
	wantCode(t, err, "too_many")
}
