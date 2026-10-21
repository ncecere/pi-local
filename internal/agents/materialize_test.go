package agents

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ncecere/pi-local/internal/appdb"
)

func openUpdateStore(t *testing.T, data string) (*sql.DB, *Store) {
	t.Helper()
	db, err := appdb.Open(t.Context(), filepath.Join(data, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	s, err := Open(t.Context(), db, filepath.Join(data, "agents"))
	if err != nil {
		t.Fatal(err)
	}
	return db, s
}

func createUpdateAgent(t *testing.T, s *Store) *Agent {
	t.Helper()
	a, err := s.Create(t.Context(), Config{Name: "Original", Model: DemoModel})
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestStalePreparedUpdateNeverTouchesFile(t *testing.T) {
	_, s := openUpdateStore(t, t.TempDir())
	a := createUpdateAgent(t, s)
	latest, err := s.Update(t.Context(), a.ID, func(c *Config) { c.Name = "Human edit" })
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(a.Dir, configFile)
	before, _ := os.Stat(path)
	raw, _ := os.ReadFile(path)
	s.updateBoundary = func(string) error { t.Fatal("stale proposal reached persistence"); return nil }
	_, err = s.UpdatePrepared(t.Context(), a.ID, a.Revision, func(c *Config) {
		t.Fatal("stale proposal reached configuration callback")
	}, func(*sql.Tx) error { t.Fatal("stale proposal reached transaction"); return nil })
	if err == nil || !strings.Contains(err.Error(), "changed after this proposal") {
		t.Fatalf("stale precondition: %v", err)
	}
	after, _ := os.Stat(path)
	got, _ := os.ReadFile(path)
	if !os.SameFile(before, after) || !bytes.Equal(raw, got) {
		t.Fatal("stale proposal replaced live file")
	}
	current, _ := s.Get(a.ID)
	if current.Revision != latest.Revision || current.Config.Name != "Human edit" {
		t.Fatal("stale proposal changed memory")
	}
}

func TestUpdateCrashBoundariesRecoverCommittedRevision(t *testing.T) {
	for _, stage := range []string{"prepared", "precommit", "postcommit", "materialized"} {
		t.Run(stage, func(t *testing.T) {
			data := t.TempDir()
			cmd := exec.Command(os.Args[0], "-test.run=^TestUpdateProcessCrashHelper$")
			cmd.Env = append(os.Environ(), "PI_TEST_UPDATE_CRASH_DIR="+data, "PI_TEST_UPDATE_CRASH_STAGE="+stage)
			output, err := cmd.CombinedOutput()
			var exited *exec.ExitError
			if !errors.As(err, &exited) || exited.ExitCode() != 91 {
				t.Fatalf("crash helper did not reach %s: %v\n%s", stage, err, output)
			}
			db, recovered := openUpdateStore(t, data)
			list := recovered.List()
			if len(list) != 1 {
				t.Fatalf("recovered %d agents", len(list))
			}
			got := list[0]
			name, rev, receipts := "Original", 1, 0
			if stage == "postcommit" || stage == "materialized" {
				name, rev, receipts = "Approved", 2, 1
			}
			if got.Config.Name != name || got.Revision != rev {
				t.Fatalf("recovered %+v, want %s rev %d", got, name, rev)
			}
			cfg, err := readConfig(got.Dir)
			if err != nil || cfg.Name != name {
				t.Fatalf("live file: %+v, %v", cfg, err)
			}
			var count int
			if err := db.QueryRow(`SELECT COUNT(*) FROM update_receipts`).Scan(&count); err != nil || count != receipts {
				t.Fatalf("related commit count: %d %v", count, err)
			}
			if err := db.QueryRow(`SELECT COUNT(*) FROM agent_config_materializations`).Scan(&count); err != nil || count != 0 {
				t.Fatalf("journal not cleared: %d %v", count, err)
			}
		})
	}
}

// This helper exits without running transaction rollback, DB close or test cleanup.
// It models a process crash, not a normal return/panic with successful deferred repair.
func TestUpdateProcessCrashHelper(t *testing.T) {
	data := os.Getenv("PI_TEST_UPDATE_CRASH_DIR")
	if data == "" {
		return
	}
	db, s := openUpdateStore(t, data)
	a := createUpdateAgent(t, s)
	if _, err := db.Exec(`CREATE TABLE update_receipts (agent_id TEXT PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	var synchronous int
	if err := db.QueryRow(`PRAGMA synchronous`).Scan(&synchronous); err != nil || synchronous != 2 {
		t.Fatalf("SQLite durability: %d %v", synchronous, err)
	}
	s.updateBoundary = func(stage string) error {
		if stage == os.Getenv("PI_TEST_UPDATE_CRASH_STAGE") {
			os.Exit(91)
		}
		return nil
	}
	_, err := s.UpdatePrepared(t.Context(), a.ID, a.Revision, func(c *Config) { c.Name = "Approved" }, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO update_receipts VALUES (?)`, a.ID)
		return err
	})
	t.Fatalf("did not crash: %v", err)
}

func TestFailedTransactionNeedsNoFilesystemRollback(t *testing.T) {
	db, s := openUpdateStore(t, t.TempDir())
	a := createUpdateAgent(t, s)
	backup := a.Dir + ".unwritable"
	failed := errors.New("related insert failed")
	_, err := s.UpdatePrepared(t.Context(), a.ID, a.Revision, func(c *Config) { c.Name = "Uncommitted" }, func(*sql.Tx) error {
		// A filesystem restoration would fail here. No live write has taken place,
		// so rolling back SQLite is sufficient and no restoration error is hidden.
		if err := os.Rename(a.Dir, backup); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(a.Dir, []byte("not a directory"), 0600); err != nil {
			t.Fatal(err)
		}
		return failed
	})
	if !errors.Is(err, failed) {
		t.Fatal(err)
	}
	if err := os.Remove(a.Dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(backup, a.Dir); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(t.Context(), db, s.root)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := reopened.Get(a.ID)
	if got.Config.Name != "Original" || got.Revision != 1 {
		t.Fatalf("uncommitted change survived: %+v", got)
	}
}

func TestMaterializationFailureSurfacesAndRecoveryRetries(t *testing.T) {
	data := t.TempDir()
	db, s := openUpdateStore(t, data)
	a := createUpdateAgent(t, s)
	backup := a.Dir + ".backup"
	s.updateBoundary = func(stage string) error {
		if stage == "postcommit" {
			return os.Rename(a.Dir, backup) // fail the subsequent materialization write
		}
		return nil
	}
	got, err := s.UpdatePrepared(t.Context(), a.ID, a.Revision, func(c *Config) { c.Name = "Saved" }, nil)
	var outcome *SaveOutcomeError
	if !errors.As(err, &outcome) || !outcome.Committed || got == nil || got.Config.Name != "Saved" {
		t.Fatalf("committed failure not reported honestly: %+v %v", got, err)
	}
	if _, err := Open(t.Context(), db, s.root); err == nil {
		t.Fatal("startup swallowed recovery failure")
	}
	if err := os.Rename(backup, a.Dir); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(t.Context(), db, s.root)
	if err != nil {
		t.Fatal(err)
	}
	got, _ = reopened.Get(a.ID)
	if got.Config.Name != "Saved" || got.Revision != 2 {
		t.Fatalf("did not recover saved configuration: %+v", got)
	}
	if err := reopened.RecoverPending(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRollbackFailureSurfacesWithoutFilesystemRestoration(t *testing.T) {
	db, s := openUpdateStore(t, t.TempDir())
	a := createUpdateAgent(t, s)
	_, err := s.UpdatePrepared(t.Context(), a.ID, a.Revision, func(c *Config) { c.Name = "Uncommitted" }, func(tx *sql.Tx) error {
		// End SQLite's transaction underneath database/sql to force its deferred
		// Rollback to fail. The update must surface that failure, not discard it.
		if _, err := tx.Exec(`ROLLBACK`); err != nil {
			t.Fatal(err)
		}
		return errors.New("callback failed")
	})
	if err == nil || !strings.Contains(err.Error(), "rollback:") || !strings.Contains(err.Error(), "callback failed") {
		t.Fatalf("rollback failure swallowed: %v", err)
	}
	reopened, err := Open(t.Context(), db, s.root)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := reopened.Get(a.ID)
	if got.Config.Name != "Original" || got.Revision != 1 {
		t.Fatal("failed rollback changed config")
	}
}

func TestPostWriteFailureRetainsRecoveryRecord(t *testing.T) {
	db, s := openUpdateStore(t, t.TempDir())
	a := createUpdateAgent(t, s)
	s.updateBoundary = func(stage string) error {
		if stage == "materialized" {
			return errors.New("injected sync/clear failure")
		}
		return nil
	}
	_, err := s.Update(t.Context(), a.ID, func(c *Config) { c.Name = "Saved" })
	var outcome *SaveOutcomeError
	if !errors.As(err, &outcome) || !outcome.Committed {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM agent_config_materializations`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("missing recovery record: %d %v", count, err)
	}
	reopened, err := Open(t.Context(), db, s.root)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := reopened.Get(a.ID)
	if got.Config.Name != "Saved" {
		t.Fatal("recovery lost committed config")
	}
}
