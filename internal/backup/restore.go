package backup

import (
	"archive/zip"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Restoring replaces the data (app.db, agents/, templates/, skills/, prompts/) with a backup's. The app holds app.db open and runs the
// agents, so it happens at the next start, before app.db is opened:
//
//  1. PrepareRestore (in the running app) checks the backup and writes <data>/restore-pending.json.
//  2. The app quits (the desktop app relaunches itself); every agent stops gracefully.
//  3. ApplyPending (first thing in app.New, with the data folder locked) unpacks the backup into
//     <data>/restore-staging, checks it, moves the current data aside to <data>/before-restore-<date>, and moves the
//     unpacked data in. It writes <data>/last-restore.json for the UI.
//
// Nothing of the current data is touched until the backup has been unpacked and checked. The steps after that are
// repeatable: if the app dies in the middle, the next start carries on.

const (
	markerFile      = "restore-pending.json"
	lastRestoreFile = "last-restore.json"
	stagingDir      = "restore-staging"
	completeFile    = ".complete"
)

// restoredItems are what a restore replaces, in the data folder.
var restoredItems = []string{"app.db", "agents", "templates", "skills", "prompts"}

// Pending is a restore waiting for the next start.
type Pending struct {
	// Backup is the file to restore, an absolute path.
	Backup      string `json:"backup"`
	ID          string `json:"id"`
	RequestedAt int64  `json:"requestedAt"`
	// Phase is "pending", then "applying" once the backup is unpacked and checked.
	Phase   string `json:"phase"`
	MovedTo string `json:"movedTo,omitempty"`
}

// RestoreResult is how the last restore went.
type RestoreResult struct {
	OK      bool   `json:"ok"`
	At      int64  `json:"at"`
	ID      string `json:"id"`
	MovedTo string `json:"movedTo,omitempty"`
	Error   string `json:"error,omitempty"`
}

func writeJSONFile(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// PendingRestore is the restore waiting for the next start, or nil.
func PendingRestore(dataDir string) *Pending {
	raw, err := os.ReadFile(filepath.Join(dataDir, markerFile))
	if err != nil {
		return nil
	}
	var p Pending
	if json.Unmarshal(raw, &p) != nil || p.Backup == "" {
		return nil
	}
	return &p
}

// LastRestore is how the last restore went, or nil.
func LastRestore(dataDir string) *RestoreResult {
	raw, err := os.ReadFile(filepath.Join(dataDir, lastRestoreFile))
	if err != nil {
		return nil
	}
	var r RestoreResult
	if json.Unmarshal(raw, &r) != nil {
		return nil
	}
	return &r
}

// Pending is the restore waiting for the next start, or nil.
func (s *Service) Pending() *Pending { return PendingRestore(s.cfg.DataDir) }

// LastRestore is how the last restore went, or nil.
func (s *Service) LastRestore() *RestoreResult { return LastRestore(s.cfg.DataDir) }

// PrepareRestore checks a backup and records that it is to be restored at the next start. The caller then restarts
// the app. It changes no data.
func (s *Service) PrepareRestore(id string) (*Pending, error) {
	if !s.mu.TryLock() {
		return nil, ErrBusy
	}
	defer s.mu.Unlock()
	file, err := s.Path(id)
	if err != nil {
		return nil, err
	}
	if _, err := ReadManifest(file); err != nil {
		return nil, fmt.Errorf("This backup can't be restored: %w.", err)
	}
	p := &Pending{Backup: file, ID: id, RequestedAt: s.cfg.Now().UnixMilli(), Phase: "pending"}
	if err := writeJSONFile(filepath.Join(s.cfg.DataDir, markerFile), p); err != nil {
		return nil, err
	}
	s.cfg.OnChange()
	return p, nil
}

// CancelRestore forgets a restore that hasn't happened yet.
func (s *Service) CancelRestore() error {
	p := s.Pending()
	if p == nil {
		return nil
	}
	if p.Phase == "applying" {
		return errors.New("the restore has already begun")
	}
	if err := os.Remove(filepath.Join(s.cfg.DataDir, markerFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	s.cfg.OnChange()
	return nil
}

// ApplyPending carries out a pending restore. Call it before app.db is opened, with the data folder locked. It
// answers nil when nothing is pending. A restore that fails before touching the data is reported in the result (the
// data is as it was); an error means the data may be half moved, and the next start tries again.
func ApplyPending(dataDir string, now time.Time) (*RestoreResult, error) {
	p := PendingRestore(dataDir)
	if p == nil {
		return nil, nil
	}
	marker := filepath.Join(dataDir, markerFile)
	staging := filepath.Join(dataDir, stagingDir)
	result := &RestoreResult{At: now.UnixMilli(), ID: p.ID}
	finish := func(r *RestoreResult) (*RestoreResult, error) {
		writeJSONFile(filepath.Join(dataDir, lastRestoreFile), r)
		os.Remove(marker)
		os.RemoveAll(staging)
		return r, nil
	}

	if p.Phase != "applying" {
		os.RemoveAll(staging)
		if err := unpack(p.Backup, staging); err != nil {
			result.Error = "The backup couldn't be unpacked, so nothing was changed: " + err.Error()
			return finish(result)
		}
		if err := checkStaged(staging); err != nil {
			result.Error = "The backup didn't pass its checks, so nothing was changed: " + err.Error()
			return finish(result)
		}
		p.Phase, p.MovedTo = "applying", freeName(dataDir, "before-restore-"+now.Format("2006-01-02"))
		if err := os.MkdirAll(filepath.Join(dataDir, p.MovedTo), 0o700); err != nil {
			result.Error = "Couldn't make the folder for the current data, so nothing was changed: " + err.Error()
			return finish(result)
		}
		if err := writeJSONFile(marker, p); err != nil {
			os.RemoveAll(filepath.Join(dataDir, p.MovedTo))
			result.Error = "Couldn't record the restore, so nothing was changed: " + err.Error()
			return finish(result)
		}
	} else if _, err := os.Stat(filepath.Join(staging, completeFile)); err != nil {
		return nil, fmt.Errorf("a restore was interrupted and its unpacked data is gone: your previous data is in %s", filepath.Join(dataDir, p.MovedTo))
	}

	aside := filepath.Join(dataDir, p.MovedTo)
	for _, name := range restoredItems {
		src := filepath.Join(staging, name)
		if _, err := os.Lstat(src); err != nil {
			continue // already moved in
		}
		if name == "app.db" {
			for _, suffix := range []string{"-wal", "-shm"} {
				if err := moveIfExists(filepath.Join(dataDir, name+suffix), filepath.Join(aside, name+suffix)); err != nil {
					return nil, fmt.Errorf("moving the current data aside: %w", err)
				}
			}
		}
		if err := moveIfExists(filepath.Join(dataDir, name), filepath.Join(aside, name)); err != nil {
			return nil, fmt.Errorf("moving the current data aside: %w", err)
		}
		if err := os.Rename(src, filepath.Join(dataDir, name)); err != nil {
			return nil, fmt.Errorf("putting the restored %s in place (your previous data is in %s): %w", name, aside, err)
		}
	}
	result.OK, result.MovedTo = true, p.MovedTo
	return finish(result)
}

func moveIfExists(from, to string) error {
	if _, err := os.Lstat(from); err != nil {
		return nil
	}
	return os.Rename(from, to)
}

// freeName is name, or name-2 and so on, whichever doesn't exist in dir.
func freeName(dir, name string) string {
	candidate := name
	for i := 2; ; i++ {
		if _, err := os.Lstat(filepath.Join(dir, candidate)); errors.Is(err, os.ErrNotExist) {
			return candidate
		}
		candidate = fmt.Sprintf("%s-%d", name, i)
	}
}

// allowed maps an entry's name in the zip to its place in the staging folder, and refuses anything that isn't
// app.db, templates/… or agents/<id>/… (and any name that could leave the folder).
func allowed(name string) (string, bool) {
	if name == "" || strings.ContainsAny(name, "\\\x00") || strings.HasPrefix(name, "/") {
		return "", false
	}
	clean := path.Clean(strings.TrimSuffix(name, "/"))
	if clean != strings.TrimSuffix(name, "/") || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	parts := strings.Split(clean, "/")
	switch parts[0] {
	case "app.db":
		return clean, len(parts) == 1
	case "templates", "skills", "prompts":
		return clean, true
	case "agents":
		if len(parts) < 2 || !validAgentID(parts[1]) {
			return "", false
		}
		return clean, true
	}
	return "", false
}

// validAgentID mirrors agents.ValidID without importing the package (this one runs before anything else is open).
func validAgentID(id string) bool {
	if len(id) != 19 || !strings.HasPrefix(id, "ag_") {
		return false
	}
	for _, c := range id[3:] {
		if !(c >= 'a' && c <= 'z' || c >= '2' && c <= '7') {
			return false
		}
	}
	return true
}

// unpack extracts a backup into dir (new). Only regular files and folders are made, so nothing in a backup can
// point out of the folder.
func unpack(zipPath, dir string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for _, f := range zr.File {
		if f.Name == "manifest.json" {
			continue
		}
		rel, ok := allowed(f.Name)
		if !ok {
			return fmt.Errorf("the backup holds an unexpected file (%q)", f.Name)
		}
		target := filepath.Join(dir, filepath.FromSlash(rel))
		mode := f.Mode()
		switch {
		case mode.IsDir() || strings.HasSuffix(f.Name, "/"):
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			continue
		case !mode.IsRegular():
			continue // links and special files are never restored
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if err := extract(f, target, mode.Perm()|0o600); err != nil {
			return fmt.Errorf("%s: %w", f.Name, err)
		}
	}
	return nil
}

func extract(f *zip.File, target string, perm fs.FileMode) error {
	in, err := f.Open()
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil { // the zip reader checks the CRC at the end
		out.Close()
		return err
	}
	return out.Close()
}

// checkStaged makes sure the unpacked data can be used, and fills in what a backup leaves out.
func checkStaged(dir string) error {
	dbPath := filepath.Join(dir, "app.db")
	if _, err := os.Stat(dbPath); err != nil {
		return errors.New("it has no app.db")
	}
	u := url.URL{Scheme: "file", Path: dbPath, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return err
	}
	var verdict string
	err = db.QueryRow(`PRAGMA quick_check`).Scan(&verdict)
	db.Close()
	if err != nil || verdict != "ok" {
		return errors.New("its app.db is damaged")
	}
	for _, sub := range []string{"agents", "templates", "skills", "prompts"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o700); err != nil {
			return err
		}
	}
	entries, err := os.ReadDir(filepath.Join(dir, "agents"))
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		for _, sub := range []string{"workspace", "tmp", "logs"} {
			if err := os.MkdirAll(filepath.Join(dir, "agents", e.Name(), sub), 0o700); err != nil {
				return err
			}
		}
	}
	return os.WriteFile(filepath.Join(dir, completeFile), nil, 0o600)
}
