# Windows token-shape inventory — read-only observation, execution OFF

## Scope and evidence status

This increment starts at `4585a86` on `v05/token-shape-inventory`. It adds only
test helpers/fakes, diagnostic fixture wiring, this report and that branch's
owned-child workflow allowlist entry. Production Go files remain byte-identical.
Parent full-source review, independent review and native CI are **pending**.
The author has neither pushed nor dispatched native CI.

Baseline native runs **39727836384** and merged **39729478459** passed required
normal/race/vet on all three OS lanes, including all nine suspended Windows LPAC
cases in normal and race. They are baseline evidence, not evidence that this new
inventory has run. The [fixed verification contract](windows-lpac-fixed-verification.md)
continues to govern authorization independently of this diagnostic.

“Read-only” describes the new token observations: query, read-only handle
acquisition, duplication and retirement. The already-reviewed fixture still
creates/deletes its exact ephemeral S_OK-owned profile and creates/reaps a
suspended child. This is not a claim of zero existing OS mutations.

## What is captured

For each normal nine-case fixture and each paired LPAC/ordinary-AC comparator,
`candidateDiagnoseShape` captures complete owned snapshots of:

- `TokenGroups` (class 2), every SID and its attributes;
- `TokenRestrictedSids` (class 11), every SID and its attributes;
- `TokenPrivileges` (class 3), every LUID and its attributes;
- token type, and SecurityImpersonation level for the owned duplicate.

The three roles are the borrowed, already-live **creation primary**, an
independently opened **retained child PROCESS token**, and a distinct owned
SecurityImpersonation/TokenImpersonation duplicate. Role numbers in output are
0/1/2 in that order. The complete explicit query/open/duplicate/close bundle and
SDK layout are checked before any operation. Only the fixture boundary creates
a native bundle; fake handles never reach native calls or native SID helpers.

Collection order is deliberate: primary first, then source acquisition and
collection, then duplication and collection. A primary query failure therefore
opens no new tokens. Source access is exactly QUERY|DUPLICATE, requested once up
front through the existing retained PROCESS handle, never a PID. Duplicate
access is exactly QUERY. Neither observation changes the borrowed primary.

Every variable query has two calls, a 64-KiB cap, aligned owned storage and an
exact unchanged returned extent. Count bounds precede multiplication/addition.
The complete SID_AND_ATTRIBUTES array must fit before any SID is interpreted;
each SID must be DWORD-aligned and fit **after that entire array** within the
returned owned extent. Revision/subauthority count/byte extent are checked in
Go; no interior x/sys SID metadata methods, native SID parsing or checkptr
bypasses are used. Privilege entries use the SDK 4-byte header/12-byte stride
and exact array extent. Duplicate SID/LUID entries are diagnostic refusals.
Canonical SID bytes, attributes and LUID values are copied into owned storage.

Order is normalized separately for groups, restrictions and privileges. The
source and duplicate must have equal semantic sets, including every attribute
bit; their expected type/level difference is not a content mismatch. The
creation primary **need not equal** the restricted child: creation-derived
changes are expected. No count or identity allowlist is inferred from a pass.

## Custody, errors and nonauthority

Source and duplicate retire exactly once, duplicate first, including real
partial outputs on API errors. Null/pseudo handles and low-bit tagged aliases
of the borrowed primary, retained process or another token owner are refused
without closing the other owner's handle. Distinct partial outputs are still
owned and retired. Close errors remain sticky, are joined with query/API
failures, and never cause a retry of a potentially recycled handle. The borrowed
creation primary is never adopted or closed by inventory.

Outward inventory errors have fixed redacted messages while retaining all typed
causes through `errors.Is`/`errors.As`. Output contains only counts, OR summaries
of attribute flags, completion/type/level states and `sourceDuplicateEqual`.
No SID strings/bytes, LUID identifiers, addresses, session/user metadata,
backend messages or environment values are logged. Complete raw snapshots stay
internal and are not serialized. OR summaries cannot reconstruct individual
members or prove an expected shape.

The existing `candidateAccessVerify` acquires the **same early independent
SYNCHRONIZE cleanup witness before any diagnostic** and returns the real exact
Job `(member, error)` pair unchanged. Inventory runs in its controlled diagnostic
callback; failures are sticky and fail fixture assertions after synchronous
cleanup. They do not manufacture a verifier result, convert an API error into
DENY, waive fixed metadata/AccessCheck failures or supply execution authority.
All nine hard-stop/cancel/injected-failure assertions, strict derived-primary
predicate and post-cleanup primary witnesses remain. The ordinary AC comparator
remains ordinary AC, not an LPAC fallback.

Trusted native query/duplication, controlled creation and retained-handle custody
are assumptions. A sequential snapshot is not atomic whole-token equivalence,
proof against concurrent hostile token mutation or an arbitrary-token
classifier. Semantic set equality is only for these three captured collections.
It does not establish the absence of other token state, filesystem/network/IPC
confinement or an undocumented universal LPAC flag. Historical selector46
observations remain unchanged and nonauthoritative.

## Native review gate — no invented expected counts

No new native counts have been observed or approved. After parent source review
and independent review, a separately authorized push/native run must require:

1. All normal/race/vet lanes on macOS, Ubuntu and Windows, with no allow-failure,
   new skips or narrowed test selection. New Windows fakes must execute under
   normal and race/checkptr, not merely cross-compile.
2. Each of the nine Windows fixture cases passes in normal and race: full shape
   snapshots, source/duplicate equality, fixed metadata plus A/B/C DENY/DENY/ALLOW,
   exact expected stop/cancel/injection outcome, zero resumes and independently
   signaled-and-closed cleanup before profile deletion.
3. Both paired references pass, preserving ordinary-AC DENY/ALLOW/ALLOW and its
   three attributes, versus LPAC's four attributes and fixed selected gate.
4. Parent inspects all new count/flag/state output and explicitly reviews the
   first native expectations before documenting accepted observations. Any
   future expected-shape allowlist needs separate review of its identities,
   attributes and supported configurations; observations are not automatically
   promoted into universally safe shapes.

A Windows Server runner result cannot stand for every Windows 11 variant,
standard-user desktop behavior or positive restricted execution.

## Future gates and unchanged OFF boundaries

Both independent unconditional primary/policy OFF stops remain. Public Start
still passes nil policy with JOB_LIST+HANDLE_LIST only; runtime win32 is still
unavailable. This increment activates, bypasses or redefines none of them.

Separate authorization/review is still required for expected shape policy and
hostile broker-equivalent mutation boundaries; any independent execution
launcher; minimal exact-profile fixture ACLs and Low MIC labels; positive
workspace/negative outside synthetic controls; network/IPC/pipe probes;
earliest marker/resume ordering; descendants, abrupt-parent-death and handle
lifetime/crash recovery; quoting/environment compatibility; and a managed
Go-helper-only network-off prototype before shell/runtime integration.

Loopback configuration querying is **not implemented**: its exact allocator and
deallocator contract remains separate research. No NetworkIsolationSet calls,
ACL/MIC changes, actual process resumes, TEMP/TMP environment broadening,
credentials, proxies, shells or providers are added. No actual application,
vault or user data is accessed. Existing profile ownership uncertainty and
cleanup witnesses are preserved, not weakened.

## Local validation

Actual Go **1.26.10 darwin/arm64**, toolchain bin first on PATH,
`GOTOOLCHAIN=local`, `GOFLAGS=-mod=readonly`, no SDK/cache/dependency patches:

- process/supervisor/MCP normal: exit **0**.
- process/supervisor/MCP race: exit **0**.
- process/supervisor/MCP vet: exit **0**.
- Windows amd64 process/supervisor/MCP test cross-compiles (CGO_ENABLED=0): each
  exit **0**; all three packages' Windows vet: exit **0**.
- actionlint **1.7.11** on the owned-child workflow: exit **0**.
- gofmt, whitespace, production-byte and module-immutability checks: each exit
  **0**. No dependency or SDK/cache files were changed.

Windows execution/native expectations remain pending; local compilation is not a
native pass. The workflow adds only this branch, retaining every required native
lane. Local macOS tests do not execute the new Windows-only fake matrix.
