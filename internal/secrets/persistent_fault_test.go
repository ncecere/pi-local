//go:build darwin || linux

package secrets

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPersistentBootstrapOrderAndExplicitChild(t *testing.T) {
	dir := filepath.Join(privateTempDir(t), "explicit-child")
	v := &fakeVault{getHook: func(_ int, name string) (string, error, bool) {
		b, err := os.ReadFile(filepath.Join(dir, identityFile))
		if err != nil || !strings.HasPrefix(string(b), identityPrefix) {
			t.Fatal("vault called before identity persisted")
		}
		if strings.Contains(name, dir) || !strings.HasPrefix(name, "pai-private-secrets/v1/") {
			t.Fatal("invalid vault namespace")
		}
		noDB(t, dir)
		return "", nil, false
	}}
	s := testOpen(t, dir, v)
	mustSet(t, s, "check", "ok")
	s.Close()
	v.getHook = nil
	testOpen(t, dir, v)
}

func TestPersistentSQLiteExecutionErrorsAndBusy(t *testing.T) {
	dir := privateTempDir(t)
	s := testOpen(t, dir, &fakeVault{})
	mustSet(t, s, "record", "old")
	for _, statement := range []string{
		`CREATE TRIGGER refuse_update BEFORE UPDATE ON secrets BEGIN SELECT RAISE(ABORT,'RAW_PRIVATE_DIAGNOSTIC'); END`,
		`CREATE TRIGGER refuse_delete BEFORE DELETE ON secrets BEGIN SELECT RAISE(ABORT,'RAW_PRIVATE_DIAGNOSTIC'); END`,
	} {
		if _, err := s.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	for _, err := range []error{s.Set("record", "new"), s.Delete("record")} {
		wantKind(t, err, ErrBackend)
		if strings.Contains(err.Error(), "RAW_PRIVATE_DIAGNOSTIC") {
			t.Fatal("SQLite diagnostic retained")
		}
		if errors.Unwrap(errors.Unwrap(err)) != nil {
			t.Fatal("raw error chain retained")
		}
	}
	wantGet(t, s, "record", "old")
	if _, err := s.db.Exec("DROP TRIGGER refuse_update; DROP TRIGGER refuse_delete"); err != nil {
		t.Fatal(err)
	}
	u := url.URL{Scheme: "file", Path: filepath.Join(dir, persistentDB)}
	other, err := sql.Open("sqlite", u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	other.SetMaxOpenConns(1)
	tx, err := other.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec("UPDATE metadata SET version=version"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	wantKind(t, s.Set("record", "blocked"), ErrBusy)
	if time.Since(start) > 2*time.Second {
		t.Fatal("unbounded SQLite contention wait")
	}
	wantGet(t, s, "record", "old") // WAL reader remains complete during contention.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	err = s.SetContext(ctx, "record", "deadline")
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, ErrBusy) {
		t.Fatalf("deadline: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	mustSet(t, s, "record", "new-complete")
	wantGet(t, s, "record", "new-complete")
}

func TestPersistentTruncatedDatabaseAndOrphanSidecars(t *testing.T) {
	for _, content := range []string{"", "SQLite format 3", "non-sqlite-unknown-format"} {
		t.Run("database-"+content, func(t *testing.T) {
			dir := privateTempDir(t)
			v := &fakeVault{}
			s := testOpen(t, dir, v)
			s.Close()
			path := filepath.Join(dir, persistentDB)
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
			wantKind(t, err, ErrCorrupt)
			if v.sets != 1 {
				t.Fatal("root regenerated for truncated DB")
			}
		})
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		t.Run(suffix, func(t *testing.T) {
			dir := privateTempDir(t)
			path := filepath.Join(dir, persistentDB+suffix)
			if err := os.WriteFile(path, []byte("orphan-ciphertext"), 0o600); err != nil {
				t.Fatal(err)
			}
			v := &fakeVault{}
			_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
			wantKind(t, err, ErrCorrupt)
			if v.gets != 0 || v.sets != 0 {
				t.Fatal("bootstrapped over orphan state")
			}
			b, err := os.ReadFile(path)
			if err != nil || string(b) != "orphan-ciphertext" {
				t.Fatal("orphan modified")
			}
			noDB(t, dir)
		})
	}
}

func TestPersistentCloseJoinsInflightWriteAndClosesZeroValue(t *testing.T) {
	var zero Persistent
	if err := zero.Close(); err != nil {
		t.Fatal(err)
	}
	wantKind(t, zero.Set("a", "b"), ErrClosed)
	dir := privateTempDir(t)
	v := &fakeVault{}
	s := testOpen(t, dir, v)
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	s.deps.beforeWrite = func(*sql.Tx) error { close(entered); <-release; return nil }
	written := make(chan error, 1)
	go func() { written <- s.Set("joined", "complete") }()
	<-entered
	closed := make(chan error, 1)
	go func() { closed <- s.Close() }()
	select {
	case <-closed:
		t.Fatal("Close returned before inflight transaction")
	case <-time.After(20 * time.Millisecond):
	}
	_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
	wantKind(t, err, ErrBusy)
	unblock()
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	s = testOpen(t, dir, v)
	wantGet(t, s, "joined", "complete")
}
