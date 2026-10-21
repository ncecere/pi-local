package app

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/backup"
	"github.com/ncecere/pi-local/internal/secrets"
	"github.com/ncecere/pi-local/internal/supervisor"
)

// zipText is every file of a zip, by name.
func zipText(t *testing.T, path string) map[string]string {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	out := map[string]string{}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		rc, _ := f.Open()
		raw, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = string(raw)
	}
	return out
}

type backupJSON struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	Reason    string `json:"reason"`
	Size      int64  `json:"size"`
	Agents    int    `json:"agents"`
	NeedsKeys []struct {
		Kind, ID string
		Items    []string
	} `json:"needsKeys"`
}

type backupListJSON struct {
	Backups     []backupJSON `json:"backups"`
	Auto        bool         `json:"auto"`
	Keep        int          `json:"keep"`
	CanRestart  bool         `json:"canRestart"`
	Pending     *struct{ ID string }
	LastRestore *struct {
		OK      bool
		MovedTo string
		Error   string
	} `json:"lastRestore"`
}

// A backup is made while an agent is awake (its runtime holds its storage exclusively): the agent sleeps for the
// copy and is awake again after. Restoring it brings back the old conversations, the old data is kept aside, and no
// secret is in the zip.
func TestBackupAndRestoreWithAnAwakeAgent(t *testing.T) {
	dir := t.TempDir()
	keychain := secrets.NewMemory() // the keychain outlives the app
	h := start(t, dir, Config{DemoTokensPerSecond: "100000", Secrets: keychain})
	agent := h.createAgent("Keeper")
	h.mustDo("POST", "/api/providers", map[string]any{"id": "acme", "name": "Acme", "kind": "openai-compatible", "baseUrl": "http://127.0.0.1:1/v1", "apiKey": "sk-test-secret-value-0123456789"}, 201)
	h.sendAndWait(agent, "t1", "remember the first thing", "r1")
	if s := h.status(agent); s != supervisor.Awake {
		t.Fatalf("the agent should be awake: %s", s)
	}
	os.WriteFile(filepath.Join(dir, "agents", agent, "workspace", "notes.txt"), []byte("my notes"), 0o600)

	var list backupListJSON
	list = decodeInto[backupListJSON](t, h.mustDo("GET", "/api/backups", nil, 200))
	if len(list.Backups) != 0 || !list.Auto || list.Keep != 7 || list.CanRestart {
		t.Fatalf("a new data folder: %+v", list)
	}

	made := decodeInto[backupJSON](t, h.mustDo("POST", "/api/backups", nil, 201))
	if made.Reason != "manual" || made.Agents != 1 || made.Size == 0 || filepath.Dir(made.Path) != filepath.Join(dir, "backups") {
		t.Fatalf("the backup: %+v", made)
	}
	if s := h.status(agent); s != supervisor.Awake {
		t.Fatalf("the agent should wake again after its copy: %s", s)
	}
	if len(made.NeedsKeys) != 1 || made.NeedsKeys[0].ID != "acme" || made.NeedsKeys[0].Items[0] != "API key" {
		t.Fatalf("keys to enter again: %+v", made.NeedsKeys)
	}
	files := zipText(t, made.Path)
	if !strings.HasPrefix(files["agents/"+agent+"/state.sqlite"], "SQLite format 3") || files["agents/"+agent+"/workspace/notes.txt"] != "my notes" {
		t.Fatalf("the backup lacks the conversations or the workspace: %d files", len(files))
	}
	for name, text := range files {
		if strings.Contains(text, "sk-test-secret-value") {
			t.Fatalf("the provider's key is in %s", name)
		}
	}
	// The agent still works after being stopped and started for the copy.
	h.sendAndWait(agent, "t1", "and a second thing, after the backup", "r2")
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"name": "Renamed"}, 200)
	if v := h.view(agent, "t1"); len(v.Messages) != 4 {
		t.Fatalf("messages before the restore: %d", len(v.Messages))
	}

	// Restoring needs the word, and the app restarts to do it.
	h.mustDo("POST", "/api/backups/"+made.ID+"/restore", map[string]any{}, 400)
	h.mustDo("POST", "/api/backups/pi-local-nope/restore", map[string]any{"confirm": "restore"}, 404)
	restarted := make(chan struct{}, 1)
	h.app.API.Restart = func() { restarted <- struct{}{} }
	res := decodeInto[struct {
		Restarting bool `json:"restarting"`
		Pending    struct{ ID, Phase string }
	}](t, h.mustDo("POST", "/api/backups/"+made.ID+"/restore", map[string]any{"confirm": "restore"}, 200))
	if !res.Restarting || res.Pending.ID != made.ID || res.Pending.Phase != "pending" {
		t.Fatalf("restore: %+v", res)
	}
	select {
	case <-restarted:
	case <-time.After(5 * time.Second):
		t.Fatal("the app wasn't asked to restart")
	}
	if got := decodeInto[backupListJSON](t, h.mustDo("GET", "/api/backups", nil, 200)); got.Pending == nil || !got.CanRestart {
		t.Fatalf("pending: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "restore-pending.json")); err != nil {
		t.Fatal("no marker for the next start")
	}

	// Quit and open it again: the restore is applied before anything opens app.db.
	h.close()
	h = start(t, dir, Config{DemoTokensPerSecond: "100000", Secrets: keychain})
	after := decodeInto[backupListJSON](t, h.mustDo("GET", "/api/backups", nil, 200))
	if after.Pending != nil || after.LastRestore == nil || !after.LastRestore.OK || !strings.Contains(after.LastRestore.MovedTo, "before-restore-") {
		t.Fatalf("after the restore: %+v", after)
	}
	if !strings.HasPrefix(after.LastRestore.MovedTo, dir) {
		t.Fatalf("the old data's folder: %s", after.LastRestore.MovedTo)
	}
	if got := string(h.mustDo("GET", "/api/agents", nil, 200)); !strings.Contains(got, `"name":"Keeper"`) || strings.Contains(got, "Renamed") {
		t.Fatalf("agents after the restore: %s", got)
	}
	v := h.view(agent, "t1")
	if len(v.Messages) != 2 || v.Messages[0].Text != "remember the first thing" {
		t.Fatalf("conversation after the restore: %+v", v.Messages)
	}
	if got := string(h.mustDo("GET", "/api/providers", nil, 200)); !strings.Contains(got, `"id":"acme"`) || !strings.Contains(got, `"hasKey":true`) {
		t.Fatalf("providers after the restore: %s", got)
	}
	// The data that was replaced is kept: the renamed agent and the longer conversation.
	asideAgent := filepath.Join(after.LastRestore.MovedTo, "agents", agent)
	if raw, err := os.ReadFile(filepath.Join(asideAgent, "agent.yaml")); err != nil || !strings.Contains(string(raw), "Renamed") {
		t.Fatalf("the old agent.yaml: %v", err)
	}
	if _, err := os.Stat(filepath.Join(asideAgent, "state.sqlite")); err != nil {
		t.Fatal(err)
	}
	// The backup survives its own restore, and the restored agent still answers.
	if got := decodeInto[backupListJSON](t, h.mustDo("GET", "/api/backups", nil, 200)); len(got.Backups) != 1 {
		t.Fatalf("backups: %+v", got.Backups)
	}
	h.sendAndWait(agent, "t1", "back again", "r3")
}

func TestBackupsAreListedRevealedAndDeleted(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	h.createAgent("Quiet")
	made := decodeInto[backupJSON](t, h.mustDo("POST", "/api/backups", map[string]any{}, 201))
	// A backup to a folder of the person's choosing isn't listed (and the folder has to exist).
	elsewhere := t.TempDir()
	other := decodeInto[backupJSON](t, h.mustDo("POST", "/api/backups", map[string]any{"folder": elsewhere}, 201))
	if filepath.Dir(other.Path) != elsewhere {
		t.Fatalf("%+v", other)
	}
	h.mustDo("POST", "/api/backups", map[string]any{"folder": filepath.Join(elsewhere, "missing")}, 400)
	h.mustDo("POST", "/api/backups", map[string]any{"folder": "relative"}, 400)
	if got := decodeInto[backupListJSON](t, h.mustDo("GET", "/api/backups", nil, 200)); len(got.Backups) != 1 || got.Backups[0].ID != made.ID {
		t.Fatalf("list: %+v", got.Backups)
	}
	// Turning the daily backup off.
	if got := decodeInto[backupListJSON](t, h.mustDo("PUT", "/api/backups/settings", map[string]any{"auto": false}, 200)); got.Auto {
		t.Fatal("still on")
	}
	if got := decodeInto[backupListJSON](t, h.mustDo("GET", "/api/backups", nil, 200)); got.Auto {
		t.Fatal("not saved")
	}
	h.mustDo("POST", "/api/backups/pi-local-nope/reveal", nil, 404)
	h.mustDo("DELETE", "/api/backups/"+made.ID, nil, 200)
	h.mustDo("DELETE", "/api/backups/"+made.ID, nil, 404)
	h.mustDo("DELETE", "/api/backups/pending-restore", nil, 200) // nothing pending: fine
	if _, err := os.Stat(made.Path); err == nil {
		t.Fatal("the file is still there")
	}
}

// Installing an update makes a backup first (the updater's hook), and it is kept apart from the daily ones.
func TestTheBackupBeforeAnUpdate(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	h.createAgent("Careful")
	if h.app.Updater.BeforeInstall == nil {
		t.Fatal("updates install without a backup")
	}
	if err := h.app.Updater.BeforeInstall(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := decodeInto[backupListJSON](t, h.mustDo("GET", "/api/backups", nil, 200))
	if len(got.Backups) != 1 || got.Backups[0].Reason != backup.BeforeUpdate.String() {
		t.Fatalf("backups: %+v", got.Backups)
	}
}

// The diagnostics zip has the logs and the setup, and none of the secrets in them.
func TestDiagnostics(t *testing.T) {
	dir := t.TempDir()
	h := start(t, dir, Config{DemoTokensPerSecond: "100000"})
	agent := h.createAgent("Noisy")
	h.mustDo("POST", "/api/providers", map[string]any{"id": "acme", "name": "Acme", "kind": "openai-compatible", "baseUrl": "http://127.0.0.1:1/v1", "apiKey": "sk-test-secret-value-0123456789"}, 201)
	h.sendAndWait(agent, "t1", "a private conversation", "r1")
	logPath := filepath.Join(dir, "agents", agent, "logs", "runtime.log")
	f, _ := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o600)
	f.WriteString("request failed with Authorization: Bearer sk-test-secret-value-0123456789\n")
	f.Close()

	code, header, data := h.raw("GET", "/api/diagnostics", "", nil)
	if code != 200 || header.Get("Content-Type") != "application/zip" || !strings.Contains(header.Get("Content-Disposition"), "pi-local-diagnostics-") {
		t.Fatalf("download: %d %v", code, header)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	all := map[string]string{}
	for _, zf := range zr.File {
		rc, _ := zf.Open()
		raw, _ := io.ReadAll(rc)
		rc.Close()
		all[zf.Name] = string(raw)
	}
	log := all["agents/"+agent+"/runtime.log"]
	if !strings.Contains(log, "request failed with Authorization: [redacted") || !strings.Contains(all["recent-errors.txt"], "request failed") {
		t.Fatalf("log: %s\nerrors: %s", log, all["recent-errors.txt"])
	}
	if !strings.Contains(all["app.log"], "level=") && all["app.log"] != "\n" {
		t.Logf("app.log: %q", all["app.log"])
	}
	joined := ""
	for _, text := range all {
		joined += text
	}
	for _, leaked := range []string{"sk-test-secret-value", "a private conversation"} {
		if strings.Contains(joined, leaked) {
			t.Fatalf("%q is in the diagnostics", leaked)
		}
	}
	if !strings.Contains(all["providers.json"], "acme") || !strings.Contains(all["agents/"+agent+"/agent.yaml"], "name: Noisy") {
		t.Fatalf("providers: %s", all["providers.json"])
	}
	// Without a Save dialog (a browser) POST says so; with one, it saves where it is told.
	h.mustDo("POST", "/api/diagnostics", nil, 501)
	target := filepath.Join(t.TempDir(), "diag.zip")
	h.app.API.SaveDialog = func(name string) (string, error) { return target, nil }
	if res := decodeInto[struct{ Path string }](t, h.mustDo("POST", "/api/diagnostics", nil, 200)); res.Path != target {
		t.Fatalf("saved: %+v", res)
	}
	if st, err := os.Stat(target); err != nil || st.Size() == 0 {
		t.Fatal("nothing was written")
	}
	h.app.API.SaveDialog = func(string) (string, error) { return "", nil }
	if got := string(h.mustDo("POST", "/api/diagnostics", nil, 200)); !strings.Contains(got, `"cancelled":true`) {
		t.Fatalf("cancelled: %s", got)
	}
}
