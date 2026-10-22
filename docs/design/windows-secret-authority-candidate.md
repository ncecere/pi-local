# Windows secret authority: candidate protocols, not activation

Status: conditionally reviewed research proposal; native activation is unapproved.
A later executable model exposed the unresolved sequential-reference ownership
case below. No v2 format, adapter or migration is implemented. Windows `OpenPersistent` must still return `ErrUnsupported`
before filesystem or vault access. Existing format 1 and its tests are unchanged.

## Why private NTFS ACLs are insufficient

Format 1 publishes and synchronizes its UUID identity before accessing the vault.
The integrated Windows helpers prove narrow private-object contracts, not this
ordering: new root publication, identity publication, then durable root-key storage.

[CreateFileW caching behavior](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew#caching-behavior)
describes write-through NTFS metadata flushing, but does not establish that complete
new-root/parent ordering. [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
is not a documented POSIX parent-directory-fsync replacement. Generic MoveFileEx
or TxF assumptions do not close the gap. Keep this identity-first Windows path off.

## Alternative: authority before database

A separately versioned protocol could locate one authoritative, bounded root record
by an **explicit stable logical profile reference**, not a UUID recovered from the
filesystem. The default profile could have a fixed per-user reference; custom
profiles need an explicit creation/identity protocol. Losing a directory must not
select another root-key namespace.

The authenticated record would bind format, logical reference, exact canonical
location, UUID, root key and PENDING/ACTIVE phase. Layout, maximum sizes and
integrity construction need review before a codec is implemented. No chunks,
plaintext fallback, automatic replacement, key deletion or rotation are proposed.

Location mismatch fails closed, rather than selecting another namespace. Case,
8.3 aliases, drive mappings, case-sensitive directories, rename and root recreation
need explicit equivalence/refusal rules. A resolved path alone is not that proof.
Candidate references are exact ASCII `default` or `profile:<canonical lowercase
UUID>`, with custom IDs issued only by a separately reviewed explicit-creation
protocol. No caller path or filesystem UUID becomes a reference. A candidate
cross-session lease name uses a fixed application/version prefix in the Windows
Global namespace and a domain-separated hash of validated current-user SID bytes
and reference. The concrete native naming/ACL implementation still needs review.

The same logical reference must acquire that lifetime owner lease **before
authority access**. Then acquire and retain independent directory exclusion:
**different references pointing to the same directory must also serialize or
refuse**, never initialize competing authorities. Always acquire reference lease
before directory exclusion, never a second reference lease while holding a
directory lock. Reconcile an abandoned owner through authenticated authority and
SQLite state; abandonment is not permission to erase or reset anything.

A lock file inside the disposable root alone is insufficient for reference
ownership. A named-mutex design needs creation-time User/SYSTEM ACLs, existing-object
validation and a pinned owning OS thread through release; a Go goroutine cannot
silently migrate mutex ownership. Alias/recreation exclusion and native lease
implementation remain unproved; no lease is implemented by this proposal.

**Unresolved modeled counterexample:** directory exclusion covers concurrent
owners, not persistent ownership after leases are released. If A retains PENDING
without a database, a later B can see an empty directory and establish another
authority for that location in the current model. Grammar-valid custom references
are not proof of an authorized unique profile issuance. A durable location/owner
claim or an explicitly reviewed default-only scope is required before a native
protocol can be approved; no catalog or fix is implemented here. The test-model
witness is research evidence, not acceptance of multi-reference operation.

### Conditional transition rules

| Authority / filesystem observation | Permitted result |
| --- | --- |
| Absent authority, genuinely fresh root, no legacy or database artifacts | Establish PENDING and require exact acknowledged readback |
| Absent authority with database/ciphertext | Key-lost/corrupt error; never regenerate |
| PENDING, database and sidecars absent | Resume identical UUID/key |
| PENDING, expected initialized schema and authenticated binding, with zero user-secret rows after committed transaction/WAL reconciliation | Promote the same root to ACTIVE |
| PENDING, user-secret records, partial/mismatched database or orphan sidecars | Fail closed; preserve material |
| ACTIVE, authenticated database | Re-establish durable acknowledgement under both leases, then open only after all binding/ownership checks |
| ACTIVE, missing database or root recreated during this open | Explicit recovery error; no bootstrap |
| Malformed/unknown record or existing format-1 material | Reject; no implicit migration or replacement |
| Ambiguous write, flush, readback or database commit | Outcome unknown; return no usable store and preserve material |

No usable store or secret-writing API may escape before ACTIVE acknowledgement.
A visible ACTIVE value is not proof of an earlier acknowledged flush. **Every
open of ACTIVE must successfully flush existing authority and perform exact,
validated readback under both leases before exposing a store, without rewriting
the immutable record.** A previous ambiguous promotion may otherwise leave an
unacknowledged ACTIVE value visible. Flush/readback failure means outcome unknown,
no store and retained material. A keycheck alone is not initialized-schema/zero-row
validation for PENDING; verify those additional invariants after WAL reconciliation.
Pending initialization must never consume/delete legacy credentials. ACTIVE root
authority is then immutable for this candidate: ordinary secret CRUD updates only
the encrypted database. Rotation, migration, recovery/reset and authority rewrites
require separate protocols.

This ordering could make a torn PENDING-to-ACTIVE transition an initialization
failure **before new user secrets exist**, rather than loss of an already usable
store. It does not prove recoverable old-or-new authority after a crash. Whether
that narrower availability contract is acceptable remains a review question; do
not claim atomic phase replacement. PENDING replay with a genuinely empty database
still cannot reveal historical activation. Missing authority plus missing files
is indistinguishable from first use without additional trusted persistence.

## Candidate native authorities

### Credential Manager: persistence assumptions remain unresolved

[CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)
documents creation/replacement, not an explicit synchronous flush acknowledgement
or whole-record crash-atomic replacement. Exact readback is observation, not an
independent durability/anti-rollback proof. Existing generic Vault contracts do
not silently acquire these stronger guarantees.

### DPAPI plus nonvolatile per-user registry authority: research candidate

[RegFlushKey](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regflushkey)
returns after data for the containing hive is written to the registry store on
disk, including other modified keys. A [hive](https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-hives)
contains keys/subkeys/values, and [nonvolatile keys](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regcreatekeyexw)
survive restart. Together these support a stronger in-hive publication contract
than the documented CredWrite acknowledgement; they are not filesystem parent-fsync.

Publishing/promoting a phase would require a bounded REG_BINARY write, successful
RegFlushKey, then exact readback. Reopening immutable ACTIVE requires only the
flush/validated-readback acknowledgement, not another write. [RegSetValueExW](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regsetvalueexw)
does **not** promise power-failure atomicity, even for a small record. Do not infer
old-or-new recovery from value size or registry logging.

A future adapter would protect the record with current-user
[DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata),
UI forbidden, no machine-wide scope, and independently bounded plaintext/ciphertext.
[Unprotect documentation](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata)
requires attention to corruption: successful API output alone is not sufficient
record validation. Codec integrity/binding and database authentication remain
required. Protected User/SYSTEM ACLs must exist at each key's creation; existing
keys are inspected without repair. No capability SID/LowBox grants or key broker.
Registry ACLs alone are not encryption.

The pinned x/sys registry CreateKey wrapper passes nil security attributes and
cannot directly implement that creation contract; use reviewed public-SDK bindings
if this candidate proceeds. Bounded GetValue is preferable to allocation driven by
untrusted stored size. RegCreateKeyEx disposition is fixture cleanup authority only
for a key actually created by that test, never production rollback authorization.

Native calls are synchronous and not forcibly context-cancellable. Cancellation
cannot release the owner lease while a native operation continues. Post-write
errors/timeouts remain outcome-unknown. No adapter is approved here.

## Limits and next gate

Declare functioning OS/storage flush semantics. Do not promise resistance to
privileged interference, profile/hive rollback or deletion, dishonest hardware,
hostile same-user mutation, or universal physical power loss. SQLite WAL/FULL and
its Windows FlushFileBuffers VFS still need their own filesystem/native acceptance;
registry authority does not prove database durability.

Keep authority and encrypted-store material outside application backup/restore;
restoring app.db must not reset phase, choose a new namespace or replace a key.
Any format-1 migration needs explicit versioning, recovery and retained-source rules.

Next: independently review the stable namespace, lease, phase and ambiguity
assumptions. Only then consider an unwired, fake-backed executable model with
boundary/fault tests. Fakes cannot prove native durability, and passing a model
cannot enable the Windows factory. Real adapters, supported-OS tests, large OAuth
routing/migration and recovery remain separate gates.
