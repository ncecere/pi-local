# Windows private storage primitives — unwired first slice

## Scope and API

This change adds only unexported Windows helpers in
`internal/secrets/persistent_windows_primitives.go`, directly exercised by
Windows-only temporary-fixture tests:

- `createWinPrivateRoot(path)` creates **one fresh child** of an existing parent.
- `inspectWinPrivateRoot(path)` inspects an existing root without repairing it.
- `openWinPrivateFile(root, name)` opens and inspects one existing direct child.
- `winPrivateRoot` retains an owned root handle, observed canonical path, and
  copied process TokenUser SID. `winPrivateHandle.close()` releases handles;
  callers must not copy them or race their use with close.

There are **no callers outside these helpers and tests**. In particular,
`persistent_fs_windows.go` is unchanged: `OpenPersistent` still returns
`ErrUnsupported` before filesystem or injected-vault activity for otherwise
valid options. No Store, public API, application, OS-vault adapter, migration,
backup, runtime, UI, default directory, dependency, workflow, or signing change
is included. No OS account, profile, credential service, real secret, provider,
or running application is used by these fixtures.

## Creation and inspection contract

The process's actual TokenUser SID is obtained using a separately owned
`OpenProcessToken(TOKEN_QUERY)` handle, copied before its information buffer is
released, and the token is closed. This is not an impersonated-user, account,
profile, or availability-metadata lookup. SYSTEM-as-process-user is not supported
because the two approved trustees must be distinct. The shared process-owner
query refuses this context for both creation and inspection; descriptor parsing
also independently rejects SYSTEM as owner. Synthetic duplicate-SYSTEM root and
file cases preserve this invariant.

`CreateDirectoryW` receives `SECURITY_ATTRIBUTES` containing the owner and DACL
at creation, equivalent to:

```
O:<process-TokenUser-SID>D:P(A;OICI;FA;;;<process-TokenUser-SID>)(A;OICI;FA;;;SY)
```

The root owner must equal process TokenUser. Its non-null protected DACL must
contain exactly two ordinary ACCESS_ALLOWED ACEs: that SID and LocalSystem, each
with FILE_ALL_ACCESS (`0x001f01ff`) and exactly object/container inheritance
flags. Order is immaterial. Existing names are refused by the creation helper;
there is no recursive mkdir, broad-then-fix interval, existing-tree ACL rewrite,
or automatic delete/rollback. Post-create inspection can fail after creation;
a private child can remain and no durability/outcome reconciliation is supplied.

Opening uses `OPEN_EXISTING`, `FILE_FLAG_OPEN_REPARSE_POINT`, and backup semantics,
with READ/WRITE/DELETE sharing and non-inheritable handles. Root inspection asks
for READ_CONTROL and attributes; file opening additionally requests generic
read/write. The inspected and returned handle is the same object. Files must be
DISK, non-directory, non-reparse, single-link, and owned by the root's captured
process TokenUser. The approved file DACL has exactly the same two full-control
trustees. Each effective file ACE can be explicit (no flags) or inherited
(INHERITED_ACE only). Files need not have a protected DACL: OI/CI on the root
propagate to effective inherited ACEs without OI/CI on ordinary files.

Extra Users, Administrators, AllAppPackages, OWNER_RIGHTS, world or arbitrary
foreign allows are refused, as are absent/null/empty DACLs, duplicates, deny,
callback/object/unknown ACEs, other masks, inherit-only/no-propagate or unexpected
flags. This is a deliberately conservative descriptor allowlist, not a general
ACL equivalence engine. It does not run AccessCheck in production or interpret
privileges, claims, groups, or arbitrary effective-access policies.

Security information is retrieved through the handle using `GetSecurityInfo`.
The pinned x/sys helper frees its native LocalAlloc descriptor and returns an
aligned Go-owned self-relative copy. The caller checks native validity and a
20–65536-byte descriptor bound, then parses bounded owner/DACL/ACE/SID offsets,
lengths and control bits. The bound is applied after x/sys copies the trusted
kernel-returned descriptor, not an allocation limit on that dependency's native
query. SID comparison uses owned data and bounded revision/count metadata; no
IdentifierAuthority/SubAuthorityCount/SubAuthority interior-pointer API is used.
Creation descriptors are Go-owned and explicitly kept alive across synchronous
native calls. Close errors are sanitized and surfaced, including token and
failure-cleanup closes. A small explicit close-only fault seam refuses nil
without real I/O; it does not introduce fallback filesystem dependencies.

All returned errors use existing `secrets.Error`/safe categories; native causes,
paths, names, SID strings, and account identities are not retained or logged.
`ErrNotFound` means a missing path, `ErrDenied` covers disallowed objects/access
and creation collisions, `ErrUnsupported` covers unsupported storage, and other
native failures (including sharing/close failures) are `ErrUnavailable`.

## Explicit path and storage limits

Inputs must be ordinary drive-absolute DOS paths such as `C:\fixture\private`,
with backslash separators and at most 240 UTF-16 code units (excluding NUL).
There must be a nonempty child below the drive root. Relative, UNC, slash,
extended/device/VolumeGUID input namespaces, ADS, empty/dot components, DOS device
names, control characters, trailing dots/spaces and longer inputs are refused.
This deliberately does **not** promise support for all Windows long-path aliases.

Only local DRIVE_FIXED NTFS volumes advertising FILE_PERSISTENT_ACLS are
accepted. `QueryDosDevice` must resolve the ordinary drive to an unambiguous
`\Device\HarddiskVolume<number>` target; SUBST and redirected/mapped remote or
other device forms are rejected. `GetFinalPathNameByHandle` observes both the
normalized DOS name and the actual NT volume path; the NT volume must match that
drive's device, refusing a different volume hidden behind an ancestor mount.
`GetVolumeInformationByHandle` checks NTFS and persistent ACLs on the opened
object. Parent-volume observation occurs before mkdir; the new/existing root
and each opened file are also checked. No ancestor descriptor is changed.
Unsupported filesystem/drive/mount configurations are conservatively refused,
not normalized into supposed support.

The returned DOS final path is only an **observation**. It is not a portable
identity, case/8.3 equivalence contract, path-hash policy, or durable namespace
binding. Child opens are path-based, not handle-relative. Handles use delete
sharing intentionally; they do not freeze names or protect an ancestor chain.
Malicious same-user processes, administrators, ancestor or drive-map replacement,
and privileged access are out of scope. No race-proof or global privacy claim
is made.

## Tests and limits of the evidence

`persistent_windows_primitives_test.go` creates a new blank broad-parent fixture
below `t.TempDir`, then creates the private child at creation-time security. It
checks exact root ownership/protected DACL, effective child inheritance, safe
existing roots, creation collisions, unsafe root/file descriptors rejected
without repair, missing-parent non-recursion, non-direct-child names, ordinary
file-as-root/directory-as-file refusal, a junction root, file symlinks, hardlinks,
error sanitization, delete sharing, idempotent close and synthetic close failure.
Outside synthetic file content and owner/DACL snapshots must remain unchanged.
The file symlink subtest skips only when the required privilege is not already
available; no developer-mode/global setting is enabled. Junction and hardlink
fixtures need no new privilege. A synthetic descriptor matrix also covers
unsupported trustees, masks, flags, types, offsets, truncations and SID lengths.
No test changes a non-fixture/ancestor ACL or test executable.

Ordinary fixture files use owner-only creation attributes, with **no supplied
DACL**, to exercise inheritance without assuming an elevated token's default
owner equals TokenUser. A separate existing-modernc SQLite WAL fixture creates
the DB/WAL/SHM normally and checks the inherited two-ACE DACL on all three while
the database is open. If the native token defaults their owner to Administrators
rather than TokenUser, the helper must refuse them. That case is explicitly
reported as non-acceptance; tests do not change token defaults, repair those
files, or relax production ownership. The standalone delete-access reopen checks
our helper's sharing, not SQLite's own delete-sharing policy or durable rename.

`persistent_windows_authz_test.go` (amd64 only) uses native Authz with
AUTHZ_SKIP_TOKEN_GROUPS and a no-audit resource manager. It models owner/SYSTEM
and numeric synthetic foreign/Users/Administrators/AllAppPackages SID-only
contexts against the created root descriptor for read, write, delete, WRITE_DAC,
WRITE_OWNER and full control. It performs no S4U/group/account lookup, actual
foreign-user login, token impersonation, or global policy change. This evaluates
synthetic DACL authorization, not actual standard-user isolation or resistance to
administrator privileges. Native API/context/resource-manager failures and
release failures are test failures rather than silent success.

### Actual local gates

Executed on Darwin arm64 with Go 1.26.10 (all exit 0):

```
go test ./internal/secrets -count=1 -timeout=120s
go test -race ./internal/secrets -count=1 -timeout=180s
go vet ./internal/secrets ./internal/models ./internal/mcp ./internal/web ./internal/judge ./internal/agents
go test ./internal/models ./internal/mcp ./internal/web ./internal/judge ./internal/agents -count=1 -timeout=180s
GOOS=windows GOARCH=amd64 go test -c -o /tmp/pai-windows-private-fs-secrets.test.exe ./internal/secrets
GOOS=windows GOARCH=amd64 go vet ./internal/secrets
```

The Windows commands are **compile/vet only**, not native execution. Independent
security review approved only the unwired primitives and found one Low issue:
SYSTEM-owner inspection could collapse the two approved trustees. The parent
corrected the shared owner query and descriptor policy, added root/file
regressions, and bounded re-review closed that issue.

Parent normal/race secret/consumer tests, vet and Windows compilation/vet passed
before and after the correction (`v05-windows-private-fs-parent-gate` and
`v05-private-fs-distinct-owner-correction-gate`, exits 0). The parent deliberately
added this isolated branch to native secrets CI, with normal/race/vet aggregate
exit handling. YAML/actionlint v1.7.7 validation passed. Native CI
[39712753093](https://github.com/ncecere/pi-local/actions/runs/39712753093) at
`c0c15e8` then passed normal/race/vet on macos-15, ubuntu-24.04 and windows-2025.
Windows exercised NTFS creation/inheritance, descriptor/refusal/Authz/hostile
objects, SYSTEM-owner regressions, delete sharing and SQLite DB/WAL/SHM opening.
File-reparse and SQLite cases passed in both Windows builds; no private-FS skip
or SQLite owner-mismatch log occurred in this runner context. The Windows
pre-I/O unsupported-factory regression also ran. Elevated CI still does not
prove a genuine standard-user boundary or general SQLite ownership policy.

## Explicit remaining gates

This slice implements **no durability**: no FlushDirectory substitute, file-sync
bootstrap protocol, atomic identity publication/reopen reconciliation, or rename
power-loss contract. MoveFileEx WRITE_THROUGH's copy/delete language,
ReplaceFile's unsupported WRITE_THROUGH flag, and CreateFile WRITE_THROUGH/NTFS
metadata behavior do not establish the Unix identity-file + rename + parent-sync
bootstrap ordering. No vault may be activated on that assumption.

Windows publication durability and identity binding, actual standard-user and
hostile-object behavior outside the native fixtures, general SQLite owner/default-policy
acceptance and sharing/error/fault coverage beyond the bounded fixtures remain
future gates. The completed native tests and independent reviews approve only
these unwired primitives. Existing LockFileEx locking is not duplicated or wired.
Persistent-store activation, actual CredMan/Keychain/SecretService, migration,
backup/recovery, profiles and app integration remain entirely out of scope.

References for the test-only Authz model:

- https://learn.microsoft.com/en-us/windows/win32/api/authz/nf-authz-authzinitializecontextfromsid
- https://learn.microsoft.com/en-us/windows/win32/api/authz/nf-authz-authzinitializeresourcemanager
- https://learn.microsoft.com/en-us/windows/win32/api/authz/nf-authz-authzaccesscheck
- https://learn.microsoft.com/en-us/windows/win32/api/authz/ns-authz-authz_access_request
- https://learn.microsoft.com/en-us/windows/win32/api/authz/ns-authz-authz_access_reply
