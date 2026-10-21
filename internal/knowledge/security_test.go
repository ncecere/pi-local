package knowledge

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestIndexAndCitationReadsCannotFollowSymlinkEscapesBetweenScans(t *testing.T) {
	ctx := context.Background()
	dir, outside := t.TempDir(), t.TempDir()
	write(t, filepath.Join(dir, "sub", "policy.txt"), "publicpolicy originally safe")
	write(t, filepath.Join(dir, "sub", "report.pdf"), "safe PDF")
	write(t, filepath.Join(outside, "policy.txt"), "privatepolicy never index this")
	write(t, filepath.Join(outside, "report.pdf"), "private PDF")
	ex := &fakeExtractor{docs: map[string]Result{"report.pdf": {Markdown: "## Page 1\n\nPublic policy report"}}}
	s := newService(t, openDB(t), ex, time.Hour)
	s.SetFolders([]string{dir})
	within(t, 10*time.Second, "the initial scan", ready(s, dir))
	path := filepath.Join(dir, "sub", "policy.txt")
	if file, err := s.OpenIndexed(ctx, []string{dir}, path); err != nil {
		t.Fatal(err)
	} else {
		file.Close()
	}

	// Replace a previously indexed directory, before the watcher gets to remove its stale rows.
	if err := os.RemoveAll(filepath.Join(dir, "sub")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "sub")); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Indexed(ctx, []string{dir}, path); ok {
		t.Fatal("an escaping path counted as indexed")
	}
	if file, err := s.OpenIndexed(ctx, []string{dir}, path); err == nil {
		file.Close()
		t.Fatal("a citation opened through an escaping symlink")
	}
	if hits, _, err := s.Search(ctx, []string{dir}, "publicpolicy", 5); err != nil || len(hits) != 0 {
		t.Fatalf("unsafe stale citations: %+v %v", hits, err)
	}

	// Force the exact race boundary: the walk found the old files, but they are links when read.
	s.indexText(dir, found{rel: "sub/policy.txt", kind: "text"})
	results := s.extractDocuments(ctx, dir, []found{{rel: "sub/report.pdf", kind: "pdf"}})
	if result := results[filepath.Join(dir, "sub", "report.pdf")]; result.Error == "" || result.Markdown != "" {
		t.Fatalf("converter got an escaping file: %+v", result)
	}
	if len(ex.called()) != 1 {
		t.Fatalf("unsafe path reached the converter: %v", ex.called())
	}
	if hits, _, _ := s.Search(ctx, []string{dir}, "privatepolicy", 5); len(hits) != 0 {
		t.Fatal("outside content was indexed")
	}

	s.Rescan(dir)
	within(t, 10*time.Second, "the stale rows to be removed", func() bool { return s.Status(ctx, dir).Files == 0 })
}

func TestAConverterGetsPrivateSnapshotsAndTheyAreRemoved(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "report.pdf"), "original bytes")
	ex := checkingExtractor{t: t, original: filepath.Join(dir, "report.pdf")}
	s := New(NewStore(openDB(t)), &ex, time.Hour, nil)
	defer s.Close()
	results := s.extractDocuments(context.Background(), dir, []found{{rel: "report.pdf", kind: "pdf"}})
	if results[ex.original].Markdown != "converted" {
		t.Fatalf("%+v", results)
	}
	if _, err := os.Stat(ex.snapshot); !os.IsNotExist(err) {
		t.Fatalf("snapshot left behind: %v", err)
	}
}

type checkingExtractor struct {
	t                  *testing.T
	original, snapshot string
}

func (e *checkingExtractor) Extract(_ context.Context, paths []string) map[string]Result {
	if len(paths) != 1 || paths[0] == e.original {
		e.t.Fatalf("not snapshots: %v", paths)
	}
	e.snapshot = paths[0]
	data, err := os.ReadFile(paths[0])
	if err != nil || string(data) != "original bytes" {
		e.t.Fatalf("snapshot: %q %v", data, err)
	}
	return map[string]Result{paths[0]: {Markdown: "converted"}}
}

func TestSymlinkRootsAndFinalLinksCannotOpenIndexedFiles(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	write(t, filepath.Join(outside, "private.txt"), "private")
	os.Symlink(filepath.Join(outside, "private.txt"), filepath.Join(dir, "link.txt"))
	if f, err := openLocalFile(dir, "link.txt"); err == nil {
		f.Close()
		t.Fatal("opened a final symlink")
	}
	alias := filepath.Join(t.TempDir(), "docs")
	os.Symlink(outside, alias)
	if f, err := openLocalFile(alias, "private.txt"); err == nil {
		f.Close()
		t.Fatal("opened a symlink root")
	}
	if rel, ok := relativeFile(dir, filepath.Join(dir, "..notes.txt")); !ok || !strings.HasPrefix(rel, "..notes") {
		t.Fatal("a safe dot-prefixed filename was refused")
	}
}
