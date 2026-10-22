# Secret storage contracts: direct-vault boundary

## Implemented in this slice

`secrets.Store` remains `Get`, `Set`, and `Delete`. The zero-value
`secrets.Keychain{}` still delegates to the pinned go-keyring v0.2.8 under
service `Pi Local`, but only when an operation is explicitly invoked.
Construction and metadata do not contact or establish availability of the
vault. Memory is an explicitly selected store, never a failure fallback.
No application or frontend wiring changes are part of this slice.

Keychain returns sanitized `*secrets.Error` values. `errors.Is` matches
`ErrNotFound`, `ErrUnsupported`, `ErrUnavailable`, `ErrDenied`, `ErrLocked`,
`ErrTooLarge`, or the unclassified `ErrBackend`. `errors.As` retrieves operation
metadata (`Op` and a known preflight `MaxValueBytes`). Messages contain no
name, value, backend message, or command output. Only a safe category is
unwrapped; raw backend causes and their types are deliberately not retained.
Consumers must use `errors.Is`, not error equality or message matching.
Memory continues to return the original `ErrNotFound` sentinel.

The adapter recognizes upstream not-found, unsupported-platform, and
set-data-too-big sentinels, including wrapped instances. Explicit contract
sentinels are also accepted from an injected backend. Denied, locked, and
unavailable are not inferred from text. The existing system adapter does not
add platform-specific denied/locked/unavailable classifiers: where upstream
lacks reliable typed evidence, failures remain `ErrBackend`. An unknown write
failure does **not** establish that nothing changed or that a retry is safe.
No corrupt, key-lost, busy, cancellation, or outcome-unknown lifecycle protocol
is implemented here. A failed Get never returns a partial value. Missing Get
matches `ErrNotFound`; missing Delete succeeds.

`Describe(Store)` discovers optional `Info() Info` metadata without expanding
Store. Location identifies where the **values** reside (`os-vault`, `memory`,
or `unknown`), not where a future encryption key resides. ValuesProtected
reports the direct vault's protection model, not observed availability or a
successful write. MaxValueBytes zero means **unspecified**, not unlimited.
`InKeychain` retains its concrete Keychain value/pointer compatibility behavior;
it must not later be broadened to call encrypted SQLite values “in keychain.”

## Verified direct-backend limits and gaps

Source inspected read-only at upstream tags `zalando/go-keyring@v0.2.8` and
`danieljoos/wincred@v1.2.3` using opensrc:

- **Windows:** `keyring_windows.go` rejects `len(password) > 2560`, then passes
  `[]byte(password)` into CredentialBlob. In wincred, `conversion.go` passes the
  blob length and byte pointer, and `sys.go` calls CredWriteW. This is a
  **2560-byte** password limit: UTF-8 bytes for UTF-8 input, not character count
  or UTF-16 password units. Keychain preflights this exact limit before any
  backend operation; 2560 is accepted, 2561 rejected. No truncation occurs.
  This is not a guarantee that every smaller write succeeds: native target
  names, permissions, and other constraints still apply. Service stays fixed.
- **macOS:** `keyring_darwin.go` base64-encodes the value with prefix
  `go-keyring-base64:`, shell-quotes the fields, and forms exactly
  `add-generic-password -U -s %s -a %s -w %s\n`. It rejects
  `len(command) > 4096` **after starting** `/usr/bin/security -i`. The limit
  includes the service, account, quoting, encoding, and command overhead; it
  is not a constant raw-value allowance. This slice does not guess or change
  that policy. Upstream `ErrSetDataTooBig` becomes safe `ErrTooLarge` without
  inventing a raw-value maximum.
- **Linux/Secret Service:** `keyring_unix.go` uses the upstream unlock/prompt
  path without an operation context. The library does not provide a bounded,
  reliable locked/cancelled contract. Renaming errors cannot supply deadlines
  or prevent prompts. A later adapter must address this explicitly before
  claiming bounded startup or cancellation. No such claim is made here.

All new operation tests inject backend spies or Memory, including simulated
Windows boundaries on any host. The test constructor retains a missing
backend as unavailable; it cannot fall through to the real vault. Tests do not
exercise any OS vault or probe a running application or real profile.

## Separate encrypted core — still unwired

A separately reviewed **profile-local, dedicated encrypted SQLite core** now
exists: see [encrypted-profile-secret-core.md](encrypted-profile-secret-core.md).
It uses AES-GCM authenticated rows, opaque HMAC lookups and a small injected
vault-held root key. Darwin/Linux fake-vault contracts are native-tested;
Windows still refuses before filesystem/vault access. This does not activate
large OAuth storage or change the direct adapter described above. There is no
application routing, OS-vault adapter, legacy migration, export or backup wiring.

The complete storage lifecycle must implement and preserve:

- Lifecycle locking around provisioning, access, rotation, and shutdown, with
  defined concurrency and crash behavior.
- Stable profile identity outside the application's restore payload; restored
  application data must not silently retarget a profile's vault key.
- Explicit first-time provisioning, distinct from opening an existing store.
  A missing bootstrap key must never trigger automatic key regeneration for
  existing encrypted data. Lost keys and authentication failures fail closed.
- Versioned authenticated row/envelope metadata, nonce policy, and transactional
  replacement semantics, with no plaintext or Memory fallback.
- No implicit legacy import. Any future import requires an explicit,
  separately reviewed lifecycle and ownership policy.
- No secrets in application backup/export: neither the dedicated secret
  database nor its vault key belongs in those artifacts. Exclusion and restore
  behavior must be implemented and verified before the store is wired in.

None of these future requirements is a claim about current backup or restore
implementation. There is no frontend, application, profile, provider, or
migration integration in this contract-only slice.
