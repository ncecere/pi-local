//go:build darwin || linux

package secrets

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeVault struct {
	mu         sync.Mutex
	items      map[string]string
	gets, sets int
	getHook    func(int, string) (string, error, bool)
	setErr     error
	skipSet    bool
}

func (v *fakeVault) Get(ctx context.Context, name string) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.gets++
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if v.getHook != nil {
		if s, err, handled := v.getHook(v.gets, name); handled {
			return s, err
		}
	}
	s, ok := v.items[name]
	if !ok {
		return "", ErrNotFound
	}
	return s, nil
}
func (v *fakeVault) Set(ctx context.Context, name, value string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.sets++
	if !v.skipSet {
		if v.items == nil {
			v.items = make(map[string]string)
		}
		v.items[name] = value
	}
	return v.setErr
}
func (v *fakeVault) replace(value string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	for k := range v.items {
		v.items[k] = value
	}
}
func privateTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func testOpen(t *testing.T, dir string, v Vault) *Persistent {
	t.Helper()
	s, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return s
}
func mustSet(t *testing.T, s *Persistent, name, value string) {
	t.Helper()
	if err := s.Set(name, value); err != nil {
		t.Fatal(err)
	}
}
func wantGet(t *testing.T, s *Persistent, name, want string) {
	t.Helper()
	got, err := s.Get(name)
	if err != nil || got != want {
		t.Fatalf("get: length=%d want=%d err=%v", len(got), len(want), err)
	}
}
func wantKind(t *testing.T, err, kind error) {
	t.Helper()
	var typed *Error
	if !errors.Is(err, kind) || !errors.As(err, &typed) {
		t.Fatalf("got %v, want typed %v", err, kind)
	}
}
func noDB(t *testing.T, dir string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(dir, persistentDB)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unexpected DB: %v", err)
	}
}

func TestPersistentBoundsReopenAndCompatibility(t *testing.T) {
	dir := privateTempDir(t)
	v := &fakeVault{}
	s := testOpen(t, dir, v)
	if InKeychain(s) || Describe(s).ValuesProtected || Describe(s).Location != LocationUnknown {
		t.Fatal("encrypted rows described as OS vault")
	}
	values := []string{"", strings.Repeat("界", 853), strings.Repeat("界", 853) + "a", strings.Repeat("界", 853) + "ab", strings.Repeat("OAUTH_PAYLOAD_", 5041)[:64*1024], strings.Repeat("z", MaxPersistentValueBytes)}
	for i, value := range values {
		name := fmt.Sprintf("bound-%d", i)
		mustSet(t, s, name, value)
		wantGet(t, s, name, value)
	}
	mustSet(t, s, "preserve", "old")
	wantKind(t, s.Set("preserve", strings.Repeat("x", MaxPersistentValueBytes+1)), ErrTooLarge)
	wantGet(t, s, "preserve", "old")
	maxName := strings.Repeat("界", 1365) + "a"
	mustSet(t, s, maxName, "max-name")
	wantGet(t, s, maxName, "max-name")
	for _, name := range []string{"", strings.Repeat("x", MaxPersistentNameBytes+1), "a\x00b", "\xff"} {
		_, err := s.Get(name)
		wantKind(t, err, ErrInvalidName)
		wantKind(t, s.Set(name, "v"), ErrInvalidName)
		wantKind(t, s.Delete(name), ErrInvalidName)
	}
	if err := s.Delete("missing"); err != nil {
		t.Fatal(err)
	}
	_, err := s.Get("missing")
	wantKind(t, err, ErrNotFound)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = testOpen(t, dir, v)
	for i, value := range values {
		wantGet(t, s, fmt.Sprintf("bound-%d", i), value)
	}
	if v.sets != 1 {
		t.Fatalf("root writes=%d", v.sets)
	}
	for _, root := range v.items {
		if len(root) >= 2560 {
			t.Fatal("root exceeds direct vault bound")
		}
	}
	var memory Memory
	if err := memory.Set("zero", "works"); err != nil {
		t.Fatal(err)
	}
	got, err := memory.Get("zero")
	if got != "works" || err != nil {
		t.Fatal("zero Memory")
	}
}

func TestPersistentRefusesMissingVaultAndUnsafePaths(t *testing.T) {
	for _, vault := range []Vault{nil, (*fakeVault)(nil)} {
		dir := filepath.Join(privateTempDir(t), "absent")
		_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: vault})
		wantKind(t, err, ErrUnavailable)
		if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("nil backend touched disk")
		}
	}
	_, err := OpenPersistent(context.Background(), Options{Vault: &fakeVault{}})
	wantKind(t, err, ErrUnavailable)
	t.Run("private-directory", func(t *testing.T) {
		dir := privateTempDir(t)
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: &fakeVault{}})
		wantKind(t, err, ErrDenied)
		noDB(t, dir)
	})
	for _, child := range []string{"", ".lock", identityFile, persistentDB, persistentDB + "-wal", persistentDB + "-shm", persistentDB + "-journal"} {
		t.Run("symlink-"+child, func(t *testing.T) {
			dir := privateTempDir(t)
			target := filepath.Join(privateTempDir(t), "target")
			if err := os.WriteFile(target, []byte("untouched"), 0o600); err != nil {
				t.Fatal(err)
			}
			path := dir
			if child == "" {
				target = privateTempDir(t)
				path = filepath.Join(privateTempDir(t), "link")
				dir = path
			} else {
				path = filepath.Join(dir, child)
			}
			if err := os.Symlink(target, path); err != nil {
				t.Fatal(err)
			}
			_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: &fakeVault{}})
			wantKind(t, err, ErrDenied)
		})
	}
}

func TestPersistentBootstrapFailures(t *testing.T) {
	for _, persisted := range []bool{false, true} {
		t.Run(fmt.Sprintf("ambiguous-set-%v", persisted), func(t *testing.T) {
			dir := privateTempDir(t)
			v := &fakeVault{setErr: errors.New("secret-value/path/unsafe"), skipSet: !persisted}
			_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
			wantKind(t, err, ErrOutcomeUnknown)
			noDB(t, dir)
			identity, err := os.ReadFile(filepath.Join(dir, identityFile))
			if err != nil {
				t.Fatal(err)
			}
			if v.sets != 1 {
				t.Fatal("unexpected retry")
			}
			v.setErr = nil
			v.skipSet = false
			s := testOpen(t, dir, v)
			mustSet(t, s, "resume", "ok")
			after, _ := os.ReadFile(filepath.Join(dir, identityFile))
			if !bytes.Equal(identity, after) {
				t.Fatal("identity replaced")
			}
			wantSets := 2
			if persisted {
				wantSets = 1
			}
			if v.sets != wantSets {
				t.Fatal("not reconciled through actual Get")
			}
		})
	}
	for _, mode := range []string{"mismatch", "notfound", "denied"} {
		t.Run("readback-"+mode, func(t *testing.T) {
			dir := privateTempDir(t)
			v := &fakeVault{getHook: func(call int, _ string) (string, error, bool) {
				if call != 2 {
					return "", nil, false
				}
				switch mode {
				case "mismatch":
					return "wrong", nil, true
				case "notfound":
					return "", ErrNotFound, true
				default:
					return "", ErrDenied, true
				}
			}}
			_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
			wantKind(t, err, ErrOutcomeUnknown)
			noDB(t, dir)
			v.getHook = nil
			testOpen(t, dir, v)
			if v.sets != 1 {
				t.Fatal("overwrote uncertain root")
			}
		})
	}
	t.Run("denied-get", func(t *testing.T) {
		dir := privateTempDir(t)
		v := &fakeVault{getHook: func(int, string) (string, error, bool) { return "sensitive-partial", ErrDenied, true }}
		_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
		wantKind(t, err, ErrDenied)
		noDB(t, dir)
		if v.sets != 0 {
			t.Fatal("set after denied get")
		}
	})
	t.Run("malformed-root-no-db", func(t *testing.T) {
		for _, root := range []string{"invalid", "pai-root:2:" + strings.Repeat("a", 44), rootPrefix + base64.StdEncoding.EncodeToString(make([]byte, 31))} {
			dir := privateTempDir(t)
			v := &fakeVault{getHook: func(int, string) (string, error, bool) { return root, nil, true }}
			_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
			wantKind(t, err, ErrCorrupt)
			noDB(t, dir)
		}
	})
}

func TestPersistentMissingWrongKeyIdentityAndClone(t *testing.T) {
	t.Run("missing-key", func(t *testing.T) {
		dir := privateTempDir(t)
		v := &fakeVault{}
		s := testOpen(t, dir, v)
		mustSet(t, s, "keep", "ciphertext")
		s.Close()
		before, _ := os.ReadFile(filepath.Join(dir, persistentDB))
		v.items = nil
		_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
		wantKind(t, err, ErrKeyLost)
		after, _ := os.ReadFile(filepath.Join(dir, persistentDB))
		if !bytes.Equal(before, after) || v.sets != 1 {
			t.Fatal("key loss mutated persistent material")
		}
	})
	t.Run("wrong-key", func(t *testing.T) {
		dir := privateTempDir(t)
		v := &fakeVault{}
		s := testOpen(t, dir, v)
		mustSet(t, s, "keep", "old")
		s.Close()
		original := map[string]string{}
		for k, val := range v.items {
			original[k] = val
		}
		v.replace(rootPrefix + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{42}, 32)))
		_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
		wantKind(t, err, ErrCorrupt)
		v.items = original
		s = testOpen(t, dir, v)
		wantGet(t, s, "keep", "old")
	})
	for _, replacement := range []string{"missing", "truncated", "unknown-format", "invalid-uuid"} {
		t.Run("identity-"+replacement, func(t *testing.T) {
			dir := privateTempDir(t)
			v := &fakeVault{}
			s := testOpen(t, dir, v)
			s.Close()
			path := filepath.Join(dir, identityFile)
			if replacement == "missing" {
				os.Remove(path)
			} else {
				text := "truncated"
				if replacement == "unknown-format" {
					b, _ := os.ReadFile(path)
					text = strings.Replace(string(b), ":1:", ":2:", 1)
				}
				if replacement == "invalid-uuid" {
					text = identityPrefix + strings.Repeat("a", 36) + "\n"
				}
				if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			gets := v.gets
			_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
			wantKind(t, err, ErrCorrupt)
			if v.gets != gets {
				t.Fatal("vault called before identity validation")
			}
		})
	}
	t.Run("clone-and-move", func(t *testing.T) {
		dir := privateTempDir(t)
		v := &fakeVault{}
		s := testOpen(t, dir, v)
		mustSet(t, s, "keep", "old")
		s.Close()
		clone := privateTempDir(t)
		for _, file := range []string{identityFile, persistentDB} {
			b, err := os.ReadFile(filepath.Join(dir, file))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(clone, file), b, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		_, err := OpenPersistent(context.Background(), Options{Dir: clone, Vault: v})
		wantKind(t, err, ErrKeyLost)
		moved := filepath.Join(privateTempDir(t), "moved")
		if err := os.Rename(dir, moved); err != nil {
			t.Fatal(err)
		}
		_, err = OpenPersistent(context.Background(), Options{Dir: moved, Vault: v})
		wantKind(t, err, ErrKeyLost)
		if v.sets != 1 {
			t.Fatal("root created for cloned profile")
		}
	})
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("random-secret-diagnostic") }

func TestPersistentRandomFailuresBeforeWrite(t *testing.T) {
	for _, available := range []int{0, 16, 48} {
		t.Run(fmt.Sprint(available), func(t *testing.T) {
			dir := privateTempDir(t)
			v := &fakeVault{}
			rng := io.MultiReader(bytes.NewReader(bytes.Repeat([]byte{7}, available)), failingReader{})
			_, err := openPersistent(context.Background(), Options{Dir: dir, Vault: v}, persistentDeps{random: rng, commit: (*sql.Tx).Commit})
			wantKind(t, err, ErrUnavailable)
			noDB(t, dir)
		})
	}
	dir := privateTempDir(t)
	v := &fakeVault{}
	s := testOpen(t, dir, v)
	mustSet(t, s, "old", "complete")
	s.deps.random = failingReader{}
	wantKind(t, s.Set("old", "new"), ErrUnavailable)
	wantGet(t, s, "old", "complete")
	s.Close()
	s = testOpen(t, dir, v)
	wantGet(t, s, "old", "complete")
}

func rawValue(t *testing.T, s *Persistent, name string) []byte {
	t.Helper()
	var b []byte
	if err := s.db.QueryRow("SELECT value FROM secrets WHERE lookup=?", s.lookup(name)).Scan(&b); err != nil {
		t.Fatal(err)
	}
	return b
}
func TestPersistentNonceAADTamperAndFormat(t *testing.T) {
	s := testOpen(t, privateTempDir(t), &fakeVault{})
	mustSet(t, s, "alpha", "same")
	first := rawValue(t, s, "alpha")
	mustSet(t, s, "alpha", "same")
	second := rawValue(t, s, "alpha")
	if bytes.Equal(first[1:13], second[1:13]) {
		t.Fatal("nonce reused")
	}
	mustSet(t, s, "beta", "other")
	if _, err := s.db.Exec("UPDATE secrets SET value=? WHERE lookup=?", second, s.lookup("beta")); err != nil {
		t.Fatal(err)
	}
	_, err := s.Get("beta")
	wantKind(t, err, ErrCorrupt)
	for _, mode := range []string{"tamper", "truncate", "version", "profile"} {
		t.Run(mode, func(t *testing.T) {
			blob := bytes.Clone(second)
			switch mode {
			case "tamper":
				blob[len(blob)-1] ^= 1
			case "truncate":
				blob = blob[:10]
			case "version":
				blob[0] = 2
			case "profile":
				old := s.profile
				s.profile = "different-profile"
				_, err := s.unseal("value", "alpha", blob)
				s.profile = old
				wantKind(t, err, ErrCorrupt)
				return
			}
			if _, err := s.db.Exec("UPDATE secrets SET value=? WHERE lookup=?", blob, s.lookup("alpha")); err != nil {
				t.Fatal(err)
			}
			_, err := s.Get("alpha")
			wantKind(t, err, ErrCorrupt)
		})
	}
	for _, update := range []string{"UPDATE metadata SET version=2", "UPDATE metadata SET profile='different'", "UPDATE metadata SET keycheck=x'01'", "DELETE FROM metadata"} {
		t.Run(update, func(t *testing.T) {
			dir := privateTempDir(t)
			v := &fakeVault{}
			s := testOpen(t, dir, v)
			mustSet(t, s, "old", "value")
			if _, err := s.db.Exec(update); err != nil {
				t.Fatal(err)
			}
			_, err := s.Get("old")
			wantKind(t, err, ErrCorrupt)
			wantKind(t, s.Set("new", "value"), ErrCorrupt)
			wantKind(t, s.Delete("old"), ErrCorrupt)
			s.Close()
			_, err = OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
			wantKind(t, err, ErrCorrupt)
		})
	}
}

func TestPersistentRawDiskHasNoPlaintext(t *testing.T) {
	dir := privateTempDir(t)
	v := &fakeVault{}
	s := testOpen(t, dir, v)
	name := "DISTINCT_LOGICAL_SECRET_NAME_do_not_write_me"
	value := strings.Repeat("DISTINCT_SECRET_VALUE_do_not_write_me", 2048)
	mustSet(t, s, name, value)
	mustSet(t, s, name, value+"updated")
	patterns := [][]byte{[]byte(name), []byte(value[:100]), []byte(value)}
	for _, root := range v.items {
		raw, err := decodeRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		patterns = append(patterns, []byte(root), raw, []byte(strings.TrimPrefix(root, rootPrefix)))
	}
	scan := func() {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			path := filepath.Join(dir, entry.Name())
			info, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
				t.Fatal("nonprivate file")
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			for _, pattern := range patterns {
				if bytes.Contains(data, pattern) {
					t.Fatalf("plaintext material in %s", entry.Name())
				}
			}
		}
	}
	scan() // Includes live SQLite WAL/SHM, not merely a checkpointed database.
	s.Close()
	scan()
	s = testOpen(t, dir, v)
	wantGet(t, s, name, value+"updated")
}

func TestPersistentTransactionsAmbiguousCommitAndReopen(t *testing.T) {
	for _, operation := range []string{"set", "delete"} {
		for _, committed := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s-%v", operation, committed), func(t *testing.T) {
				dir := privateTempDir(t)
				v := &fakeVault{}
				s := testOpen(t, dir, v)
				old := strings.Repeat("old", 22000)
				newValue := strings.Repeat("new", 22000)
				mustSet(t, s, "record", old)
				s.deps.beforeWrite = func(*sql.Tx) error { return errors.New("RAW_SECRET_SQL_ERROR") }
				wantKind(t, s.Set("record", newValue), ErrBackend)
				wantGet(t, s, "record", old)
				s.deps.beforeWrite = nil
				s.deps.commit = func(tx *sql.Tx) error {
					if committed {
						if err := tx.Commit(); err != nil {
							return err
						}
					}
					return errors.New("RAW_SECRET_COMMIT_ERROR")
				}
				var err error
				if operation == "set" {
					err = s.Set("record", newValue)
				} else {
					err = s.Delete("record")
				}
				wantKind(t, err, ErrOutcomeUnknown)
				if strings.Contains(err.Error(), "RAW_SECRET") {
					t.Fatal("raw commit error retained")
				}
				s.Close()
				s = testOpen(t, dir, v)
				if !committed {
					wantGet(t, s, "record", old)
				} else if operation == "set" {
					wantGet(t, s, "record", newValue)
				} else {
					_, err := s.Get("record")
					wantKind(t, err, ErrNotFound)
				}
			})
		}
	}
	t.Run("bootstrap-commit-ambiguity", func(t *testing.T) {
		for _, committed := range []bool{false, true} {
			dir := privateTempDir(t)
			v := &fakeVault{}
			deps := persistentDeps{random: rand.Reader, commit: func(tx *sql.Tx) error {
				if committed {
					if err := tx.Commit(); err != nil {
						return err
					}
				}
				return errors.New("ambiguous")
			}}
			_, err := openPersistent(context.Background(), Options{Dir: dir, Vault: v}, deps)
			wantKind(t, err, ErrOutcomeUnknown)
			if committed {
				testOpen(t, dir, v)
			} else {
				_, err = OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
				wantKind(t, err, ErrCorrupt)
			}
			if v.sets != 1 {
				t.Fatal("replaced root")
			}
		}
	})
}

func TestPersistentConcurrentCloseContextAndLock(t *testing.T) {
	dir := privateTempDir(t)
	v := &fakeVault{}
	s := testOpen(t, dir, v)
	_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
	wantKind(t, err, ErrBusy)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = s.GetContext(ctx, "a")
	wantKind(t, err, context.Canceled)
	wantKind(t, s.SetContext(ctx, "a", "b"), context.Canceled)
	<-s.gate
	deadline, stop := context.WithTimeout(context.Background(), 10*time.Millisecond)
	_, err = s.GetContext(deadline, "a")
	stop()
	wantKind(t, err, context.DeadlineExceeded)
	s.leave()
	start := make(chan struct{})
	var wg sync.WaitGroup
	for worker := 0; worker < 12; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for i := 0; i < 40; i++ {
				value, err := s.Get("shared")
				if err == nil && value != "complete-old" && value != "complete-new" {
					t.Error("partial read")
				}
				if err != nil && !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrClosed) {
					t.Error(err)
				}
				err = s.Set("shared", "complete-new")
				if err != nil && !errors.Is(err, ErrClosed) {
					t.Error(err)
				}
				err = s.Delete("shared")
				if err != nil && !errors.Is(err, ErrClosed) {
					t.Error(err)
				}
			}
		}()
	}
	mustSet(t, s, "shared", "complete-old")
	close(start)
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	}()
	wg.Wait()
	wantKind(t, s.Set("closed", "value"), ErrClosed)
	_, err = s.Get("closed")
	wantKind(t, err, ErrClosed)
	wantKind(t, s.Delete("closed"), ErrClosed)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = testOpen(t, dir, v)
	mustSet(t, s, "reopened", "ok")
}

// The crash fixture uses a PUBLIC deterministic test key returned from memory.
// It never writes a fake plaintext root-key file for subprocess convenience.
type publicTestVault struct{}

func (publicTestVault) Get(context.Context, string) (string, error) {
	return rootPrefix + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xA5}, 32)), nil
}
func (publicTestVault) Set(context.Context, string, string) error {
	return errors.New("unexpected public test key write")
}
func TestPersistentCrashHelper(t *testing.T) {
	if os.Getenv("PAI_SECRET_TEST_HELPER") != "1" {
		return
	}
	dir := os.Getenv("PAI_SECRET_TEST_DIR")
	if !filepath.IsAbs(dir) {
		t.Fatal("explicit fixture directory required")
	}
	s, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: publicTestVault{}})
	if err != nil {
		t.Fatal(err)
	}
	s.deps.commit = func(tx *sql.Tx) error {
		if os.Getenv("PAI_SECRET_TEST_COMMIT") == "1" {
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
		}
		os.Exit(0)
		return nil
	}
	if err := s.Set("crash-record", strings.Repeat("new-complete-", 6000)); err != nil {
		t.Fatal(err)
	}
	t.Fatal("crash hook not reached")
}
func TestPersistentProcessCrashOldOrNewAndLockRelease(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, committed := range []bool{false, true} {
		t.Run(fmt.Sprint(committed), func(t *testing.T) {
			dir := privateTempDir(t)
			s := testOpen(t, dir, publicTestVault{})
			old := strings.Repeat("old-complete-", 6000)
			mustSet(t, s, "crash-record", old)
			s.Close()
			commit := "0"
			if committed {
				commit = "1"
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, executable, "-test.run=^TestPersistentCrashHelper$")
			cmd.Env = append(os.Environ(), "PAI_SECRET_TEST_HELPER=1", "PAI_SECRET_TEST_DIR="+dir, "PAI_SECRET_TEST_COMMIT="+commit)
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("fixture: %v %s", err, output)
			}
			s = testOpen(t, dir, publicTestVault{})
			want := old
			if committed {
				want = strings.Repeat("new-complete-", 6000)
			}
			wantGet(t, s, "crash-record", want)
		})
	}
}
