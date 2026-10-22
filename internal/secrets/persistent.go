package secrets

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ncecere/pi-local/internal/datalock"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

const (
	MaxPersistentNameBytes  = 4 * 1024
	MaxPersistentValueBytes = 128 * 1024
	persistentTimeout       = 5 * time.Second
	identityFile            = "identity-v1"
	persistentDB            = "secrets.db"
	identityPrefix          = "pai-private-secrets:1:"
	rootPrefix              = "pai-root:1:"
	keycheckPlaintext       = "pai-private-secrets/keycheck/v1"
	// Allows a maximum ciphertext (value + 29 bytes), its 32-byte lookup,
	// and SQLite record headers, with conservative sub-KiB headroom. Names
	// never enter SQL. This is a per-connection result/record bound, not a
	// general SQLite memory, schema, or query-work budget.
	persistentSQLMaxLength = MaxPersistentValueBytes + 1024
)

// Vault is an explicitly injected root-key backend. Get must return ErrNotFound
// only for an absent item; both methods must honor context cancellation. This
// package supplies no OS adapter and never substitutes Keychain for a nil Vault.
// A Set error does not establish whether the item was persisted.
type Vault interface {
	Get(context.Context, string) (string, error)
	Set(context.Context, string, string) error
}

// Options has no default directory or vault. Dir must be a dedicated, private
// directory (or a nonexistent child of an existing directory). No migration,
// export, key rotation, or recovery is performed.
type Options struct {
	Dir   string
	Vault Vault
}

// Persistent is an encrypted, profile-bound Store, not an OS-vault value store.
// Operations and Close are serialized. Do not copy it; use OpenPersistent.
// Operations use a five-second context budget; context variants can shorten it.
// This cannot preempt blocking filesystem calls or a noncooperative Vault.
type Persistent struct {
	gate      chan struct{}
	closed    bool
	closeErr  error
	db        *sql.DB
	lock      *datalock.Lock
	profile   string
	aead      cipher.AEAD
	lookupKey []byte
	deps      persistentDeps
}

// Private instance-local fault seams; never accepted through the public API.
type persistentDeps struct {
	random      io.Reader
	commit      func(*sql.Tx) error
	beforeWrite func(*sql.Tx) error
	fileSync    func(*os.File) error
	dirSync     func(string) error
}

func (d persistentDeps) syncFile(f *os.File) error {
	if d.fileSync != nil {
		return d.fileSync(f)
	}
	return f.Sync()
}

func (d persistentDeps) syncDir(path string) error {
	if d.dirSync != nil {
		return d.dirSync(path)
	}
	return syncDirectory(path)
}

// OpenPersistent locks Dir for its lifetime, durably establishes profile identity,
// verifies the injected vault root key, then opens a separate encrypted database.
// Existing database + absent root key always fails with ErrKeyLost. No filesystem
// key or plaintext fallback exists. Windows is intentionally unsupported pending
// native ACL/durability acceptance. Errors never retain backend diagnostic text.
func OpenPersistent(ctx context.Context, opts Options) (*Persistent, error) {
	return openPersistent(ctx, opts, persistentDeps{random: rand.Reader, commit: (*sql.Tx).Commit})
}

func failure(op string, kind error) error { return &Error{Op: op, kind: kind} }

func openPersistent(ctx context.Context, opts Options, deps persistentDeps) (_ *Persistent, result error) {
	ctx, cancel := context.WithTimeout(ctx, persistentTimeout)
	defer cancel()
	if opts.Vault == nil || nilInterface(opts.Vault) || opts.Dir == "" {
		return nil, failure("open", ErrUnavailable)
	}
	if err := ctx.Err(); err != nil {
		return nil, failure("open", err)
	}
	dir, err := preparePrivateDir(opts.Dir, deps)
	if err != nil {
		return nil, failure("open", err)
	}
	for _, name := range []string{".lock", identityFile, persistentDB, persistentDB + "-wal", persistentDB + "-shm", persistentDB + "-journal"} {
		if err := privateFile(filepath.Join(dir, name)); err != nil {
			return nil, failure("open", err)
		}
	}
	lock, err := datalock.Acquire(dir)
	if err != nil {
		if errors.Is(err, datalock.ErrLocked) {
			return nil, failure("open", ErrBusy)
		}
		return nil, failure("open", ErrUnavailable)
	}
	s := &Persistent{gate: make(chan struct{}, 1), lock: lock, deps: deps}
	s.gate <- struct{}{}
	defer func() {
		if result != nil {
			s.Close()
		}
	}()
	dbPath := filepath.Join(dir, persistentDB)
	_, err = os.Lstat(dbPath)
	exists := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, failure("open", ErrUnavailable)
	}
	if !exists {
		for _, suffix := range []string{"-wal", "-shm", "-journal"} {
			if _, sidecarErr := os.Lstat(dbPath + suffix); !errors.Is(sidecarErr, os.ErrNotExist) {
				return nil, failure("open", ErrCorrupt)
			}
		}
	}
	profile, err := loadIdentity(dir, exists, deps)
	if err != nil {
		return nil, failure("open", err)
	}
	s.profile = profile
	pathHash := sha256.Sum256([]byte(dir))
	keyName := "pai-private-secrets/v1/" + profile + "/" + hex.EncodeToString(pathHash[:])
	encoded, err := opts.Vault.Get(ctx, keyName)
	if errors.Is(err, ErrNotFound) {
		if exists {
			return nil, failure("open", ErrKeyLost)
		}
		root := make([]byte, 32)
		defer clear(root)
		if _, err = io.ReadFull(deps.random, root); err != nil {
			return nil, failure("open", ErrUnavailable)
		}
		encoded = rootPrefix + base64.StdEncoding.EncodeToString(root)
		clear(root)
		if err = opts.Vault.Set(ctx, keyName, encoded); err != nil {
			return nil, failure("open", ErrOutcomeUnknown)
		}
		readback, getErr := opts.Vault.Get(ctx, keyName)
		if getErr != nil || !hmac.Equal([]byte(readback), []byte(encoded)) {
			return nil, failure("open", ErrOutcomeUnknown)
		}
	} else if err != nil {
		if ctx.Err() != nil {
			return nil, failure("open", ctx.Err())
		}
		return nil, safeError("open", err)
	}
	root, err := decodeRoot(encoded)
	if err != nil {
		return nil, failure("open", ErrCorrupt)
	}
	defer clear(root)
	encKey, err := hkdf.Key(sha256.New, root, []byte(profile), "pai-private-secrets/v1/encryption", 32)
	if err != nil {
		return nil, failure("open", ErrBackend)
	}
	defer clear(encKey)
	s.lookupKey, err = hkdf.Key(sha256.New, root, []byte(profile), "pai-private-secrets/v1/lookup", 32)
	if err != nil {
		return nil, failure("open", ErrBackend)
	}
	block, err := aes.NewCipher(encKey)
	if err != nil {
		return nil, failure("open", ErrBackend)
	}
	s.aead, err = cipher.NewGCM(block)
	if err != nil {
		return nil, failure("open", ErrBackend)
	}
	if err := ctx.Err(); err != nil {
		return nil, failure("open", err)
	}
	var initialCheck []byte
	if !exists {
		initialCheck, err = s.seal("keycheck", "", keycheckPlaintext)
		if err != nil {
			return nil, err
		}
	}
	// Precreate privately only AFTER root verification. Never repair or delete an
	// existing/partially initialized DB: that requires explicit future recovery.
	if !exists {
		f, err := os.OpenFile(dbPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
		if err != nil {
			return nil, failure("open", ErrUnavailable)
		}
		syncErr := deps.syncFile(f)
		closeErr := f.Close()
		if syncErr != nil || closeErr != nil || deps.syncDir(dir) != nil {
			return nil, failure("open", ErrOutcomeUnknown)
		}
	}
	u := url.URL{Scheme: "file", Path: dbPath}
	q := u.Query()
	q.Set("mode", "rw")
	q.Add("_pragma", "busy_timeout(100)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(FULL)")
	q.Add("_pragma", "temp_store(MEMORY)")
	u.RawQuery = q.Encode()
	s.db, err = sql.Open("sqlite", u.String())
	if err != nil {
		return nil, failure("open", ErrUnavailable)
	}
	s.db.SetMaxOpenConns(1)
	s.db.SetMaxIdleConns(1)
	conn, err := s.boundedConn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if !exists {
		err = s.initialize(ctx, conn, initialCheck)
	} else {
		err = s.verify(ctx, conn)
	}
	if err != nil {
		return nil, err
	}
	if err = deps.syncDir(dir); err != nil {
		return nil, failure("open", ErrOutcomeUnknown)
	}
	return s, nil
}

func nilInterface(v any) bool {
	r := reflect.ValueOf(v)
	switch r.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return r.IsNil()
	}
	return false
}

func decodeRoot(encoded string) ([]byte, error) {
	if len(encoded) != len(rootPrefix)+44 || !strings.HasPrefix(encoded, rootPrefix) {
		return nil, ErrCorrupt
	}
	root, err := base64.StdEncoding.Strict().DecodeString(strings.TrimPrefix(encoded, rootPrefix))
	if err != nil || len(root) != 32 {
		clear(root)
		return nil, ErrCorrupt
	}
	return root, nil
}

func loadIdentity(dir string, dbExists bool, deps persistentDeps) (string, error) {
	path := filepath.Join(dir, identityFile)
	f, err := os.Open(path)
	if err == nil {
		b, readErr := io.ReadAll(io.LimitReader(f, 128))
		syncErr := deps.syncFile(f)
		closeErr := f.Close()
		if readErr != nil || syncErr != nil || closeErr != nil {
			return "", ErrUnavailable
		}
		text := string(b)
		if len(text) != len(identityPrefix)+36+1 || !strings.HasPrefix(text, identityPrefix) || !strings.HasSuffix(text, "\n") {
			return "", ErrCorrupt
		}
		id := strings.TrimSuffix(strings.TrimPrefix(text, identityPrefix), "\n")
		if !validUUID(id) {
			return "", ErrCorrupt
		}
		// Re-sync on every open: an earlier ambiguous identity rename must become
		// durable before any later attempt at vault bootstrap.
		if deps.syncDir(dir) != nil {
			return "", ErrUnavailable
		}
		return id, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", ErrUnavailable
	}
	if dbExists {
		return "", ErrCorrupt
	}
	b := make([]byte, 16)
	if _, err := io.ReadFull(deps.random, b); err != nil {
		return "", ErrUnavailable
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	id := h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
	tmp, err := os.CreateTemp(dir, ".identity-*")
	if err != nil {
		return "", ErrUnavailable
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // Only our own nonsecret temporary identity.
	_, writeErr := tmp.WriteString(identityPrefix + id + "\n")
	syncErr := deps.syncFile(tmp)
	closeErr := tmp.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return "", ErrUnavailable
	}
	if os.Rename(tmpName, path) != nil {
		return "", ErrOutcomeUnknown
	}
	if deps.syncDir(dir) != nil {
		return "", ErrOutcomeUnknown
	}
	return id, nil
}

func validUUID(s string) bool {
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' || s[14] != '4' || !strings.ContainsRune("89ab", rune(s[19])) {
		return false
	}
	raw := strings.ReplaceAll(s, "-", "")
	_, err := hex.DecodeString(raw)
	return err == nil && raw == strings.ToLower(raw)
}

func (s *Persistent) aad(domain, name string) []byte {
	var b bytes.Buffer
	for _, field := range []string{"pai-private-secrets", "1", domain, s.profile, name} {
		_ = binary.Write(&b, binary.BigEndian, uint32(len(field)))
		b.WriteString(field)
	}
	return b.Bytes()
}

func (s *Persistent) seal(domain, name, value string) ([]byte, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := io.ReadFull(s.deps.random, nonce); err != nil {
		return nil, failure("set", ErrUnavailable)
	}
	out := append([]byte{1}, nonce...)
	return s.aead.Seal(out, nonce, []byte(value), s.aad(domain, name)), nil
}

func (s *Persistent) unseal(domain, name string, blob []byte) (string, error) {
	n := s.aead.NonceSize()
	if len(blob) < 1+n+s.aead.Overhead() || len(blob) > 1+n+s.aead.Overhead()+MaxPersistentValueBytes || blob[0] != 1 {
		return "", failure("get", ErrCorrupt)
	}
	plain, err := s.aead.Open(nil, blob[1:1+n], blob[1+n:], s.aad(domain, name))
	if err != nil {
		return "", failure("get", ErrCorrupt)
	}
	defer clear(plain)
	return string(plain), nil
}

func (s *Persistent) lookup(name string) []byte {
	h := hmac.New(sha256.New, s.lookupKey)
	h.Write([]byte(name))
	return h.Sum(nil)
}

// boundedConn configures and checks the actual connection used by the caller.
// Reapply on EVERY checkout: database/sql can discard and replace connections.
// No global driver hook or other database's connection is affected. Callers must
// close rows/finish transactions before returning this connection to the pool.
func (s *Persistent) boundedConn(ctx context.Context) (*sql.Conn, error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, dbError("connection", ctx, err)
	}
	if _, err = sqlite.Limit(conn, sqlite3.SQLITE_LIMIT_LENGTH, persistentSQLMaxLength); err == nil {
		var actual int
		actual, err = sqlite.Limit(conn, sqlite3.SQLITE_LIMIT_LENGTH, -1)
		if err == nil && actual == persistentSQLMaxLength {
			return conn, nil
		}
	}
	conn.Close()
	return nil, failure("connection", ErrUnavailable)
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *Persistent) verify(ctx context.Context, q queryer) error {
	var version int
	var profile string
	var check []byte
	checkBytes := 1 + s.aead.NonceSize() + s.aead.Overhead() + len(keycheckPlaintext)
	// Guard types and exact field sizes inside SQLite, before the driver/Scan
	// materializes them. NULL is an invalid sentinel, never a truncated value.
	// The connection limit also bounds computed view expressions/record sizes.
	err := q.QueryRowContext(ctx, `SELECT
CASE WHEN typeof(version)='integer' THEN version END,
CASE WHEN typeof(profile)='text' AND length(CAST(profile AS BLOB))=36 AND profile=? THEN profile END,
CASE WHEN typeof(keycheck)='blob' AND length(keycheck)=? THEN keycheck END
FROM metadata WHERE id=1`, s.profile, checkBytes).Scan(&version, &profile, &check)
	if err != nil {
		classified := dbError("verify", ctx, err)
		if !errors.Is(classified, ErrBackend) {
			return classified
		}
		return failure("verify", ErrCorrupt)
	}
	if version != 1 || profile != s.profile || !validUUID(profile) || len(check) != checkBytes {
		return failure("verify", ErrCorrupt)
	}
	plain, err := s.unseal("keycheck", "", check)
	if err != nil || plain != keycheckPlaintext {
		return failure("verify", ErrCorrupt)
	}
	return nil
}

func (s *Persistent) initialize(ctx context.Context, conn *sql.Conn, check []byte) error {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return dbError("open", ctx, err)
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, profile TEXT NOT NULL, keycheck BLOB NOT NULL);
CREATE TABLE secrets (lookup BLOB PRIMARY KEY CHECK(length(lookup)=32), value BLOB NOT NULL) WITHOUT ROWID;`)
	if err == nil {
		_, err = tx.ExecContext(ctx, "INSERT INTO metadata VALUES(1,1,?,?)", s.profile, check)
	}
	if err != nil {
		return dbError("open", ctx, err)
	}
	return s.commit(tx, "open")
}

func dbError(op string, ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return failure(op, ctx.Err())
	}
	var coded interface{ Code() int }
	if errors.As(err, &coded) {
		switch coded.Code() & 255 {
		case 5, 6:
			return failure(op, ErrBusy)
		case 11, sqlite3.SQLITE_TOOBIG, 26:
			return failure(op, ErrCorrupt)
		}
	}
	return failure(op, ErrBackend)
}

func (s *Persistent) commit(tx *sql.Tx, op string) error {
	if err := s.deps.commit(tx); err != nil {
		return failure(op, ErrOutcomeUnknown)
	}
	return nil
}

func validateName(name string) error {
	if len(name) == 0 || len(name) > MaxPersistentNameBytes || !utf8.ValidString(name) || strings.ContainsRune(name, 0) {
		return failure("validate", ErrInvalidName)
	}
	return nil
}

func (s *Persistent) enter(ctx context.Context) error {
	if s.gate == nil {
		return failure("operation", ErrClosed)
	}
	select {
	case <-ctx.Done():
		return failure("operation", ctx.Err())
	case <-s.gate:
	}
	if s.closed {
		s.leave()
		return failure("operation", ErrClosed)
	}
	if err := ctx.Err(); err != nil {
		s.leave()
		return failure("operation", err)
	}
	return nil
}
func (s *Persistent) leave() { s.gate <- struct{}{} }

func (s *Persistent) Get(name string) (string, error) {
	return s.GetContext(context.Background(), name)
}
func (s *Persistent) Set(name, value string) error {
	return s.SetContext(context.Background(), name, value)
}
func (s *Persistent) Delete(name string) error { return s.DeleteContext(context.Background(), name) }

func (s *Persistent) GetContext(ctx context.Context, name string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, persistentTimeout)
	defer cancel()
	if err := validateName(name); err != nil {
		return "", err
	}
	if err := s.enter(ctx); err != nil {
		return "", err
	}
	defer s.leave()
	conn, err := s.boundedConn(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	if err := s.verify(ctx, conn); err != nil {
		return "", err
	}
	var blob []byte
	overhead := 1 + s.aead.NonceSize() + s.aead.Overhead()
	err = conn.QueryRowContext(ctx, `SELECT CASE
WHEN typeof(value)='blob' AND length(value) BETWEEN ? AND ? THEN value END
FROM secrets WHERE lookup=?`, overhead, overhead+MaxPersistentValueBytes, s.lookup(name)).Scan(&blob)
	if errors.Is(err, sql.ErrNoRows) {
		return "", failure("get", ErrNotFound)
	}
	if err != nil {
		return "", dbError("get", ctx, err)
	}
	return s.unseal("value", name, blob)
}

func (s *Persistent) SetContext(ctx context.Context, name, value string) error {
	if len(value) > MaxPersistentValueBytes {
		return &Error{Op: "set", kind: ErrTooLarge, MaxValueBytes: MaxPersistentValueBytes}
	}
	return s.write(ctx, name, &value)
}
func (s *Persistent) DeleteContext(ctx context.Context, name string) error {
	return s.write(ctx, name, nil)
}

func (s *Persistent) write(ctx context.Context, name string, value *string) error {
	ctx, cancel := context.WithTimeout(ctx, persistentTimeout)
	defer cancel()
	if err := validateName(name); err != nil {
		return err
	}
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.leave()
	op := "delete"
	var blob []byte
	var err error
	if value != nil {
		op = "set"
		blob, err = s.seal("value", name, *value)
		if err != nil {
			return err
		}
	}
	conn, err := s.boundedConn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return dbError(op, ctx, err)
	}
	defer tx.Rollback()
	if err = s.verify(ctx, tx); err != nil {
		return err
	}
	if s.deps.beforeWrite != nil {
		if err = s.deps.beforeWrite(tx); err != nil {
			return dbError(op, ctx, err)
		}
	}
	if value == nil {
		_, err = tx.ExecContext(ctx, "DELETE FROM secrets WHERE lookup=?", s.lookup(name))
	} else {
		_, err = tx.ExecContext(ctx, "INSERT INTO secrets(lookup,value) VALUES(?,?) ON CONFLICT(lookup) DO UPDATE SET value=excluded.value", s.lookup(name), blob)
	}
	if err != nil {
		return dbError(op, ctx, err)
	}
	return s.commit(tx, op)
}

// Close joins active operations, closes SQLite before releasing directory
// exclusivity, and is idempotent. Clearing derived byte slices is best effort:
// Go strings, AES schedules, runtime/SQLite copies and swapped pages are not
// guaranteed zeroized or locked. Close failures are sanitized and stable.
func (s *Persistent) Close() error {
	if s.gate == nil {
		return nil
	}
	<-s.gate
	defer s.leave()
	if s.closed {
		return s.closeErr
	}
	s.closed = true
	if s.db != nil {
		if s.db.Close() != nil {
			s.closeErr = failure("close", ErrBackend)
		}
	}
	clear(s.lookupKey)
	s.aead = nil
	if s.lock != nil {
		if s.lock.Close() != nil {
			s.closeErr = failure("close", ErrBackend)
		}
	}
	return s.closeErr
}

var _ Store = (*Persistent)(nil)
