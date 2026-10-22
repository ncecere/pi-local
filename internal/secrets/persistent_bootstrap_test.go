//go:build darwin || linux

package secrets

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestPersistentBootstrapDirectorySyncFailures(t *testing.T) {
	// Parent, identity rename, DB creation, committed DB directory sync.
	for stage := 1; stage <= 4; stage++ {
		t.Run(fmt.Sprint(stage), func(t *testing.T) {
			dir := privateTempDir(t)
			v := &fakeVault{}
			calls := 0
			deps := persistentDeps{random: rand.Reader, commit: (*sql.Tx).Commit, dirSync: func(path string) error {
				calls++
				if calls == stage {
					return errors.New("RAW_PRIVATE_SYNC_DIAGNOSTIC")
				}
				return syncDirectory(path)
			}}
			_, err := openPersistent(context.Background(), Options{Dir: dir, Vault: v}, deps)
			kind := ErrOutcomeUnknown
			if stage == 1 {
				kind = ErrUnavailable
			}
			wantKind(t, err, kind)
			if calls != stage {
				t.Fatal("continued after durability failure")
			}
			if stage <= 2 {
				noDB(t, dir)
				if v.gets != 0 || v.sets != 0 {
					t.Fatal("vault contacted before durable identity")
				}
			} else if v.sets != 1 {
				t.Fatal("root not retained")
			}
			// Failure after identity rename must retain that identity. Failure
			// after DB creation must retain even an incompletely initialized DB.
			if stage >= 2 {
				if _, err := os.Stat(filepath.Join(dir, identityFile)); err != nil {
					t.Fatal("lost identity")
				}
			}
			if stage == 3 {
				_, err = OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
				wantKind(t, err, ErrCorrupt)
				if v.sets != 1 {
					t.Fatal("root regenerated for incomplete database")
				}
			} else {
				s := testOpen(t, dir, v)
				mustSet(t, s, "reconciled", "complete")
				if v.sets != 1 {
					t.Fatal("unexpected root replacement")
				}
			}
		})
	}
}

func TestPersistentBootstrapFileSyncFailures(t *testing.T) {
	for stage := 1; stage <= 2; stage++ {
		t.Run(fmt.Sprint(stage), func(t *testing.T) {
			dir := privateTempDir(t)
			v := &fakeVault{}
			calls := 0
			deps := persistentDeps{random: rand.Reader, commit: (*sql.Tx).Commit, fileSync: func(f *os.File) error {
				calls++
				if calls == stage {
					return errors.New("RAW_FILE_SYNC_DIAGNOSTIC")
				}
				return f.Sync()
			}}
			_, err := openPersistent(context.Background(), Options{Dir: dir, Vault: v}, deps)
			if stage == 1 {
				wantKind(t, err, ErrUnavailable)
				noDB(t, dir)
				if v.gets != 0 || v.sets != 0 {
					t.Fatal("vault contacted before synced identity")
				}
				entries, err := os.ReadDir(dir)
				if err != nil {
					t.Fatal(err)
				}
				for _, entry := range entries {
					if entry.Name() != ".lock" {
						t.Fatal("failed identity temporary file retained")
					}
				}
				testOpen(t, dir, v)
			} else {
				wantKind(t, err, ErrOutcomeUnknown)
				if _, err := os.Stat(filepath.Join(dir, persistentDB)); err != nil {
					t.Fatal("removed ambiguous database")
				}
				_, err = OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
				wantKind(t, err, ErrCorrupt)
				if v.sets != 1 {
					t.Fatal("root regenerated")
				}
			}
		})
	}
	t.Run("reopen-identity-sync", func(t *testing.T) {
		dir := privateTempDir(t)
		v := &fakeVault{}
		s := testOpen(t, dir, v)
		s.Close()
		gets := v.gets
		deps := persistentDeps{random: rand.Reader, commit: (*sql.Tx).Commit, fileSync: func(*os.File) error { return errors.New("sync") }}
		_, err := openPersistent(context.Background(), Options{Dir: dir, Vault: v}, deps)
		wantKind(t, err, ErrUnavailable)
		if v.gets != gets {
			t.Fatal("vault contacted before identity re-sync")
		}
		testOpen(t, dir, v)
	})
}
