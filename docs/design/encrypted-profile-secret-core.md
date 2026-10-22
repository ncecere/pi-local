# Encrypted-profile secret core (unwired)

This slice adds only `internal/secrets.OpenPersistent(ctx, Options{Dir, Vault})`.
No application initialization, frontend, backup/restore whitelist, runtime,
OS-vault adapter, provider, dependency, workflow, or release behavior is changed.
There is no default directory, automatic Keychain, legacy read-through, import,
activation, key export, reset, recovery, or rotation. `Store` remains Get/Set/Delete;
Keychain remains a direct-vault store, and Memory supports its zero value.

## Boundary and representation

- The caller must explicitly choose a dedicated private local directory and
  inject a contextual `Vault` offering Get/Set. Nil (including typed nil) is
  refused before filesystem activity. Get must distinguish ErrNotFound from
  access/backend failure; adapters must honor context cancellation. No adapter
  implementation is included here.
- On Darwin/Linux, directories must be owner-owned with no group/other access.
  Existing known files must be owner-owned, private, regular, single-link files;
  final-directory and known-file symlinks are refused. An absent directory may
  be created as one child of an existing parent; the parent is synced. Ancestor
  aliases resolve to a canonical path. This assumes a trusted owner and a local
  filesystem: it does not defend against a malicious same-UID process replacing
  files or ancestors, privileged access, network filesystem semantics, or an
  attacker controlling the running process.
- `internal/datalock` owns `.lock` for the store's entire lifetime. The lock file
  is never removed/replaced. Local operations and Close share a context-aware
  serialization gate; SQLite has one connection and a 100 ms busy timeout.
  Operations use a five-second context budget (or a shorter caller deadline),
  including gate waits. Blocking filesystem calls and a noncooperative injected
  vault are not forcibly cancellable. Close joins operations without a deadline.
- `identity-v1` contains a strict versioned random UUIDv4, not secret material.
  Creation uses a private temporary file, file sync, rename, then directory sync.
  Reopen syncs identity and directory again before contacting the vault. The
  vault item name includes UUID and SHA-256 of the canonical directory. A copied
  or moved store cannot silently acquire a new key; migration is future work.
- The vault holds one `pai-root:1:<standard-base64>` item: 32 random root bytes,
  55 encoded bytes, below the pinned direct-vault 2560-byte Windows limit. No
  per-record vault items or vault deletes exist. HKDF-SHA256 (Go standard library)
  derives independent 32-byte encryption and lookup keys, with profile salt and
  different versioned info labels.
- Dedicated `secrets.db` uses the already-pinned modernc SQLite, WAL, FULL sync,
  and memory temp storage; never `app.db`. SQL sees HMAC-SHA256 lookup tokens, not
  logical names. Each value is AES-256-GCM encrypted with a fresh random 12-byte
  nonce. Blob layout is version byte 1, nonce, ciphertext plus GCM tag. AAD is
  five big-endian uint32-length-prefixed fields: package domain, format version,
  purpose (value/keycheck), profile UUID, logical name. The metadata keycheck is
  separately purpose-bound. Version, UUID and keycheck are verified before every
  operation, with writes verified inside their transaction.
- Every SQLite connection checkout installs and reads back `SQLITE_LIMIT_LENGTH`
  at 132096 bytes (128 KiB + 1024). The headroom covers a maximum ciphertext
  (plaintext + 29 bytes), its 32-byte lookup and SQLite record headers. Bootstrap,
  reads and write transactions use that same checked-out connection until rows
  close and transactions finish; a replacement connection is configured again.
  This is local to this store, with no global driver hooks or other DB changes.
  SQL CASE guards check result types and sizes before Scan: metadata requires an
  integer version, matching 36-byte text UUID, and exactly sized blob keycheck;
  values require blobs within the encrypted-value bounds. Invalid fields return
  an invalid NULL sentinel, never a truncated accepted value. SQLite TOOBIG is
  sanitized to ErrCorrupt. The persisted format and accepted value sizes do not
  change.
- Names must be nonempty, valid UTF-8, NUL-free, and at most 4096 bytes. Values
  are arbitrary strings up to 131072 bytes, including empty/binary strings; no
  truncation. Each Set/Delete uses a transaction. Delete missing is idempotent;
  there is no legacy fallback requiring tombstones.
- `InKeychain(Persistent)` is false. No optional Info implementation is provided;
  Describe returns unknown and does not claim ValuesProtected (OS-vault value
  protection). Encrypted rows must not be described as literally in Keychain.

## Bootstrap and failure behavior

Order: private directory and exclusive lock → durable identity → vault Get,
optional random-key Set and exact readback → privately create/open database →
transactionally initialize metadata and rows table. A database is never created
before root verification and initial keycheck nonce generation.

Existing DB plus missing key returns ErrKeyLost and never regenerates the root.
Missing/corrupt identity with an existing DB fails before vault access. Unknown
identity/root/metadata/blob versions, wrong root, failed authentication, truncated
DB, and orphan WAL/SHM/journal without a DB fail closed. An existing valid vault
key without a DB can resume initialization without another Set. Existing partial
DB initialization is *not* automatically repaired or deleted: explicit future
recovery is required, even if no user values were committed yet.

Vault Set failure or readback failure/mismatch returns ErrOutcomeUnknown. Identity
and any actually persisted root remain; no rollback/delete or blind same-open
retry is attempted. A later Open reconciles through actual Get, not an assumption
about the earlier error. A failed SQLite Commit also returns ErrOutcomeUnknown:
it may have committed. The caller must reconcile through subsequent reads/reopen,
not infer rollback or blindly retry. Failed pre-commit statement execution reports
a sanitized category and leaves its transaction to rollback. No error wraps or
retains raw vault/SQLite diagnostic text, paths, logical names, or values.

## Security and acceptance limits

Ciphertext length (plaintext length + 29 bytes), row count, stable opaque lookup
identity/access patterns, UUID, format, file sizes and update timing leak.
Authentication does not detect deletion, rollback of an entire valid database,
or replay of an older valid row under the same name. This is not secure deletion:
WAL/SQLite pages can retain old **ciphertext**. Keys and values are never explicitly
written as plaintext to SQL, WAL, temp files, logs, or key files by this core.
Go strings, AES schedules, SQLite/runtime copies, crash dumps and swapped pages
are outside a zeroization guarantee. Clearing owned key buffers on Close is only
best effort; no locked-memory claim is made.

The connection/result bounds reduce oversized persisted-field and computed-result
allocation before driver/Scan copies. They are not a total SQLite memory, CPU,
file-size or query-work budget, and do not prevent all malicious schema/view or
SQLite-open denial of service. In particular, driver opening/DSN pragmas occur
before the checked-out connection can be limited. Trusted-owner/profile threat
assumptions remain unchanged; this does not make arbitrary hostile databases safe.

Windows returns ErrUnsupported before directory/vault access; native ACL creation,
verification, reparse/hardlink handling and directory durability remain gates.
Linux code uses POSIX ownership/mode/sync checks, but native Linux execution and
native SQLite/filesystem durability acceptance remain separate from Darwin tests.
Darwin fsync + SQLite FULL is not a claim of universal hardware/power-loss safety.
Native OS-vault/SecretService context behavior and real-vault proof, migrations,
OS wiring and activation are explicitly deferred.

A future caller could choose `<data>/private-secrets-v1`, but this slice does not
choose or wire that path. Existing backup/restore lists are untouched; no database
or root-key backup/export is added. Future integration must explicitly decide how
to present an unbacked-up profile and handle key loss or moved directories.

## Test artifacts and local gates

`persistent_test.go` and `persistent_fault_test.go` use only explicit temporary
directories and injected in-memory fakes. They cover byte/Unicode limits (including
2559/2560/2561-byte values, 64 KiB OAuth-sized and 128 KiB values), reopen, nil
backend refusal, unsafe permissions/symlinks, bootstrap ordering, ambiguous vault
Set/readback, absent/wrong keys, malformed identities/roots, clone/move refusal,
RNG failure before writes, nonce freshness, row/AAD tampering and format mismatch,
metadata/keycheck validation, live disk/WAL plaintext scans, SQLite statement
errors/contention, deadlines, commit-before/after ambiguity, serialization,
Close joining and directory contention. Crash subprocesses use a **public
constant test key returned from memory**, never a fake plaintext key file. They
exit before/after transaction commit, checking complete old/new values and
OS-lock release after process death, not simulating sudden hardware power loss.
`persistent_bounds_test.go` adds 64 MiB ordinary and computed-view value,
keycheck and profile corruption fixtures, malformed result types/exact metadata,
and maximum 128 KiB Unicode/binary roundtrips. Rejection must return ErrCorrupt
with less than 2 MiB of measured Go allocation per operation, excluding fixture
construction. This is not a native-memory/RSS bound. Tests discard the underlying
driver connection with ErrBadConn, prove its replacement initially has the larger
default limit, then repeat rejection and inspect the reapplied connection limit.
No test installs a global SQLite hook.
`persistent_windows_test.go` defines the unsupported-platform boundary; compiling
it is not native Windows execution or an ACL/native-vault acceptance proof.

Run with Go 1.26.10:

```
go test ./internal/secrets -count=1 -timeout=60s
go test -race ./internal/secrets -count=1 -timeout=120s
go vet ./internal/secrets ./internal/models ./internal/mcp ./internal/web ./internal/judge ./internal/agents
go test ./internal/models ./internal/mcp ./internal/web ./internal/judge ./internal/agents -count=1 -timeout=120s
```

All these tests must use their existing explicit temp directories/fake stores and
loopback fixtures, not a normal app profile, bundle, real credentials, or providers.
Local execution results and any compile-only targets are recorded in the change
summary; do not interpret this list of commands as proof they ran on every OS.
