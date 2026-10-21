// Package knowledge indexes the documents in the folders agents were given (agent.yaml `knowledge`) so they can be
// searched and cited: text files, Markdown, PDF, Word, Excel and PowerPoint, split into passages of about 1,200
// characters, in an FTS5 index in app.db. Folders are read again when the app starts and checked for changes every
// half minute (the module has no file-watching library, and polling a folder's file list is cheap); only files that
// changed are read again. Hidden files and folders, files over 50 MB and everything past 10,000 files in a folder are
// left out, and the status says so.
package knowledge

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ncecere/pi-local/internal/search"
)

// Limits.
const (
	MaxFileBytes = 50 << 20
	MaxFiles     = 10_000
)

// maxFiles is MaxFiles (a variable for the tests).
var maxFiles = MaxFiles

var textExt = map[string]string{
	".txt": "text", ".md": "md", ".markdown": "md", ".mdx": "md", ".rst": "text", ".org": "text", ".tex": "text",
	".csv": "text", ".tsv": "text", ".log": "text", ".json": "text", ".yaml": "text", ".yml": "text", ".toml": "text", ".ini": "text",
}

var docExt = map[string]string{".pdf": "pdf", ".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx"}

// KindOf is what kind of file a name is ("pdf", "docx", "xlsx", "pptx", "md", "text"), or "" when it isn't indexed.
func KindOf(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if k, ok := docExt[ext]; ok {
		return k
	}
	return textExt[ext]
}

// Service watches and indexes folders, one at a time.
type Service struct {
	store     *Store
	extractor Extractor
	interval  time.Duration
	onChange  func()

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	queue  chan request
	wake   chan struct{}

	// Reconciliation and deletion are serialized: a folder cannot be re-added between the purge's reference
	// check and its transaction. This lock is separate from mu, which is never held while waiting on app.db.
	reconcileMu sync.Mutex
	mu          sync.Mutex
	folders     map[string]*state
	purges      map[string]struct{} // reliable work, independent of the bounded scan queue
	lastOn      time.Time
}

type request struct {
	path string
	full bool // retry the files that failed
}

// state is a watched folder's progress, in memory.
type state struct {
	queued   bool
	scanning bool
	done     int
	total    int
}

// New makes the service; Start begins watching.
func New(store *Store, extractor Extractor, interval time.Duration, onChange func()) *Service {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{store: store, extractor: extractor, interval: interval, onChange: onChange, ctx: ctx, cancel: cancel,
		queue: make(chan request, 512), wake: make(chan struct{}, 1),
		folders: map[string]*state{}, purges: map[string]struct{}{}}
}

// Store is the index, for the status and search.
func (s *Service) Store() *Store { return s.store }

// Start begins the service's goroutine.
func (s *Service) Start() {
	s.wg.Add(1)
	go s.loop()
}

// Close cancels scans, conversion and passage splitting before waiting for the worker.
func (s *Service) Close() {
	s.cancel()
	s.wg.Wait()
}

func (s *Service) loop() {
	defer s.wg.Done()
	tick := time.NewTicker(s.interval)
	defer tick.Stop()
	// Failed deletes stay pending; don't depend on another config change or a free scan-queue slot to retry.
	retry := time.NewTicker(time.Second)
	defer retry.Stop()
	for {
		if s.ctx.Err() != nil {
			return
		}
		// Give pending removals priority even when all 512 scan slots are occupied.
		select {
		case <-s.wake:
			s.drainPurges()
		default:
		}
		select {
		case <-s.ctx.Done():
			return
		case <-s.wake:
			s.drainPurges()
		case <-retry.C:
			s.drainPurges()
		case r := <-s.queue:
			s.scan(r.path, r.full)
		case <-tick.C:
			s.mu.Lock()
			var paths []string
			for p := range s.folders {
				paths = append(paths, p)
			}
			s.mu.Unlock()
			for _, p := range paths {
				s.enqueue(request{path: p})
			}
		}
	}
}

// enqueue asks for a scan unless one is already waiting for that folder.
func (s *Service) enqueue(r request) {
	s.mu.Lock()
	st, watched := s.folders[r.path]
	if !watched || (st.queued && !r.full) {
		s.mu.Unlock()
		return
	}
	st.queued = true
	s.mu.Unlock()
	select {
	case s.queue <- r:
	default:
		// Full: the next tick asks again.
		s.mu.Lock()
		if current, ok := s.folders[r.path]; ok && current == st {
			current.queued = false
		}
		s.mu.Unlock()
	}
}

// SetFolders says which folders are watched (every agent's knowledge folders, together): new ones are read now, ones
// no longer wanted are forgotten, and so is anything the index has for a folder that isn't wanted (a deleted agent's,
// from before the app was closed).
func (s *Service) SetFolders(paths []string) {
	s.reconcileMu.Lock()
	want := map[string]bool{}
	for _, p := range paths {
		want[filepath.Clean(p)] = true
	}
	// Read all rows before taking mu (app.db has one connection). Include orphaned indexes from earlier runs.
	known, err := s.store.folderPaths(s.ctx)
	if err != nil && s.ctx.Err() == nil {
		slog.Warn("listing old knowledge folders", "err", err)
	}
	s.mu.Lock()
	var added []string
	for p := range want {
		delete(s.purges, p) // a new reference cancels an old pending removal
		if _, ok := s.folders[p]; !ok {
			s.folders[p] = &state{}
			added = append(added, p)
		}
	}
	for p := range s.folders {
		if !want[p] {
			delete(s.folders, p)
			s.purges[p] = struct{}{}
		}
	}
	for _, p := range known {
		if !want[p] {
			s.purges[p] = struct{}{}
		}
	}
	pending := len(s.purges) > 0
	s.mu.Unlock()
	s.reconcileMu.Unlock()
	if pending {
		select {
		case s.wake <- struct{}{}:
		default: // the pending map, not the signal, owns the work
		}
	}
	sort.Strings(added)
	for _, p := range added {
		s.enqueue(request{path: p, full: true})
	}
	s.changed(true)
}

// Rescan reads a folder again now, including the files that failed before.
func (s *Service) Rescan(path string) {
	s.enqueue(request{path: filepath.Clean(path), full: true})
	s.changed(true)
}

func (s *Service) watching(path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.folders[path]
	return ok
}

func (s *Service) progress(path string, done, total int, scanning bool) {
	s.mu.Lock()
	if st, ok := s.folders[path]; ok {
		st.done, st.total, st.scanning = done, total, scanning
		if scanning {
			st.queued = false
		}
	}
	s.mu.Unlock()
}

// changed tells the listener, at most four times a second unless forced.
func (s *Service) changed(force bool) {
	if s.onChange == nil {
		return
	}
	s.mu.Lock()
	if !force && time.Since(s.lastOn) < 250*time.Millisecond {
		s.mu.Unlock()
		return
	}
	s.lastOn = time.Now()
	s.mu.Unlock()
	s.onChange()
}

// drainPurges leaves failures pending for the retry ticker. Serialize the final reference check and deletion with
// SetFolders, so a stale removal can never delete a folder that was re-added. Never hold mu during database work.
func (s *Service) drainPurges() {
	s.mu.Lock()
	paths := make([]string, 0, len(s.purges))
	for path := range s.purges {
		paths = append(paths, path)
	}
	s.mu.Unlock()
	for _, path := range paths {
		if s.ctx.Err() != nil {
			return
		}
		s.reconcileMu.Lock()
		s.mu.Lock()
		_, pending := s.purges[path]
		_, watched := s.folders[path]
		s.mu.Unlock()
		if !pending || watched {
			s.reconcileMu.Unlock()
			continue
		}
		err := s.store.forget(s.ctx, path)
		if err == nil {
			s.mu.Lock()
			delete(s.purges, path)
			s.mu.Unlock()
		}
		s.reconcileMu.Unlock()
		if err != nil && s.ctx.Err() == nil {
			slog.Warn("forgetting a knowledge folder; will retry", "folder", path, "err", err)
		}
		if err == nil {
			s.changed(true)
		}
	}
}

type found struct {
	rel   string
	kind  string
	size  int64
	mtime int64
}

// walk lists the files to index: not hidden, not links, of a kind that has text, at most MaxFiles of them (truncated
// says there were more).
func walk(root string) (files []found, truncated bool, err error) {
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == root {
				return err
			}
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil // unreadable: left out
		}
		name := d.Name()
		if path != root && (strings.HasPrefix(name, ".") || strings.HasPrefix(name, "~$")) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if name == "node_modules" && path != root {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() { // links, sockets, devices
			return nil
		}
		kind := KindOf(name)
		if kind == "" {
			return nil
		}
		if strings.ContainsAny(name, "\n\r") {
			return nil
		}
		if len(files) >= maxFiles {
			truncated = true
			return fs.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		files = append(files, found{rel: filepath.ToSlash(rel), kind: kind, size: info.Size(), mtime: info.ModTime().UnixNano()})
		return nil
	})
	return files, truncated, err
}

// scan brings one folder's index up to date.
func (s *Service) scan(path string, full bool) {
	if s.ctx.Err() != nil || !s.watching(path) {
		return
	}
	s.progress(path, 0, 0, true)
	s.changed(false)
	defer func() {
		s.progress(path, 0, 0, false)
		s.changed(true)
	}()
	ctx := s.ctx

	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() {
		msg := "This folder isn't on this computer any more (is a drive unplugged?)."
		if err == nil {
			msg = "This isn't a folder."
		}
		s.store.setFolder(ctx, path, nil, false, msg)
		return
	}
	list, truncated, err := walk(path)
	if err != nil {
		s.store.setFolder(ctx, path, nil, false, "This folder can't be read: "+err.Error())
		return
	}
	existing, err := s.store.files(ctx, path)
	if err != nil {
		slog.Warn("reading the knowledge index", "folder", path, "err", err)
		return
	}
	have := make(map[string]fileRow, len(existing))
	for _, f := range existing {
		have[f.Rel] = f
	}
	seen := make(map[string]bool, len(list))
	var todo []found
	for _, f := range list {
		seen[f.rel] = true
		e, ok := have[f.rel]
		switch {
		case !ok, e.Size != f.size, e.MTime != f.mtime:
			todo = append(todo, f)
		case full && e.Status == StatusError:
			todo = append(todo, f)
		}
	}
	// Gone (or past the cap now): out of the index.
	for _, e := range existing {
		if !seen[e.Rel] {
			if err := s.store.remove(ctx, e.ID); err != nil && ctx.Err() == nil {
				slog.Warn("removing a file from the knowledge index", "folder", path, "err", err)
			}
		}
	}

	// Files over the limit are only noted; the rest are read: text by us, documents by the runtime, in batches.
	var texts, docs []found
	for _, f := range todo {
		switch {
		case f.size > MaxFileBytes:
			s.store.put(ctx, path, f.rel, f.size, f.mtime, StatusTooLarge, "Larger than 50 MB: not read.", nil)
		case f.kind == "text" || f.kind == "md":
			texts = append(texts, f)
		default:
			docs = append(docs, f)
		}
	}
	total := len(texts) + len(docs)
	done := 0
	s.progress(path, done, total, true)
	for _, f := range texts {
		if ctx.Err() != nil || !s.watching(path) {
			return
		}
		s.indexText(path, f)
		done++
		s.progress(path, done, total, true)
		s.changed(false)
	}
	const batch = 12
	for i := 0; i < len(docs); i += batch {
		if ctx.Err() != nil || !s.watching(path) {
			return
		}
		group := docs[i:min(i+batch, len(docs))]
		abs := make([]string, len(group))
		for j, f := range group {
			abs[j] = filepath.Join(path, filepath.FromSlash(f.rel))
		}
		results := s.extractDocuments(ctx, path, group)
		for j, f := range group {
			if ctx.Err() != nil || !s.watching(path) {
				return
			}
			s.indexDocument(path, f, results[abs[j]])
			done++
			s.progress(path, done, total, true)
		}
		s.changed(false)
	}
	if ctx.Err() != nil || !s.watching(path) {
		return
	}
	now := time.Now().UnixMilli()
	if err := s.store.setFolder(ctx, path, &now, truncated, ""); err != nil && ctx.Err() == nil {
		slog.Warn("recording a knowledge scan", "folder", path, "err", err)
	}
}

func (s *Service) indexText(folder string, f found) {
	raw, err := readLocalFile(folder, f.rel)
	if err != nil {
		s.store.put(s.ctx, folder, f.rel, f.size, f.mtime, StatusError, "Could not be read: "+firstLine(err.Error()), nil)
		return
	}
	head := raw
	if len(head) > 8192 {
		head = head[:8192]
	}
	if strings.ContainsRune(string(head), 0) {
		s.store.put(s.ctx, folder, f.rel, f.size, f.mtime, StatusError, "Not a text file.", nil)
		return
	}
	passages, err := SplitContext(s.ctx, string(raw), f.kind)
	if err == nil {
		s.store.put2(s.ctx, folder, f, passages)
	}
}

func (s *Service) indexDocument(folder string, f found, r Result) {
	if r.Error != "" {
		s.store.put(s.ctx, folder, f.rel, f.size, f.mtime, StatusError, ensureSentence(r.Error), nil)
		return
	}
	if r.Markdown == "" {
		s.store.put(s.ctx, folder, f.rel, f.size, f.mtime, StatusError, "Nothing came back from reading it.", nil)
		return
	}
	// A scanned PDF: the converter says so, and there is nothing to search.
	if f.kind == "pdf" && !strings.Contains(r.Markdown, "\n## Page ") && strings.Contains(r.Markdown, "has no text layer") {
		s.store.put(s.ctx, folder, f.rel, f.size, f.mtime, StatusError, "A scanned PDF: it has no text to search.", nil)
		return
	}
	passages, err := SplitContext(s.ctx, r.Markdown, f.kind)
	if err == nil {
		s.store.put2(s.ctx, folder, f, passages)
	}
}

func ensureSentence(s string) string {
	s = strings.TrimSpace(s)
	if s != "" && !strings.HasSuffix(s, ".") {
		s += "."
	}
	return s
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

// put2 stores a read file's passages: indexed, partial (cut at the passage limit), or empty.
func (s *Store) put2(ctx context.Context, folder string, f found, passages []Passage) {
	status, problem := StatusIndexed, ""
	switch {
	case len(passages) == 0:
		status = StatusEmpty
	case len(passages) >= maxPassagesPerFile:
		status, problem = StatusPartial, "Very long: only the first part is searchable."
	}
	if err := s.put(ctx, folder, f.rel, f.size, f.mtime, status, problem, passages); err != nil && ctx.Err() == nil {
		slog.Warn("indexing a file", "folder", folder, "file", f.rel, "err", err)
	}
}

// --- status and search ----------------------------------------------------------------------------------------

// Progress is a scan under way.
type Progress struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

// FolderStatus is what the Knowledge tab shows for a folder.
type FolderStatus struct {
	Path string `json:"path"`
	// State: waiting (not read yet), indexing, ready, or missing (the folder isn't there).
	State    string `json:"state"`
	Files    int    `json:"files"`    // files with text in the index
	Passages int    `json:"passages"` // searchable passages
	Problems int    `json:"problems"` // files that could not be read
	TooLarge int    `json:"tooLarge"` // files over the size limit
	Partial  int    `json:"partial"`  // very long files, only partly searchable
	// Truncated: the folder has more than MaxFiles files of kinds that are read; the first ones are indexed.
	Truncated bool `json:"truncated"`
	// LastScanAt: when the folder was last read through (Unix ms), nil before the first time.
	LastScanAt *int64    `json:"lastScanAt"`
	Error      string    `json:"error,omitempty"`
	Progress   *Progress `json:"progress,omitempty"`
}

// Status is a folder's status.
func (s *Service) Status(ctx context.Context, path string) FolderStatus {
	path = filepath.Clean(path)
	st := FolderStatus{Path: path, State: "waiting"}
	s.mu.Lock()
	cur, watched := s.folders[path]
	var scanning bool
	if watched && cur.scanning {
		scanning = true
		st.Progress = &Progress{Done: cur.done, Total: cur.total}
	}
	s.mu.Unlock()
	if c, err := s.store.counts(ctx, path); err == nil {
		st.Files, st.Passages, st.Problems, st.TooLarge, st.Partial = c.Files, c.Passages, c.Problems, c.TooLarge, c.Partial
	}
	row, _ := s.store.folder(ctx, path)
	st.LastScanAt, st.Truncated, st.Error = row.ScannedAt, row.Truncated, row.Error
	switch {
	case row.Error != "":
		st.State = "missing"
	case scanning && (row.ScannedAt == nil || st.Progress.Total > 0):
		// A check that finds nothing changed is over in a moment: it isn't "indexing".
		st.State = "indexing"
	case row.ScannedAt != nil:
		st.State = "ready"
	}
	if st.State != "indexing" {
		st.Progress = nil
	}
	return st
}

// Problems lists the files of a folder that could not be read (or only in part), up to limit.
func (s *Service) Problems(ctx context.Context, path string, limit int) []Problem {
	out, err := s.store.problems(ctx, filepath.Clean(path), limit)
	if err != nil {
		return []Problem{}
	}
	return out
}

// Indexed says whether a path is a file in one of the folders that the index holds, and returns the folder it is in.
func (s *Service) Indexed(ctx context.Context, folders []string, path string) (string, bool) {
	path = filepath.Clean(path)
	for _, f := range folders {
		rel, valid := relativeFile(f, path)
		if !valid {
			continue
		}
		if ok, _ := s.store.hasFile(ctx, f, filepath.ToSlash(rel)); ok {
			file, err := openLocalFile(f, rel)
			if err == nil {
				file.Close()
				return f, true
			}
		}
	}
	return "", false
}

// Searched is what a search covered.
type Searched struct {
	Folders  int       `json:"folders"`
	Files    int       `json:"files"`
	Passages int       `json:"passages"`
	Indexing *Progress `json:"indexing,omitempty"`
}

// Search finds the best passages for a question in the folders, best first (at most limit), and what it searched.
// Folders that are missing are left out: their files can't be opened.
func (s *Service) Search(ctx context.Context, folders []string, query string, limit int) ([]Hit, Searched, error) {
	var info Searched
	var usable []string
	for _, f := range folders {
		st := s.Status(ctx, f)
		if st.State == "missing" {
			continue
		}
		usable = append(usable, filepath.Clean(f))
		info.Folders++
		info.Files += st.Files
		info.Passages += st.Passages
		if st.State == "indexing" || st.State == "waiting" {
			if info.Indexing == nil {
				info.Indexing = &Progress{}
			}
			if st.Progress != nil {
				info.Indexing.Done += st.Progress.Done
				info.Indexing.Total += st.Progress.Total
			}
		}
	}
	hits, err := s.store.search(ctx, usable, search.Terms(query), limit*2)
	if err != nil {
		return nil, info, err
	}
	// The same file through two overlapping folders is one result.
	seen := map[string]bool{}
	out := hits[:0]
	for _, h := range hits {
		// A file may have gone or been replaced by a link since the last scan. Never return stale passages for
		// a path that now escapes the folder (and never offer an unsafe citation).
		file, err := openLocalFile(h.Folder, filepath.FromSlash(h.Rel))
		if err != nil {
			continue
		}
		file.Close()
		key := fmt.Sprintf("%s\x00%d", h.Path, h.Ord)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, h)
		if len(out) == limit {
			break
		}
	}
	return out, info, nil
}
