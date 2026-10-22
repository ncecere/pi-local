# Windows token-shape inventory — read-only observation, execution OFF

## Scope and evidence status

This increment starts at `4585a86` on `v05/token-shape-inventory`. It adds only
test helpers/fakes, diagnostic fixture wiring, this report and that branch's
owned-child workflow allowlist entry. Production Go files remain byte-identical.
Parent read all six changed files. Independent security review `9ff99795`
approved **diagnostic-only** source inclusion with no actionable findings, not
native or activation acceptance. Parent gate `proc_f3c1` passed Mac process/
supervisor/MCP normal/race/vet, Windows source checks/vet, actionlint and
production/module byte-immutability checks (exit 0). Native CI and the separate
first-observation review later passed as recorded below; merged-tree verification
is still separate. The original author did not push or dispatch native CI.

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

The initial native gate was defined before observing counts. Every native run
must retain these requirements; first observations below do not weaken them:

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

Loopback configuration querying is **not implemented**. Separate research
establishes successful-result process-heap cleanup, not caller capacity or an
exhaustive partial-error ownership contract; native allocation bounds remain
unresolved. No NetworkIsolationSet calls,
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

Those local checks were not a native pass. The workflow adds only this branch,
retaining every required lane; the later first native result follows.

## First native observations — not a shape policy

CI **39734610806** at `e9ab1f1ea017ac6e724cdc1307f9587c3a598f3e`
passed normal/race/vet on all three OS lanes. Parent retained the complete log
`.cache/token-shape-first-native.log`, filtered fixture/control summary and
machine-readable `.cache/token-shape-first-native-observations.json`.

Windows normal and race/checkptr passed all new fakes, all nine suspended cases
per build (18 case passes), and both paired references per build (four passes).
The 22 native inventory reports were complete, error-free and source/duplicate
set-equal, with 66 role rows:

| Role | Kind | Impersonation level | Groups | Restricted SIDs | Privileges |
| --- | ---: | --- | ---: | ---: | ---: |
| Borrowed creation primary | 1 | Not queried; logged storage zero | 14 | 0 | 1 |
| Retained child source | 1 | Not queried; logged storage zero | 14 | 0 | 1 |
| Owned duplicate | 2 | 2 (SecurityImpersonation) | 14 | 0 | 1 |

All 22 observations per role reported group attribute OR `0xc0000077`,
restricted attribute OR `0x0` and privilege attribute OR `0x3`. These are
**observations of this hosted Windows Server configuration**, not approved
identities or masks for every Windows11/token configuration. The same count/OR
summaries appeared for ordinary AC and LPAC: they are not a classifier.

Identical counts/OR masks do not establish primary/child identity-set equality.
Only the source/duplicate collections were fully compared internally, including
all captured attributes. Restricted SID count zero does not mean absence of
LowBox/AppContainer restrictions, and privilege count one does not identify its
LUID. No raw identity was promoted into an allowlist or logged.

The fixed metadata/AccessCheck gate, exact expected stop/cancel/injection errors,
zero resumes and independent signaled-and-closed profile cleanup still passed.
This accepts only bounded diagnostic observations for the controlled fixture,
not hostile-mutation resistance, actual restricted execution, filesystem/network/
IPC enforcement, or standard-user Windows11/product readiness. Independent
first-observation review `019d1cf5` independently recounted all 22 reports/66
roles, verified the exact-HEAD lanes/case passes and accepted only diagnostic
observations with no actionable findings. Merged-tree verification remains
separate; no future shape policy or activation was approved.
