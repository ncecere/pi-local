package backup

import (
	"archive/zip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/appdb"
)

const agentA = "ag_aaaaaaaaaaaaaaaa"
const agentB = "ag_bbbbbbbbbbbbbbbb"

type fixture struct {
	t    *testing.T
	dir  string
	db   *sql.DB
	svc  *Service
	now  time.Time
	busy bool

	mu       sync.Mutex
	quiesced []string
	woken    []string
	// held is an agent's storage connection, open the way an awake runtime has it (exclusive).
	held map[string]*sql.DB
}

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// openState makes an agent's state.sqlite with one row, the way its runtime would hold it: WAL mode, exclusive.
func openState(t *testing.T, path, row string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	for _, q := range []string{"PRAGMA locking_mode = EXCLUSIVE", "PRAGMA journal_mode = WAL", "CREATE TABLE IF NOT EXISTS messages (text TEXT)"} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("INSERT INTO messages VALUES (?)", row); err != nil {
		t.Fatal(err)
	}
	return db
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t, dir: t.TempDir(), now: time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC), held: map[string]*sql.DB{}}
	db, err := appdb.Open(context.Background(), filepath.Join(f.dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	f.db = db
	db.Exec(`INSERT INTO settings (key, value) VALUES ('default_model', 'demo/demo-1')`)

	writeFile(t, filepath.Join(f.dir, "templates", "mine.yaml"), "id: mine\n")
	writeFile(t, filepath.Join(f.dir, "skills", "pdf-tools", "SKILL.md"), "---\nname: pdf-tools\ndescription: d\n---\n")
	writeFile(t, filepath.Join(f.dir, "prompts", "summarize.md"), "---\ntitle: Summarize\n---\nSummarize {{x}}\n")
	writeFile(t, filepath.Join(agentDirOf(f.dir, agentA), "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: d\n---\n")
	for id, name := range map[string]string{agentA: "Ann's helper", agentB: "Bob"} {
		root := filepath.Join(f.dir, "agents", id)
		writeFile(t, filepath.Join(root, "agent.yaml"), "name: "+name+"\n")
		writeFile(t, filepath.Join(root, "memory.json"), `{"notes":["likes tea"]}`)
		writeFile(t, filepath.Join(root, "workspace", "notes", "todo.md"), "buy milk\n")
		writeFile(t, filepath.Join(root, "logs", "runtime.log"), "a log line\n")
		writeFile(t, filepath.Join(root, "tmp", "scratch.txt"), "scratch")
		writeFile(t, filepath.Join(root, "tmp", "attachments", "upload.pdf"), "pdf bytes")
		os.Symlink("/etc/hosts", filepath.Join(root, "workspace", "link"))
	}
	// Agent A is awake: its runtime holds its storage exclusively. B is asleep.
	f.held[agentA] = openState(t, filepath.Join(f.dir, "agents", agentA, "state.sqlite"), "hello from A")
	t.Cleanup(func() {
		for _, h := range f.held {
			h.Close()
		}
	})
	bdb := openState(t, filepath.Join(f.dir, "agents", agentB, "state.sqlite"), "hello from B")
	bdb.Close()

	f.svc = New(Config{
		DataDir: f.dir, DB: db, Version: "0.3.0-test",
		Agents: func() []AgentInfo {
			return []AgentInfo{
				{ID: agentA, Name: "Ann's helper", Dir: filepath.Join(f.dir, "agents", agentA)},
				{ID: agentB, Name: "Bob", Dir: filepath.Join(f.dir, "agents", agentB), ProjectFolder: "/Users/bob/project"},
			}
		},
		Quiesce: func(id string, fn func() error) (bool, error) {
			f.mu.Lock()
			f.quiesced = append(f.quiesced, id)
			held := f.held[id]
			delete(f.held, id)
			f.mu.Unlock()
			if held != nil {
				held.Close() // stopping the runtime lets go of its storage
			}
			return held != nil, fn()
		},
		Wake: func(ctx context.Context, id string) error {
			f.mu.Lock()
			f.woken = append(f.woken, id)
			f.mu.Unlock()
			return nil
		},
		Keys: func(context.Context) []KeyNeed {
			return []KeyNeed{{Kind: "provider", ID: "openai", Name: "OpenAI", Items: []string{"API key"}}, {Kind: "mcp", ID: "github", Name: "GitHub", Items: []string{"Variable GITHUB_TOKEN"}}}
		},
		Busy: func(context.Context) bool { return f.busy },
		Now:  func() time.Time { return f.now },
	})
	return f
}

func agentDirOf(dir, id string) string { return filepath.Join(dir, "agents", id) }

func zipNames(t *testing.T, path string) []string {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	sort.Strings(names)
	return names
}

func TestABackupHoldsTheDataAndNoSecrets(t *testing.T) {
	f := newFixture(t)
	info, err := f.svc.Create(context.Background(), Manual, "")
	if err != nil {
		t.Fatal(err)
	}
	if info.ID != "pi-local-2026-10-01-090000" || info.Reason != Manual || !info.Readable || info.Agents != 2 || info.Version != "0.3.0-test" {
		t.Fatalf("%+v", info)
	}
	want := []string{
		"agents/" + agentA + "/agent.yaml", "agents/" + agentA + "/memory.json", "agents/" + agentA + "/skills/", "agents/" + agentA + "/skills/mine/", "agents/" + agentA + "/skills/mine/SKILL.md", "agents/" + agentA + "/state.sqlite",
		"agents/" + agentA + "/tmp/", "agents/" + agentA + "/tmp/attachments/", "agents/" + agentA + "/tmp/attachments/upload.pdf",
		"agents/" + agentA + "/workspace/", "agents/" + agentA + "/workspace/notes/", "agents/" + agentA + "/workspace/notes/todo.md",
		"agents/" + agentB + "/agent.yaml", "agents/" + agentB + "/memory.json", "agents/" + agentB + "/state.sqlite",
		"agents/" + agentB + "/tmp/", "agents/" + agentB + "/tmp/attachments/", "agents/" + agentB + "/tmp/attachments/upload.pdf",
		"agents/" + agentB + "/workspace/", "agents/" + agentB + "/workspace/notes/", "agents/" + agentB + "/workspace/notes/todo.md",
		"app.db", "manifest.json", "prompts/summarize.md", "skills/pdf-tools/", "skills/pdf-tools/SKILL.md", "templates/mine.yaml",
	}
	if got := zipNames(t, info.Path); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("the backup holds:\n%s\nwanted:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	// No logs, no scratch files; the links weren't followed, and the manifest says so.
	m, err := ReadManifest(info.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Agents) != 2 || m.Agents[0].WorkspaceFiles != 1 || !m.Agents[0].Conversations || m.Agents[1].ProjectFolder != "/Users/bob/project" {
		t.Fatalf("agents in the manifest: %+v", m.Agents)
	}
	if len(m.Warnings) != 1 || !strings.Contains(m.Warnings[0], "2 symbolic links") {
		t.Fatalf("warnings: %v", m.Warnings)
	}
	// Which keys will need entering again: names, never values.
	if len(m.NeedsKeys) != 2 || m.NeedsKeys[1].Items[0] != "Variable GITHUB_TOKEN" {
		t.Fatalf("keys: %+v", m.NeedsKeys)
	}
	raw, _ := json.Marshal(m)
	if strings.Contains(string(raw), "ghp_") || !strings.Contains(m.Note, "keychain") {
		t.Fatalf("manifest: %s", raw)
	}
	// The awake agent was stopped for its copy and woken after; the asleep one was held still too, but not woken.
	if strings.Join(f.quiesced, ",") != agentA+","+agentB || strings.Join(f.woken, ",") != agentA {
		t.Fatalf("quiesced %v, woken %v", f.quiesced, f.woken)
	}
	// What it holds opens: app.db and the awake agent's conversations (its WAL folded in).
	dir := t.TempDir()
	if err := unpack(info.Path, dir); err != nil {
		t.Fatal(err)
	}
	var model string
	copied, _ := sql.Open("sqlite", "file:"+filepath.Join(dir, "app.db"))
	defer copied.Close()
	if err := copied.QueryRow(`SELECT value FROM settings WHERE key = 'default_model'`).Scan(&model); err != nil || model != "demo/demo-1" {
		t.Fatalf("app.db in the backup: %q %v", model, err)
	}
	var text string
	state, _ := sql.Open("sqlite", "file:"+filepath.Join(dir, "agents", agentA, "state.sqlite"))
	defer state.Close()
	if err := state.QueryRow(`SELECT text FROM messages`).Scan(&text); err != nil || text != "hello from A" {
		t.Fatalf("conversations in the backup: %q %v", text, err)
	}
	// Nothing is left behind in the backup folder.
	entries, _ := os.ReadDir(f.svc.Dir())
	if len(entries) != 1 {
		t.Fatalf("the backup folder: %v", entries)
	}
}

func TestABackupToAChosenFolder(t *testing.T) {
	f := newFixture(t)
	elsewhere := t.TempDir()
	info, err := f.svc.Create(context.Background(), Manual, elsewhere)
	if err != nil || filepath.Dir(info.Path) != elsewhere {
		t.Fatalf("%v %+v", err, info)
	}
	if list, _ := f.svc.List(); len(list) != 0 {
		t.Fatalf("a backup elsewhere is not in the list: %v", list)
	}
	if _, err := f.svc.Create(context.Background(), Manual, filepath.Join(elsewhere, "nope")); err == nil {
		t.Fatal("a missing folder was accepted")
	}
}

func TestAutomaticBackupsKeepSevenAndManualOnesStay(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	make := func(reason Reason) {
		f.now = f.now.Add(time.Hour)
		if _, err := f.svc.Create(ctx, reason, ""); err != nil {
			t.Fatal(err)
		}
	}
	make(Manual)
	for i := 0; i < 9; i++ {
		make(Automatic)
	}
	for i := 0; i < 5; i++ {
		make(BeforeUpdate)
	}
	list, _ := f.svc.List()
	counts := map[Reason]int{}
	for _, b := range list {
		counts[b.Reason]++
	}
	if counts[Automatic] != KeepAutomatic || counts[Manual] != 1 || counts[BeforeUpdate] != KeepBeforeUpdate {
		t.Fatalf("kept %v", counts)
	}
	// It is the newest that stay.
	for _, b := range list {
		if b.Reason == Automatic && b.CreatedAt < time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC).Add(4*time.Hour).UnixMilli() {
			t.Fatalf("an old automatic backup was kept over a newer one: %s", b.ID)
		}
	}
}

func TestTheDailyBackupIsDailyOnByDefaultAndPatient(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	count := func() int { l, _ := f.svc.List(); return len(l) }
	if !f.svc.Auto() {
		t.Fatal("automatic backups are on by default")
	}
	f.svc.tick(ctx)
	if count() != 1 {
		t.Fatal("no backup yet: one is due")
	}
	f.now = f.now.Add(23 * time.Hour)
	f.svc.tick(ctx)
	if count() != 1 {
		t.Fatal("less than a day: none is due")
	}
	// A day on, but an agent is mid-reply: it waits for a quiet moment...
	f.now = f.now.Add(2 * time.Hour)
	f.busy = true
	f.svc.tick(ctx)
	if count() != 1 {
		t.Fatal("it should wait while an agent is working")
	}
	// ...but not for ever.
	f.now = f.now.Add(12 * time.Hour)
	f.svc.tick(ctx)
	if count() != 2 {
		t.Fatal("after 12 hours of waiting it goes ahead")
	}
	// Off means off.
	if err := f.svc.SetAuto(false); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(48 * time.Hour)
	f.svc.tick(ctx)
	if f.svc.Auto() || count() != 2 {
		t.Fatal("a backup was made with automatic backups off")
	}
}

func TestOnlyOneBackupAtATime(t *testing.T) {
	f := newFixture(t)
	f.svc.mu.Lock()
	_, err := f.svc.Create(context.Background(), Manual, "")
	f.svc.mu.Unlock()
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("%v", err)
	}
}

func TestDeleteAndUnknownIDs(t *testing.T) {
	f := newFixture(t)
	info, _ := f.svc.Create(context.Background(), Manual, "")
	if err := f.svc.Delete("../../etc/passwd"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if err := f.svc.Delete(info.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(info.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the file is still there")
	}
	if err := f.svc.Delete(info.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

// restoreInto is what the next start does: apply what is pending, with app.db closed.
func (f *fixture) applyRestore() (*RestoreResult, error) {
	f.t.Helper()
	f.db.Close()
	for _, h := range f.held {
		h.Close()
	}
	return ApplyPending(f.dir, f.now.Add(time.Hour))
}

func TestRestoreReplacesTheDataAndKeepsTheOldAside(t *testing.T) {
	f := newFixture(t)
	info, err := f.svc.Create(context.Background(), Manual, "")
	if err != nil {
		t.Fatal(err)
	}
	// Things change after the backup.
	f.db.Exec(`UPDATE settings SET value = 'changed/model' WHERE key = 'default_model'`)
	writeFile(t, filepath.Join(f.dir, "agents", agentA, "workspace", "notes", "todo.md"), "changed\n")
	writeFile(t, filepath.Join(f.dir, "agents", agentA, "workspace", "new.txt"), "made after the backup")
	writeFile(t, filepath.Join(f.dir, "templates", "later.yaml"), "id: later\n")
	writeFile(t, filepath.Join(f.dir, "skills", "later", "SKILL.md"), "made after the backup")
	writeFile(t, filepath.Join(f.dir, "prompts", "later.md"), "made after the backup")
	os.Remove(filepath.Join(f.dir, "prompts", "summarize.md"))

	pending, err := f.svc.PrepareRestore(info.ID)
	if err != nil || pending.Phase != "pending" {
		t.Fatalf("%v %+v", err, pending)
	}
	// Preparing changes nothing, and can be taken back.
	if got := readFile(t, filepath.Join(f.dir, "agents", agentA, "workspace", "new.txt")); got == "" {
		t.Fatal("preparing a restore changed the data")
	}
	if err := f.svc.CancelRestore(); err != nil || f.svc.Pending() != nil {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := f.svc.PrepareRestore(info.ID); err != nil {
		t.Fatal(err)
	}

	res, err := f.applyRestore()
	if err != nil || res == nil || !res.OK || res.MovedTo != "before-restore-2026-10-01" {
		t.Fatalf("%v %+v", err, res)
	}
	if got := readFile(t, filepath.Join(f.dir, "agents", agentA, "workspace", "notes", "todo.md")); got != "buy milk\n" {
		t.Fatalf("the workspace after the restore: %q", got)
	}
	// The shared skills and prompts come back as they were.
	if got := readFile(t, filepath.Join(f.dir, "prompts", "summarize.md")); !strings.Contains(got, "Summarize {{x}}") {
		t.Fatalf("the prompts after the restore: %q", got)
	}
	if got := readFile(t, filepath.Join(f.dir, "skills", "pdf-tools", "SKILL.md")); !strings.Contains(got, "pdf-tools") {
		t.Fatalf("the skills after the restore: %q", got)
	}
	if got := readFile(t, filepath.Join(f.dir, "agents", agentA, "skills", "mine", "SKILL.md")); !strings.Contains(got, "mine") {
		t.Fatalf("an agent's own skill after the restore: %q", got)
	}
	for _, gone := range []string{filepath.Join(f.dir, "agents", agentA, "workspace", "new.txt"), filepath.Join(f.dir, "templates", "later.yaml"), filepath.Join(f.dir, "skills", "later"), filepath.Join(f.dir, "prompts", "later.md")} {
		if _, err := os.Stat(gone); err == nil {
			t.Fatalf("%s survived the restore", gone)
		}
	}
	// The pieces an agent needs exist again; the backup itself and the marker are as they should be.
	for _, sub := range []string{"logs", "tmp", "workspace"} {
		if st, err := os.Stat(filepath.Join(f.dir, "agents", agentB, sub)); err != nil || !st.IsDir() {
			t.Fatalf("agent folder %s: %v", sub, err)
		}
	}
	if _, err := os.Stat(info.Path); err != nil {
		t.Fatal("the backup is gone")
	}
	if PendingRestore(f.dir) != nil {
		t.Fatal("the marker is still there")
	}
	if last := LastRestore(f.dir); last == nil || !last.OK || last.ID != info.ID {
		t.Fatalf("last restore: %+v", last)
	}
	if _, err := os.Stat(filepath.Join(f.dir, stagingDir)); err == nil {
		t.Fatal("staging is left behind")
	}
	// The data that was replaced is in the folder moved aside to.
	aside := filepath.Join(f.dir, "before-restore-2026-10-01")
	if got := readFile(t, filepath.Join(aside, "agents", agentA, "workspace", "new.txt")); got != "made after the backup" {
		t.Fatalf("aside: %q", got)
	}
	if _, err := os.Stat(filepath.Join(aside, "templates", "later.yaml")); err != nil {
		t.Fatal(err)
	}
	moved, err := sql.Open("sqlite", "file:"+filepath.Join(aside, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer moved.Close()
	var model string
	moved.QueryRow(`SELECT value FROM settings WHERE key = 'default_model'`).Scan(&model)
	if model != "changed/model" {
		t.Fatalf("the old app.db moved aside holds %q", model)
	}
	// And the restored app.db opens, with the old value.
	restored, err := appdb.Open(context.Background(), filepath.Join(f.dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	restored.QueryRow(`SELECT value FROM settings WHERE key = 'default_model'`).Scan(&model)
	if model != "demo/demo-1" {
		t.Fatalf("the restored app.db holds %q", model)
	}
}

func TestARestoreThatCantBeUsedChangesNothing(t *testing.T) {
	f := newFixture(t)
	good, _ := f.svc.Create(context.Background(), Manual, "")

	// A zip that tries to write outside the data folder.
	evil := filepath.Join(f.svc.Dir(), "pi-local-evil.zip")
	out, _ := os.Create(evil)
	zw := zip.NewWriter(out)
	for name, body := range map[string]string{
		"manifest.json":    `{"format":1,"app":"Pi Local","version":"x","createdAt":1,"reason":"manual"}`,
		"app.db":           "SQLite format 3\x00",
		"../escaped.txt":   "no",
		"agents/x/../../y": "no",
	} {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	zw.Close()
	out.Close()
	notABackup := filepath.Join(f.svc.Dir(), "pi-local-junk.zip")
	os.WriteFile(notABackup, []byte("not a zip"), 0o600)

	if _, err := f.svc.PrepareRestore("pi-local-junk"); err == nil || !strings.Contains(err.Error(), "can't be restored") {
		t.Fatalf("a file that isn't a backup: %v", err)
	}
	if _, err := f.svc.PrepareRestore("pi-local-missing"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.dir, "agents", agentA, "workspace", "keep.txt"), "mine")
	if _, err := f.svc.PrepareRestore("pi-local-evil"); err != nil { // its manifest and app.db are there; the rest shows at unpacking
		t.Fatal(err)
	}
	res, err := f.applyRestore()
	if err != nil || res == nil || res.OK || !strings.Contains(res.Error, "nothing was changed") {
		t.Fatalf("%v %+v", err, res)
	}
	if got := readFile(t, filepath.Join(f.dir, "agents", agentA, "workspace", "keep.txt")); got != "mine" {
		t.Fatal("the data changed")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(f.dir), "escaped.txt")); err == nil {
		t.Fatal("a file escaped the data folder")
	}
	if PendingRestore(f.dir) != nil {
		t.Fatal("a failed restore is still pending (the next start would try again for ever)")
	}
	if last := LastRestore(f.dir); last == nil || last.OK {
		t.Fatalf("last restore: %+v", last)
	}
	_ = good
}

func TestARestoreInterruptedHalfWayCarriesOn(t *testing.T) {
	f := newFixture(t)
	info, _ := f.svc.Create(context.Background(), Manual, "")
	writeFile(t, filepath.Join(f.dir, "agents", agentA, "workspace", "new.txt"), "after")
	if _, err := f.svc.PrepareRestore(info.ID); err != nil {
		t.Fatal(err)
	}
	f.db.Close()
	for _, h := range f.held {
		h.Close()
	}
	// The first start: unpacked and checked, app.db moved in, then the app died before agents/ was.
	staging := filepath.Join(f.dir, stagingDir)
	if err := unpack(info.Path, staging); err != nil {
		t.Fatal(err)
	}
	if err := checkStaged(staging); err != nil {
		t.Fatal(err)
	}
	aside := filepath.Join(f.dir, "before-restore-2026-10-01")
	os.MkdirAll(aside, 0o700)
	for _, suffix := range []string{"", "-wal", "-shm"} {
		moveIfExists(filepath.Join(f.dir, "app.db"+suffix), filepath.Join(aside, "app.db"+suffix))
	}
	os.Rename(filepath.Join(staging, "app.db"), filepath.Join(f.dir, "app.db"))
	p := PendingRestore(f.dir)
	p.Phase, p.MovedTo = "applying", "before-restore-2026-10-01"
	writeJSONFile(filepath.Join(f.dir, markerFile), p)

	res, err := ApplyPending(f.dir, f.now)
	if err != nil || !res.OK {
		t.Fatalf("%v %+v", err, res)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "agents", agentA, "workspace", "new.txt")); err == nil {
		t.Fatal("agents/ was not restored")
	}
	if got := readFile(t, filepath.Join(aside, "agents", agentA, "workspace", "new.txt")); got != "after" {
		t.Fatalf("the replaced agents/ is in %q", fmt.Sprint(aside))
	}
	// The restored app.db is the one moved in before the interruption, not moved aside again.
	if _, err := os.Stat(filepath.Join(f.dir, "app.db")); err != nil {
		t.Fatal(err)
	}
}
