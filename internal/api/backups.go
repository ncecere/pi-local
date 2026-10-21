package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/ncecere/pi-local/internal/backup"
	"github.com/ncecere/pi-local/internal/diagnostics"
)

func (a *API) backupRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/backups", a.listBackups)
	m.HandleFunc("POST /api/backups", a.createBackup)
	m.HandleFunc("PUT /api/backups/settings", a.putBackupSettings)
	m.HandleFunc("DELETE /api/backups/pending-restore", a.cancelRestore)
	m.HandleFunc("POST /api/backups/{id}/reveal", a.revealBackup)
	m.HandleFunc("POST /api/backups/{id}/restore", a.restoreBackup)
	m.HandleFunc("DELETE /api/backups/{id}", a.deleteBackup)
	m.HandleFunc("GET /api/diagnostics", a.downloadDiagnostics)
	m.HandleFunc("POST /api/diagnostics", a.saveDiagnostics)
}

// lastRestore is how the last restore went; movedTo is its full path here.
type lastRestore struct {
	OK      bool   `json:"ok"`
	At      int64  `json:"at"`
	ID      string `json:"id"`
	MovedTo string `json:"movedTo"`
	Error   string `json:"error"`
}

func (a *API) backupList() (map[string]any, error) {
	list, err := a.Backups.List()
	if err != nil {
		return nil, err
	}
	status := a.Backups.Status()
	out := map[string]any{
		"backups":     list,
		"folder":      a.Backups.Dir(),
		"auto":        a.Backups.Auto(),
		"keep":        backup.KeepAutomatic,
		"running":     status.Running,
		"autoError":   status.AutoError,
		"pending":     a.Backups.Pending(),
		"canRestart":  a.Restart != nil,
		"lastRestore": nil,
	}
	if r := a.Backups.LastRestore(); r != nil {
		moved := ""
		if r.MovedTo != "" {
			moved = filepath.Join(filepath.Dir(a.Backups.Dir()), r.MovedTo)
		}
		out["lastRestore"] = lastRestore{OK: r.OK, At: r.At, ID: r.ID, MovedTo: moved, Error: r.Error}
	}
	return out, nil
}

func (a *API) listBackups(w http.ResponseWriter, r *http.Request) {
	out, err := a.backupList()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "The backups couldn't be listed.")
		return
	}
	ok(w, out)
}

func backupFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, backup.ErrNotFound):
		fail(w, http.StatusNotFound, "not_found", "Backup not found")
	case errors.Is(err, backup.ErrBusy):
		fail(w, http.StatusConflict, "backup_running", "A backup or restore is already under way. Try again in a moment.")
	default:
		fail(w, http.StatusInternalServerError, "backup_failed", err.Error())
	}
}

func (a *API) createBackup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Folder string `json:"folder"`
	}
	if r.ContentLength != 0 && !decodeBody(w, r, &in) {
		return
	}
	if in.Folder != "" {
		if !filepath.IsAbs(in.Folder) {
			fail(w, http.StatusBadRequest, "invalid_folder", "Choose a folder by its full path.")
			return
		}
		if st, err := os.Stat(in.Folder); err != nil || !st.IsDir() {
			fail(w, http.StatusBadRequest, "invalid_folder", "That folder doesn't exist.")
			return
		}
	}
	// A backup finishes even if the window that asked for it goes away.
	info, err := a.Backups.Create(context.WithoutCancel(r.Context()), backup.Manual, in.Folder)
	if err != nil {
		slog.Warn("a backup failed", "err", err)
		backupFailure(w, err)
		return
	}
	created(w, info)
}

func (a *API) putBackupSettings(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Auto *bool `json:"auto"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if in.Auto != nil {
		if err := a.Backups.SetAuto(*in.Auto); err != nil {
			fail(w, http.StatusInternalServerError, "internal", "The setting couldn't be saved.")
			return
		}
	}
	a.listBackups(w, r)
}

func (a *API) deleteBackup(w http.ResponseWriter, r *http.Request) {
	if err := a.Backups.Delete(r.PathValue("id")); err != nil {
		backupFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

func (a *API) revealBackup(w http.ResponseWriter, r *http.Request) {
	path, err := a.Backups.Path(r.PathValue("id"))
	if err != nil {
		backupFailure(w, err)
		return
	}
	if err := a.Manager.RevealFile(path); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "The folder couldn't be opened.")
		return
	}
	ok(w, map[string]bool{"ok": true})
}

// restoreBackup records the restore and restarts the app, which applies it as it starts.
func (a *API) restoreBackup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Confirm string `json:"confirm"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if in.Confirm != "restore" {
		fail(w, http.StatusBadRequest, "confirm", `Send {"confirm": "restore"} to restore a backup.`)
		return
	}
	pending, err := a.Backups.PrepareRestore(r.PathValue("id"))
	if err != nil {
		if errors.Is(err, backup.ErrNotFound) || errors.Is(err, backup.ErrBusy) {
			backupFailure(w, err)
			return
		}
		fail(w, http.StatusBadRequest, "invalid_backup", err.Error())
		return
	}
	restarting := a.Restart != nil
	if restarting {
		go func() {
			time.Sleep(500 * time.Millisecond) // the answer first
			a.Restart()
		}()
	}
	ok(w, map[string]any{"pending": pending, "restarting": restarting})
}

func (a *API) cancelRestore(w http.ResponseWriter, r *http.Request) {
	if err := a.Backups.CancelRestore(); err != nil {
		fail(w, http.StatusConflict, "cannot_cancel", err.Error())
		return
	}
	ok(w, map[string]bool{"ok": true})
}

// --- diagnostics ---------------------------------------------------------------------------------------------------

func (a *API) diagnosticsZip() ([]byte, string, error) {
	var buf bytes.Buffer
	if err := a.Manager.WriteDiagnostics(&buf); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), diagnostics.Name(time.Now()), nil
}

// downloadDiagnostics is the browser's way: the zip as a download.
func (a *API) downloadDiagnostics(w http.ResponseWriter, r *http.Request) {
	data, name, err := a.diagnosticsZip()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "The diagnostics couldn't be made: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

// saveDiagnostics asks where to save the zip (the desktop app's Save dialog) and writes it. 501 without a dialog.
func (a *API) saveDiagnostics(w http.ResponseWriter, r *http.Request) {
	if a.SaveDialog == nil {
		fail(w, http.StatusNotImplemented, "not_supported", "Saving through a dialog needs the desktop app.")
		return
	}
	data, name, err := a.diagnosticsZip()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "The diagnostics couldn't be made: "+err.Error())
		return
	}
	path, err := a.SaveDialog(name)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "The save dialog failed: "+err.Error())
		return
	}
	if path == "" {
		ok(w, map[string]any{"cancelled": true})
		return
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "Could not write "+path+": "+err.Error())
		return
	}
	ok(w, map[string]any{"path": path})
}
