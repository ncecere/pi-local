package knowledge

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/appdb"
)

func openDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := appdb.Open(context.Background(), filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// fakeExtractor "reads" documents: a file's Markdown is what the test registered for its name.
type fakeExtractor struct {
	mu    sync.Mutex
	docs  map[string]Result // by base name
	calls []string
}

func (f *fakeExtractor) Extract(_ context.Context, paths []string) map[string]Result {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]Result{}
	for _, p := range paths {
		f.calls = append(f.calls, filepath.Base(p))
		if r, ok := f.docs[filepath.Base(p)]; ok {
			out[p] = r
		} else {
			out[p] = Result{Error: filepath.Base(p) + " could not be read as a PDF (damaged?)"}
		}
	}
	return out
}

func (f *fakeExtractor) called() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.calls...)
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func within(t *testing.T, d time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func ready(s *Service, folder string) func() bool {
	return func() bool {
		st := s.Status(context.Background(), folder)
		return st.State == "ready" || st.State == "missing"
	}
}

func texts(hits []Hit) string {
	var b strings.Builder
	for _, h := range hits {
		b.WriteString(h.Rel + ": " + h.Text + "\n")
	}
	return b.String()
}

func newService(t *testing.T, db *sql.DB, ex Extractor, interval time.Duration) *Service {
	t.Helper()
	s := New(NewStore(db), ex, interval, nil)
	s.Start()
	t.Cleanup(s.Close)
	return s
}

func TestAFolderIsIndexedAndSearchedWithWhatIsSkippedSaid(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "policy.md"), "# Refund policy\n\nRefunds take 14 days after the request.\n")
	write(t, filepath.Join(dir, "sub", "notes.txt"), "Shipping is free for orders over $50.\n")
	write(t, filepath.Join(dir, "report.pdf"), "pdf bytes")
	write(t, filepath.Join(dir, "broken.pdf"), "damaged")
	write(t, filepath.Join(dir, ".hidden.txt"), "secret refunds in a hidden file")
	write(t, filepath.Join(dir, ".git", "config.txt"), "secret refunds in a hidden folder")
	write(t, filepath.Join(dir, "node_modules", "pkg", "readme.md"), "refunds in node_modules")
	write(t, filepath.Join(dir, "~$report.docx"), "an office lock file")
	write(t, filepath.Join(dir, "image.png"), "not indexed")
	write(t, filepath.Join(dir, "empty.txt"), "   \n")
	big := filepath.Join(dir, "huge.pdf")
	write(t, big, "")
	os.Truncate(big, MaxFileBytes+1)
	os.Symlink(filepath.Join(dir, "policy.md"), filepath.Join(dir, "link.md"))

	ex := &fakeExtractor{docs: map[string]Result{
		"report.pdf": {Markdown: "# report.pdf\n\n(PDF, 2 pages, as text)\n\n## Page 1\n\nRevenue grew 12 percent in the third quarter.\n\n## Page 2\n\nRefunds are handled by support@example.com.\n"},
	}}
	s := newService(t, openDB(t), ex, time.Hour)
	s.SetFolders([]string{dir})
	within(t, 10*time.Second, "the first scan", ready(s, dir))

	st := s.Status(context.Background(), dir)
	if st.Files != 3 || st.Problems != 1 || st.TooLarge != 1 || st.Passages != 4 || st.Truncated || st.LastScanAt == nil || st.Progress != nil {
		t.Fatalf("status: %+v", st)
	}
	// Hidden files and folders, node_modules, lock files, links and other kinds are left out, and the huge one isn't read.
	for _, called := range ex.called() {
		if called == "huge.pdf" || strings.HasPrefix(called, "~$") {
			t.Errorf("read %s", called)
		}
	}
	problems := s.Problems(context.Background(), dir, 10)
	if len(problems) != 2 || problems[0].Rel != "broken.pdf" || problems[0].Status != StatusError || !strings.Contains(problems[0].Message, "could not be read as a PDF") ||
		problems[1].Rel != "huge.pdf" || problems[1].Status != StatusTooLarge || !strings.Contains(problems[1].Message, "50 MB") {
		t.Fatalf("problems: %+v", problems)
	}

	hits, info, err := s.Search(context.Background(), []string{dir}, "How long do refunds take?", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 || hits[0].Rel != "policy.md" || info.Files != 3 || info.Folders != 1 {
		t.Fatalf("hits: %s info %+v", texts(hits), info)
	}
	if strings.Contains(texts(hits), "hidden") || strings.Contains(texts(hits), "node_modules") {
		t.Fatalf("skipped files were searched: %s", texts(hits))
	}
	// Where it is from: the page of a PDF, and the path to open.
	hits, _, _ = s.Search(context.Background(), []string{dir}, "support email refunds", 5)
	if hits[0].Rel != "report.pdf" || hits[0].Locator != "page 2" || hits[0].Path != filepath.Join(dir, "report.pdf") || hits[0].File != "report.pdf" {
		t.Fatalf("pdf hit: %+v", hits[0])
	}
	// Stemming, prefixes, the file's name, diacritics; no syntax gets through.
	for _, q := range []string{"refunding", "refun", "NOTES", `shipping" OR "x`, "orders AND NOT free"} {
		if hits, _, err := s.Search(context.Background(), []string{dir}, q, 5); err != nil || len(hits) == 0 {
			t.Errorf("%q: %d hits, %v", q, len(hits), err)
		}
	}
	if hits, _, _ := s.Search(context.Background(), []string{dir}, "zebra", 5); len(hits) != 0 {
		t.Errorf("zebra: %s", texts(hits))
	}
	// Another folder is a different index.
	if hits, _, _ := s.Search(context.Background(), []string{t.TempDir()}, "refunds", 5); len(hits) != 0 {
		t.Errorf("another folder: %s", texts(hits))
	}
	if folder, ok := s.Indexed(context.Background(), []string{dir}, filepath.Join(dir, "sub", "notes.txt")); !ok || folder != dir {
		t.Errorf("indexed: %v %v", folder, ok)
	}
	for _, p := range []string{filepath.Join(dir, ".hidden.txt"), filepath.Join(dir, "link.md"), filepath.Join(dir, "..", "x.txt"), "/etc/hosts", dir} {
		if _, ok := s.Indexed(context.Background(), []string{dir}, p); ok {
			t.Errorf("%s counted as indexed", p)
		}
	}
}

func TestTheWatcherNoticesChangesNewFilesAndDeletions(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "a.txt"), "The apple is red.")
	write(t, filepath.Join(dir, "b.txt"), "The banana is yellow.")
	s := newService(t, openDB(t), &fakeExtractor{}, 100*time.Millisecond)
	s.SetFolders([]string{dir})
	within(t, 10*time.Second, "the first scan", ready(s, dir))
	found := func(q string) bool {
		hits, _, _ := s.Search(context.Background(), []string{dir}, q, 5)
		return len(hits) > 0
	}
	if !found("apple") || !found("banana") {
		t.Fatal("not indexed")
	}

	// Edited (a different size, so the change shows even within one timestamp tick), new, and deleted.
	write(t, filepath.Join(dir, "a.txt"), "The cherry is dark red and sweet.")
	write(t, filepath.Join(dir, "c.txt"), "The date is sticky.")
	os.Remove(filepath.Join(dir, "b.txt"))
	within(t, 10*time.Second, "the watcher to see the changes", func() bool {
		return found("cherry") && found("date") && !found("banana")
	})
	if found("apple") {
		t.Fatal("the old text of an edited file is still searchable")
	}
	// Same byte length, different sub-millisecond mtime: an edit still replaces the indexed text.
	stamp := time.Now().Truncate(time.Millisecond).Add(100 * time.Nanosecond)
	os.Chtimes(filepath.Join(dir, "c.txt"), stamp, stamp)
	s.Rescan(dir)
	within(t, 10*time.Second, "the nanosecond timestamp", func() bool {
		files, _ := s.store.files(context.Background(), dir)
		for _, file := range files {
			if file.Rel == "c.txt" {
				return file.MTime == stamp.UnixNano()
			}
		}
		return false
	})
	write(t, filepath.Join(dir, "c.txt"), "The kiwi is sticky.")
	stamp = stamp.Add(100 * time.Nanosecond)
	os.Chtimes(filepath.Join(dir, "c.txt"), stamp, stamp)
	within(t, 10*time.Second, "the same-size edit", func() bool { return found("kiwi") && !found("date") })
	if st := s.Status(context.Background(), dir); st.Files != 2 || st.Passages != 2 {
		t.Fatalf("status: %+v", st)
	}
}

func TestOnlyWhatChangedIsReadAgainAfterARestartAndFailuresAreRetried(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "good.pdf"), "x")
	write(t, filepath.Join(dir, "bad.pdf"), "y")
	db := openDB(t)
	ex := &fakeExtractor{docs: map[string]Result{"good.pdf": {Markdown: "## Page 1\n\nGood text about walruses."}}}
	first := New(NewStore(db), ex, time.Hour, nil)
	first.Start()
	first.SetFolders([]string{dir})
	within(t, 10*time.Second, "the first scan", ready(first, dir))
	first.Close()
	if got := strings.Join(ex.called(), ","); got != "good.pdf,bad.pdf" && got != "bad.pdf,good.pdf" {
		t.Fatalf("first run read %s", got)
	}

	// The app starts again: the folder is scanned again (a rescan on start), reading only what failed or changed.
	before := len(ex.called())
	ex.docs["bad.pdf"] = Result{Markdown: "## Page 1\n\nNow it reads: otters."}
	second := New(NewStore(db), ex, time.Hour, nil)
	second.Start()
	defer second.Close()
	second.SetFolders([]string{dir})
	within(t, 10*time.Second, "the second scan", func() bool { return second.Status(context.Background(), dir).Problems == 0 && ready(second, dir)() })
	if got := ex.called()[before:]; len(got) != 1 || got[0] != "bad.pdf" {
		t.Fatalf("second run read %v", got)
	}
	if hits, _, _ := second.Search(context.Background(), []string{dir}, "walruses otters", 5); len(hits) != 2 {
		t.Fatalf("hits: %s", texts(hits))
	}
}

func TestTheFileCapIsSaid(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 8; i++ {
		write(t, filepath.Join(dir, fmt.Sprintf("f%d.txt", i)), fmt.Sprintf("document number %d", i))
	}
	defer func(old int) { maxFiles = old }(maxFiles)
	maxFiles = 5
	s := newService(t, openDB(t), &fakeExtractor{}, time.Hour)
	s.SetFolders([]string{dir})
	within(t, 10*time.Second, "the scan", ready(s, dir))
	if st := s.Status(context.Background(), dir); st.Files != 5 || !st.Truncated {
		t.Fatalf("status: %+v", st)
	}
}

func TestAMissingFolderIsSaidAndLeftOutOfSearchesAndRemovedFoldersAreForgotten(t *testing.T) {
	dir, other := t.TempDir(), t.TempDir()
	write(t, filepath.Join(dir, "a.txt"), "alpha text")
	write(t, filepath.Join(other, "b.txt"), "alpha text elsewhere")
	db := openDB(t)
	s := newService(t, db, &fakeExtractor{}, time.Hour)
	s.SetFolders([]string{dir, other, filepath.Join(t.TempDir(), "gone")})
	gone := filepath.Join(filepath.Dir(other), "x")
	_ = gone
	within(t, 10*time.Second, "the scans", func() bool { return ready(s, dir)() && ready(s, other)() })
	hits, info, _ := s.Search(context.Background(), []string{dir, other}, "alpha", 5)
	if len(hits) != 2 || info.Folders != 2 {
		t.Fatalf("hits: %s %+v", texts(hits), info)
	}

	// The folder goes away (an unplugged drive): its status says so, and it is not searched, but its index stays.
	os.RemoveAll(other)
	s.Rescan(other)
	within(t, 10*time.Second, "the missing status", func() bool { return s.Status(context.Background(), other).State == "missing" })
	if st := s.Status(context.Background(), other); !strings.Contains(st.Error, "isn't on this computer") || st.Files != 1 {
		t.Fatalf("missing: %+v", st)
	}
	hits, info, _ = s.Search(context.Background(), []string{dir, other}, "alpha", 5)
	if len(hits) != 1 || info.Folders != 1 {
		t.Fatalf("after it went: %s %+v", texts(hits), info)
	}

	// No longer wanted: forgotten, files and passages.
	s.SetFolders([]string{dir})
	within(t, 10*time.Second, "the folder to be forgotten", func() bool { return s.Status(context.Background(), other).Files == 0 })
	var n int
	db.QueryRow(`SELECT (SELECT COUNT(*) FROM knowledge_files WHERE folder = ?) + (SELECT COUNT(*) FROM knowledge_folders WHERE path = ?)`, other, other).Scan(&n)
	if n != 0 {
		t.Fatalf("%d rows left for a forgotten folder", n)
	}
	var passages int
	db.QueryRow(`SELECT COUNT(*) FROM knowledge_passages`).Scan(&passages)
	if passages != 1 {
		t.Fatalf("%d passages left, want 1", passages)
	}
	// What the index kept from an earlier run for a folder nobody wants is dropped at the next SetFolders.
	write(t, filepath.Join(t.TempDir(), "x"), "")
	db.Exec(`INSERT INTO knowledge_files (folder, rel, size, mtime, status, indexed_at) VALUES ('/old/folder', 'x.txt', 1, 1, 'indexed', 1)`)
	s.SetFolders([]string{dir})
	within(t, 10*time.Second, "the orphan to be dropped", func() bool {
		var n int
		db.QueryRow(`SELECT COUNT(*) FROM knowledge_files WHERE folder = '/old/folder'`).Scan(&n)
		return n == 0
	})
}

func TestAnExtractorsFailuresAreNotesOnTheFile(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "scan.pdf"), "x")
	write(t, filepath.Join(dir, "locked.docx"), "x")
	ex := &fakeExtractor{docs: map[string]Result{
		"scan.pdf":    {Markdown: "# scan.pdf\n\n(PDF, 1 page, as text)\n\nThis PDF has no text layer: it is probably scanned images. Its text can't be read this way.\n"},
		"locked.docx": {Error: "locked.docx is protected by a password"},
	}}
	s := newService(t, openDB(t), ex, time.Hour)
	s.SetFolders([]string{dir})
	within(t, 10*time.Second, "the scan", ready(s, dir))
	p := s.Problems(context.Background(), dir, 10)
	if len(p) != 2 || !strings.Contains(p[0].Message, "protected by a password.") || !strings.Contains(p[1].Message, "scanned PDF") {
		t.Fatalf("%+v", p)
	}
	if st := s.Status(context.Background(), dir); st.Problems != 2 || st.Files != 0 || st.State != "ready" {
		t.Fatalf("%+v", st)
	}
}

func TestSearchCombinesFoldersAndAFileInTwoOverlappingFoldersIsOneResult(t *testing.T) {
	outer := t.TempDir()
	inner := filepath.Join(outer, "inner")
	write(t, filepath.Join(inner, "a.txt"), "walrus facts")
	write(t, filepath.Join(outer, "b.txt"), "walrus tusks")
	s := newService(t, openDB(t), &fakeExtractor{}, time.Hour)
	s.SetFolders([]string{outer, inner})
	within(t, 10*time.Second, "the scans", func() bool { return ready(s, outer)() && ready(s, inner)() })
	hits, _, _ := s.Search(context.Background(), []string{outer, inner}, "walrus", 10)
	if len(hits) != 2 {
		t.Fatalf("%d hits: %s", len(hits), texts(hits))
	}
}

func TestBM25PutsTheBetterPassageFirstAndFillerWordsDontMatter(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "a.txt"), "The office is closed on public holidays. Staff may take leave.")
	write(t, filepath.Join(dir, "b.txt"), "Parental leave policy: eligible staff may take up to twelve weeks of parental leave.")
	write(t, filepath.Join(dir, "c.txt"), "The cafeteria menu changes weekly.")
	s := newService(t, openDB(t), &fakeExtractor{}, time.Hour)
	s.SetFolders([]string{dir})
	within(t, 10*time.Second, "the scan", ready(s, dir))
	hits, _, _ := s.Search(context.Background(), []string{dir}, "What is the policy on parental leave for staff?", 5)
	if len(hits) < 2 || hits[0].Rel != "b.txt" {
		t.Fatalf("%s", texts(hits))
	}
	// A question of nothing but filler still searches (every word counts then).
	if hits, _, _ := s.Search(context.Background(), []string{dir}, "the on", 5); len(hits) == 0 {
		t.Fatal("an all-filler query found nothing")
	}
}

func TestPurgingWhileScanningLeavesNothingBehind(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 40; i++ {
		write(t, filepath.Join(dir, fmt.Sprintf("f%d.txt", i)), strings.Repeat("some words to index ", 50))
	}
	db := openDB(t)
	s := newService(t, db, &fakeExtractor{}, time.Hour)
	s.SetFolders([]string{dir})
	s.SetFolders(nil)
	within(t, 10*time.Second, "everything forgotten", func() bool {
		var files int
		db.QueryRow(`SELECT COUNT(*) FROM knowledge_files`).Scan(&files)
		var passages int
		db.QueryRow(`SELECT COUNT(*) FROM knowledge_passages`).Scan(&passages)
		return files == 0 && passages == 0 && !s.watching(dir)
	})
	time.Sleep(200 * time.Millisecond)
	var files int
	db.QueryRow(`SELECT COUNT(*) FROM knowledge_files`).Scan(&files)
	if files != 0 {
		t.Fatalf("%d files came back", files)
	}
}
