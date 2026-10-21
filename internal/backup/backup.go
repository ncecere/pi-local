// Package backup makes, lists, deletes and restores backups of the data folder, and runs the daily automatic one.
//
// A backup is one zip: app.db (VACUUM INTO, so it is whole and compact), templates/, and every agent's folder
// (agent.yaml, memory.json, its conversations in state.sqlite, and its own workspace/). Logs and temporary files are
// left out. Secrets are never in it: they live in the OS keychain, which isn't copied; the manifest lists which
// providers and MCP servers will need their keys again on another computer.
//
// An awake agent's runtime holds its state.sqlite open exclusively (SQLite locking_mode=EXCLUSIVE), so nothing else
// can read it. The simplest correct way is to put the agent to sleep for the copy: the supervisor stops its runtime
// (work in flight stays pending in storage), the file is copied with VACUUM INTO, and the agent wakes again. Only
// that copy happens with the agent asleep; the zip is written afterwards, from the copies.
//
// Restoring needs the app to restart: the request is recorded in restore-pending.json and applied at the next start,
// before app.db is opened (restore.go).
package backup

import (
	"archive/zip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Reason says why a backup was made.
type Reason string

const (
	Manual       Reason = "manual"
	Automatic    Reason = "automatic"
	BeforeUpdate Reason = "before-update"
)

// ManifestFormat is the manifest's version.
const ManifestFormat = 1

const (
	// KeepAutomatic is how many automatic backups are kept. Manual backups are never deleted by the app.
	KeepAutomatic = 7
	// KeepBeforeUpdate is how many backups made before an update are kept.
	KeepBeforeUpdate = 3
)

var (
	// ErrBusy: a backup or a restore is already under way.
	ErrBusy = errors.New("another backup or restore is under way")
	// ErrNotFound: no backup has that ID.
	ErrNotFound = errors.New("backup not found")
)

// idPattern is a backup's ID, its file name without .zip.
var idPattern = regexp.MustCompile(`^pi-local-[A-Za-z0-9-]{1,60}$`)

// ValidID reports whether id can name a backup.
func ValidID(id string) bool { return idPattern.MatchString(id) }

// KeyNeed is a provider or MCP server whose secrets aren't in a backup. Items name them; values are never stored.
type KeyNeed struct {
	Kind  string   `json:"kind"` // provider, mcp, web-search, judgments
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Items []string `json:"items"`
}

// ManifestAgent is an agent in a backup.
type ManifestAgent struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Conversations  bool   `json:"conversations"`
	WorkspaceFiles int    `json:"workspaceFiles"`
	WorkspaceBytes int64  `json:"workspaceBytes"`
	// ProjectFolder is a folder outside the data folder the agent works in: not part of a backup.
	ProjectFolder string `json:"projectFolder,omitempty"`
}

// Manifest is manifest.json in a backup.
type Manifest struct {
	Format    int             `json:"format"`
	App       string          `json:"app"`
	Version   string          `json:"version"`
	CreatedAt int64           `json:"createdAt"` // Unix ms
	Reason    Reason          `json:"reason"`
	Agents    []ManifestAgent `json:"agents"`
	Files     int             `json:"files"`
	Bytes     int64           `json:"bytes"` // before compression
	NeedsKeys []KeyNeed       `json:"needsKeys"`
	Warnings  []string        `json:"warnings"`
	Note      string          `json:"note"`
}

// Info is a backup as listed.
type Info struct {
	ID             string    `json:"id"`
	File           string    `json:"file"`
	Path           string    `json:"path"`
	CreatedAt      int64     `json:"createdAt"`
	Size           int64     `json:"size"` // the zip's size on disk
	Bytes          int64     `json:"bytes"`
	Reason         Reason    `json:"reason"`
	Version        string    `json:"version"`
	Agents         int       `json:"agents"`
	WorkspaceBytes int64     `json:"workspaceBytes"`
	NeedsKeys      []KeyNeed `json:"needsKeys"`
	Warnings       []string  `json:"warnings"`
	// Readable is false for a file that isn't a backup this version can open (it can't be restored).
	Readable bool `json:"readable"`
}

// AgentInfo is what a backup needs to know of an agent.
type AgentInfo struct {
	ID, Name, Dir string
	// ProjectFolder is the agent's project folder outside its own, "" for none.
	ProjectFolder string
}

// Config wires a Service to the app.
type Config struct {
	DataDir string
	DB      *sql.DB
	Version string
	Agents  func() []AgentInfo
	// Quiesce stops an agent's runtime while fn runs (supervisor.Quiesce); it says whether it was awake.
	Quiesce func(id string, fn func() error) (bool, error)
	// Wake starts an agent's runtime again.
	Wake func(ctx context.Context, id string) error
	// Keys lists what needs entering again after a restore on another computer.
	Keys func(ctx context.Context) []KeyNeed
	// Busy reports whether any agent is in the middle of a reply (an automatic backup waits for a quiet moment).
	Busy func(ctx context.Context) bool
	// OnChange is called after the backups, the settings or a pending restore change.
	OnChange func()

	Now        func() time.Time
	FirstDelay time.Duration // the first automatic check after Start (default 2 minutes)
	Every      time.Duration // how often it looks whether one is due (default 15 minutes)
}

// Service makes and manages backups.
type Service struct {
	cfg Config
	mu  sync.Mutex // one backup or restore at a time

	stateMu   sync.Mutex
	running   bool
	autoError string

	started bool
	stop    chan struct{}
	done    chan struct{}
}

// New makes a service. Start begins the daily backups.
func New(cfg Config) *Service {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.FirstDelay == 0 {
		cfg.FirstDelay = 2 * time.Minute
	}
	if cfg.Every == 0 {
		cfg.Every = 15 * time.Minute
	}
	if cfg.OnChange == nil {
		cfg.OnChange = func() {}
	}
	if cfg.Keys == nil {
		cfg.Keys = func(context.Context) []KeyNeed { return nil }
	}
	return &Service{cfg: cfg, stop: make(chan struct{}), done: make(chan struct{})}
}

// Dir is where backups are kept: <data>/backups.
func (s *Service) Dir() string { return filepath.Join(s.cfg.DataDir, "backups") }

// Auto reports whether the daily automatic backup is on (the default).
func (s *Service) Auto() bool {
	var v string
	if s.cfg.DB != nil {
		s.cfg.DB.QueryRow(`SELECT value FROM settings WHERE key = 'backup_auto'`).Scan(&v)
	}
	return v != "off"
}

// SetAuto turns the daily automatic backup on or off.
func (s *Service) SetAuto(on bool) error {
	v := "on"
	if !on {
		v = "off"
	}
	_, err := s.cfg.DB.Exec(`INSERT INTO settings (key, value) VALUES ('backup_auto', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, v)
	if err == nil {
		s.cfg.OnChange()
	}
	return err
}

// Status is what the UI shows besides the list.
type Status struct {
	Running   bool   `json:"running"`
	AutoError string `json:"autoError"`
}

// Status is whether a backup is under way and why the last automatic one failed ("" if it didn't).
func (s *Service) Status() Status {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return Status{Running: s.running, AutoError: s.autoError}
}

func (s *Service) setRunning(on bool) {
	s.stateMu.Lock()
	s.running = on
	s.stateMu.Unlock()
}

// Start begins the daily automatic backup: a first look a couple of minutes after the app starts, then every 15
// minutes. A backup is made when automatic backups are on and the newest one is more than a day old. It waits for a
// quiet moment (no agent in the middle of a reply) for up to 12 hours.
func (s *Service) Start() {
	s.cleanup()
	s.stateMu.Lock()
	s.started = true
	s.stateMu.Unlock()
	go func() {
		defer close(s.done)
		timer := time.NewTimer(s.cfg.FirstDelay)
		defer timer.Stop()
		for {
			select {
			case <-s.stop:
				return
			case <-timer.C:
			}
			s.tick(context.Background())
			timer.Reset(s.cfg.Every)
		}
	}()
}

// Close stops the automatic backups (a backup under way finishes first).
func (s *Service) Close() {
	select {
	case <-s.stop:
		return
	default:
	}
	close(s.stop)
	s.stateMu.Lock()
	started := s.started
	s.stateMu.Unlock()
	if !started {
		return
	}
	select {
	case <-s.done:
	case <-time.After(2 * time.Second):
	}
}

const (
	autoEvery   = 24 * time.Hour
	autoPatient = 12 * time.Hour
)

// tick makes the automatic backup when it is due.
func (s *Service) tick(ctx context.Context) {
	if !s.Auto() {
		return
	}
	list, err := s.List()
	if err != nil {
		return
	}
	var newest int64
	for _, b := range list {
		newest = max(newest, b.CreatedAt)
	}
	age := s.cfg.Now().Sub(time.UnixMilli(newest))
	if newest != 0 && age < autoEvery {
		return
	}
	if newest != 0 && age < autoEvery+autoPatient && s.cfg.Busy != nil && s.cfg.Busy(ctx) {
		return // an agent is mid-reply: try again later rather than interrupt it
	}
	if _, err := s.Create(ctx, Automatic, ""); err != nil {
		if errors.Is(err, ErrBusy) {
			return
		}
		slog.Warn("the automatic backup failed", "err", err)
		s.stateMu.Lock()
		s.autoError = err.Error()
		s.stateMu.Unlock()
		s.cfg.OnChange()
		return
	}
	s.stateMu.Lock()
	s.autoError = ""
	s.stateMu.Unlock()
}

// cleanup removes what a backup that was interrupted left behind.
func (s *Service) cleanup() {
	entries, err := os.ReadDir(s.Dir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".work-") || strings.HasSuffix(e.Name(), ".partial") {
			os.RemoveAll(filepath.Join(s.Dir(), e.Name()))
		}
	}
}

// --- listing --------------------------------------------------------------------------------------------------

// List is the backups in the backup folder, newest first.
func (s *Service) List() ([]Info, error) {
	entries, err := os.ReadDir(s.Dir())
	if errors.Is(err, os.ErrNotExist) {
		return []Info{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []Info{}
	for _, e := range entries {
		id, isZip := strings.CutSuffix(e.Name(), ".zip")
		if e.IsDir() || !isZip || !ValidID(id) {
			continue
		}
		out = append(out, describe(filepath.Join(s.Dir(), e.Name())))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}

// describe reads a backup file's manifest.
func describe(path string) Info {
	file := filepath.Base(path)
	info := Info{ID: strings.TrimSuffix(file, ".zip"), File: file, Path: path, NeedsKeys: []KeyNeed{}, Warnings: []string{}, Reason: Manual}
	if st, err := os.Stat(path); err == nil {
		info.Size = st.Size()
		info.CreatedAt = st.ModTime().UnixMilli()
	}
	m, err := ReadManifest(path)
	if err != nil {
		info.Warnings = []string{"This file couldn't be read as a Pi Local backup."}
		return info
	}
	info.Readable = true
	info.CreatedAt, info.Reason, info.Version = m.CreatedAt, m.Reason, m.Version
	info.Agents, info.Bytes = len(m.Agents), m.Bytes
	for _, a := range m.Agents {
		info.WorkspaceBytes += a.WorkspaceBytes
	}
	if m.NeedsKeys != nil {
		info.NeedsKeys = m.NeedsKeys
	}
	if m.Warnings != nil {
		info.Warnings = m.Warnings
	}
	return info
}

// ReadManifest reads manifest.json from a backup, and checks it holds app.db.
func ReadManifest(path string) (*Manifest, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	var m *Manifest
	hasDB := false
	for _, f := range zr.File {
		switch f.Name {
		case "app.db":
			hasDB = true
		case "manifest.json":
			if f.UncompressedSize64 > 4<<20 {
				return nil, errors.New("manifest.json is too large")
			}
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			var decoded Manifest
			err = json.NewDecoder(io.LimitReader(rc, 4<<20)).Decode(&decoded)
			rc.Close()
			if err != nil {
				return nil, err
			}
			m = &decoded
		}
	}
	switch {
	case m == nil || m.App != "Pi Local":
		return nil, errors.New("not a Pi Local backup")
	case m.Format > ManifestFormat:
		return nil, fmt.Errorf("made by a newer Pi Local (backup format %d)", m.Format)
	case !hasDB:
		return nil, errors.New("the backup has no app.db")
	}
	return m, nil
}

// Path is a backup's file in the backup folder.
func (s *Service) Path(id string) (string, error) {
	if !ValidID(id) {
		return "", ErrNotFound
	}
	path := filepath.Join(s.Dir(), id+".zip")
	if st, err := os.Stat(path); err != nil || st.IsDir() {
		return "", ErrNotFound
	}
	return path, nil
}

// Delete removes a backup.
func (s *Service) Delete(id string) error {
	path, err := s.Path(id)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	s.cfg.OnChange()
	return nil
}

// prune deletes automatic backups beyond the newest KeepAutomatic, and those made before an update beyond the newest
// KeepBeforeUpdate. Manual backups are the person's: never deleted here.
func (s *Service) prune() {
	list, err := s.List()
	if err != nil {
		return
	}
	kept := map[Reason]int{}
	limit := map[Reason]int{Automatic: KeepAutomatic, BeforeUpdate: KeepBeforeUpdate}
	for _, b := range list { // newest first
		keep, limited := limit[b.Reason]
		if !limited || !b.Readable {
			continue
		}
		kept[b.Reason]++
		if kept[b.Reason] > keep {
			if err := os.Remove(b.Path); err != nil {
				slog.Warn("deleting an old backup", "file", b.File, "err", err)
			}
		}
	}
}

// --- making ---------------------------------------------------------------------------------------------------

// stats counts what goes into a zip.
type stats struct {
	files   int
	bytes   int64
	skipped int
	failed  []string
}

// Create makes a backup now. folder is where to put it: "" is the backup folder (<data>/backups), where it is
// listed and the keeping rules apply; any other folder must exist.
func (s *Service) Create(ctx context.Context, reason Reason, folder string) (*Info, error) {
	if !s.mu.TryLock() {
		return nil, ErrBusy
	}
	defer s.mu.Unlock()
	s.setRunning(true)
	s.cfg.OnChange()
	defer func() {
		s.setRunning(false)
		s.cfg.OnChange()
	}()

	dest := s.Dir()
	if folder != "" {
		if st, err := os.Stat(folder); err != nil || !st.IsDir() {
			return nil, errors.New("that folder doesn't exist")
		}
		dest = folder
	}
	if err := os.MkdirAll(s.Dir(), 0o700); err != nil {
		return nil, err
	}
	work, err := os.MkdirTemp(s.Dir(), ".work-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)

	now := s.cfg.Now()
	var warnings []string
	if err := vacuumInto(ctx, s.cfg.DB, filepath.Join(work, "app.db")); err != nil {
		return nil, fmt.Errorf("copying app.db: %w", err)
	}

	// Each agent's conversations, copied while it sleeps (briefly), then it wakes again.
	agentList := s.cfg.Agents()
	staged := map[string]bool{}
	for _, ag := range agentList {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		src := filepath.Join(ag.Dir, "state.sqlite")
		if _, err := os.Stat(src); err != nil {
			continue // never woken: no conversations yet
		}
		dst := filepath.Join(work, ag.ID+".sqlite")
		copyState := func() error { return copyStorage(ctx, src, dst) }
		var wasAwake bool
		var qerr error
		if s.cfg.Quiesce != nil {
			wasAwake, qerr = s.cfg.Quiesce(ag.ID, copyState)
		} else {
			qerr = copyState()
		}
		if wasAwake && s.cfg.Wake != nil {
			if err := s.cfg.Wake(ctx, ag.ID); err != nil {
				slog.Warn("waking an agent after its backup", "agent", ag.ID, "err", err)
			}
		}
		if qerr != nil {
			warnings = append(warnings, fmt.Sprintf("%s: its conversations couldn't be copied (%v)", ag.Name, qerr))
			continue
		}
		staged[ag.ID] = true
	}

	name := fileName(now, reason)
	final := uniquePath(dest, name)
	partial := final + ".partial"
	f, err := os.OpenFile(partial, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("writing the backup: %w", err)
	}
	ok := false
	defer func() {
		if !ok {
			f.Close()
			os.Remove(partial)
		}
	}()
	zw := zip.NewWriter(f)
	st := &stats{}
	if err := addFile(zw, "app.db", filepath.Join(work, "app.db"), st); err != nil {
		return nil, diskError(err)
	}
	if err := addTree(zw, "templates", filepath.Join(s.cfg.DataDir, "templates"), nil, st, nil); err != nil {
		return nil, diskError(err)
	}
	manifest := Manifest{Format: ManifestFormat, App: "Pi Local", Version: s.cfg.Version, CreatedAt: now.UnixMilli(), Reason: reason,
		Agents: []ManifestAgent{}, NeedsKeys: s.cfg.Keys(ctx),
		Note: "Secrets (provider keys, MCP variable and header values, sign-ins) are in the system keychain and are not in this backup."}
	if manifest.NeedsKeys == nil {
		manifest.NeedsKeys = []KeyNeed{}
	}
	for _, ag := range agentList {
		root := "agents/" + ag.ID
		ma := ManifestAgent{ID: ag.ID, Name: ag.Name, Conversations: staged[ag.ID], ProjectFolder: ag.ProjectFolder}
		if staged[ag.ID] {
			if err := addFile(zw, root+"/state.sqlite", filepath.Join(work, ag.ID+".sqlite"), st); err != nil {
				return nil, diskError(err)
			}
			// Only a copy made by hand (SQLite couldn't) has a log beside it.
			if _, err := os.Stat(filepath.Join(work, ag.ID+".sqlite-wal")); err == nil {
				if err := addFile(zw, root+"/state.sqlite-wal", filepath.Join(work, ag.ID+".sqlite-wal"), st); err != nil {
					return nil, diskError(err)
				}
			}
		}
		err := addTree(zw, root, ag.Dir, agentSkip, st, func(rel string, size int64) {
			if strings.HasPrefix(rel, "workspace/") {
				ma.WorkspaceFiles++
				ma.WorkspaceBytes += size
			}
		})
		if err != nil {
			return nil, diskError(err)
		}
		manifest.Agents = append(manifest.Agents, ma)
	}
	if st.skipped > 0 {
		warnings = append(warnings, fmt.Sprintf("%d symbolic links or special files weren't included.", st.skipped))
	}
	for _, p := range st.failed {
		warnings = append(warnings, "Couldn't read "+p+".")
	}
	manifest.Warnings = warnings
	manifest.Files, manifest.Bytes = st.files, st.bytes
	if manifest.Warnings == nil {
		manifest.Warnings = []string{}
	}
	raw, _ := json.MarshalIndent(manifest, "", "  ")
	mw, err := zw.CreateHeader(&zip.FileHeader{Name: "manifest.json", Method: zip.Deflate, Modified: now})
	if err != nil {
		return nil, diskError(err)
	}
	if _, err := mw.Write(raw); err != nil {
		return nil, diskError(err)
	}
	if err := zw.Close(); err != nil {
		return nil, diskError(err)
	}
	if err := f.Sync(); err != nil {
		return nil, diskError(err)
	}
	if err := f.Close(); err != nil {
		return nil, diskError(err)
	}
	if err := os.Rename(partial, final); err != nil {
		return nil, err
	}
	ok = true
	if folder == "" {
		s.prune()
	}
	info := describe(final)
	return &info, nil
}

func fileName(t time.Time, reason Reason) string {
	name := "pi-local-" + t.Format("2006-01-02-150405")
	switch reason {
	case Automatic:
		name += "-auto"
	case BeforeUpdate:
		name += "-before-update"
	}
	return name
}

// uniquePath is dir/name.zip, or name-2.zip and so on when it is taken.
func uniquePath(dir, name string) string {
	path := filepath.Join(dir, name+".zip")
	for i := 2; ; i++ {
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			return path
		}
		path = filepath.Join(dir, fmt.Sprintf("%s-%d.zip", name, i))
	}
}

// diskError makes a full disk say so.
func diskError(err error) error {
	if strings.Contains(err.Error(), "no space left") {
		return errors.New("There isn't enough free space on this disk for the backup.")
	}
	return fmt.Errorf("writing the backup: %w", err)
}

// agentSkip leaves out an agent's logs and temporary files (but not the attachments in tmp/), and its storage, which
// is copied separately.
func agentSkip(rel string, d fs.DirEntry) bool {
	top, _, _ := strings.Cut(rel, "/")
	switch {
	case top == "logs":
		return true
	case top == "tmp":
		return rel != "tmp" && rel != "tmp/attachments" && !strings.HasPrefix(rel, "tmp/attachments/")
	case strings.HasPrefix(rel, "state.sqlite"), strings.HasPrefix(rel, ".agent.yaml."):
		return rel == top
	}
	return false
}

// addFile adds one file to the zip as name.
func addFile(zw *zip.Writer, name, path string, st *stats) error {
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	return addReader(zw, name, in, info, st)
}

func addReader(zw *zip.Writer, name string, in io.Reader, info fs.FileInfo, st *stats) error {
	hdr, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	hdr.Name, hdr.Method = name, zip.Deflate
	w, err := zw.CreateHeader(hdr)
	if err != nil {
		return err
	}
	n, err := io.Copy(w, in)
	st.files++
	st.bytes += n
	return err
}

// addTree adds a folder's regular files under zipRoot. Symbolic links and special files are counted, not followed. A
// file that can't be read is noted and skipped. A missing folder is nothing. skip says which entries to leave out
// (by path relative to root); seen is told each file added.
func addTree(zw *zip.Writer, zipRoot, root string, skip func(rel string, d fs.DirEntry) bool, st *stats, seen func(rel string, size int64)) error {
	if _, err := os.Lstat(root); err != nil {
		return nil
	}
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if err != nil {
			if rel == "." {
				return nil
			}
			st.failed = append(st.failed, zipRoot+"/"+rel)
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if rel == "." {
			return nil
		}
		if skip != nil && skip(rel, d) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		switch {
		case d.IsDir():
			if info, err := d.Info(); err == nil {
				hdr, err := zip.FileInfoHeader(info)
				if err == nil {
					hdr.Name = zipRoot + "/" + rel + "/"
					_, err = zw.CreateHeader(hdr)
				}
				return err
			}
			return nil
		case !d.Type().IsRegular():
			st.skipped++
			return nil
		}
		in, err := os.Open(path)
		if err != nil {
			st.failed = append(st.failed, zipRoot+"/"+rel)
			return nil
		}
		defer in.Close()
		info, err := in.Stat()
		if err != nil {
			st.failed = append(st.failed, zipRoot+"/"+rel)
			return nil
		}
		if err := addReader(zw, zipRoot+"/"+rel, in, info, st); err != nil {
			return err
		}
		if seen != nil {
			seen(rel, info.Size())
		}
		return nil
	})
}

// --- SQLite copies --------------------------------------------------------------------------------------------

func quoteSQL(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// vacuumInto writes a whole, compact copy of a database to a new file.
func vacuumInto(ctx context.Context, db *sql.DB, dst string) error {
	_, err := db.ExecContext(ctx, "VACUUM INTO "+quoteSQL(dst))
	return err
}

// copyStorage copies an agent's state.sqlite (not open by any runtime) with VACUUM INTO, which also folds in its
// write-ahead log. If SQLite can't (a damaged file), the file and its log are copied as they are.
func copyStorage(ctx context.Context, src, dst string) error {
	u := url.URL{Scheme: "file", Path: src, RawQuery: "_pragma=busy_timeout(5000)"}
	db, err := sql.Open("sqlite", u.String())
	if err == nil {
		db.SetMaxOpenConns(1)
		err = vacuumInto(ctx, db, dst)
		db.Close()
	}
	if err == nil {
		return nil
	}
	slog.Warn("copying an agent's storage with SQLite failed; copying the file", "src", src, "err", err)
	os.Remove(dst)
	if cerr := copyFile(src, dst); cerr != nil {
		return cerr
	}
	// The log has what the file doesn't yet: keep it beside the copy so the pair opens together.
	if _, serr := os.Stat(src + "-wal"); serr == nil {
		return copyFile(src+"-wal", dst+"-wal")
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// String is the reason as the API says it.
func (r Reason) String() string { return string(r) }
