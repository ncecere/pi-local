# Windows LPAC fixed verification contract — private and OFF

## Status and evidence boundary

This isolated increment is based on `f776bbd`, on
`v05/lpac-verification-contract`. It deliberately replaces selector46 authority
for the **still-disabled private own-child primitive**, not for public `Start`,
execution, runtime integration or a production caller. Acceptance requires full
parent and independent review of this increment **and an actual native Windows
run**. Parent read the complete change. Independent security review `3f80c529`
approved source inclusion **OFF-only**, with no actionable findings, not native
acceptance or activation. Parent gate `proc_e6ad` passed process/supervisor/MCP
normal/race/vet, Windows source checks/vet, actionlint and whitespace checks
(exit 0). Actual native execution remains pending; local cross-builds are not
acceptance. The original author did not push or dispatch native CI.

Historical diagnostic commit `17fdb6b`, native run **39721890954**, reported LPAC
A/B/C **DENY / DENY / ALLOW** versus ordinary AppContainer
**DENY / ALLOW / ALLOW**, Windows normal/race injected and paired tests, zero
resumes and independently witnessed cleanup. Its original selector46 query still
returned error87 and the complete candidate gate remained red. That evidence is
preserved in the historical branches and
[diagnostic report](windows-lpac-accesscheck-diagnostic.md); it is not a native
pass for this new contract. The separately reviewed unwired checker `9b190df`
and reporting follow-up `f776bbd` supplied the starting helper, not activation
authority. See [the prior helper contract](windows-lpac-semantic-checker.md) for
its implementation review and historical limitations.

## One explicit verification decision

`windowsAppContainerVerification` contains both `query` and `checkLPAC`. Every
injected bundle must be complete, even for a metadata-only ordinary-AC
comparator. No function field gets a native default. A nil bundle is refused by
the direct verifier. Only `startWindowsOwned` may deliberately interpret a nil
bundle as selecting `newNativeAppContainerVerification`, which binds the query
from `newNativeLPACAccessAPI` and `verifyWindowsLPACSemantics` together.
Incomplete verification or source-ownership injection is refused **before the
borrowed-primary TokenType query**, descriptor processing or child creation.
The complete injected query also handles that first primary-token query.

The outer verifier still requires AppContainer=1, elevation=0, the exact
independently supplied profile SID, zero capabilities and exact Low integrity.
Bounded metadata/layout/SID and malformed-query refusals remain. If `lpac=true`
was selected, successful metadata **always** calls the fixed semantic checker.
There is no selector46 query-then-fallback, waived87, fabricated `lpac=false`,
or conversion of an API error to a DENY decision. The historical size-query
utility is a standalone test observation only; neither native fixture uses it
as a verification predicate.

The checker requires a Primary source, creates only a distinct owned
SecurityImpersonation/TokenImpersonation duplicate with TOKEN_QUERY, and repeats
bounded exact metadata plus user/primary-group equality checks on that duplicate.
Trusted native DuplicateTokenEx is assumed to preserve the intended source
semantics: these fields alone are not complete token-equivalence proof. It
constructs three independently owned, exact-bound in-memory security descriptors
and requires successful AccessCheck decisions A=user DENY, B=user+AAP DENY,
C=user+exact-profile ALLOW. API/output errors, malformed SDs, unexpected rights,
retry ambiguity and duplicate-close uncertainty refuse. The helper never opens
or closes the borrowed source and never widens its rights.

## Retained handles and ownership

The launcher opens the child token only through its retained owned **PROCESS
handle**, after atomic Job assignment and exact membership verification; no PID
lookup or reopening is involved. It requests TOKEN_QUERY once, adding
TOKEN_DUPLICATE **up front only for selected LPAC verification**. The ordinary
public lifecycle does not open a candidate token at all. There is no
rights-widening retry.

The separate complete `windowsChildTokenAPI` seam controls source open/close;
nil selects the native pair only at the owned-launch boundary, and partial
injection is refused. The launcher retires a real returned source exactly once,
including partial output on open error. It joins verification and source-close
errors and refuses close uncertainty **before `beforeResume`**. It never retries
a possibly recycled handle. The checker independently owns and retires only its
duplicate. The externally borrowed creation primary remains owned by its test
owner through synchronous failure cleanup and is neither closed nor replaced.

Both unconditional OFF stops remain before ResumeThread: the independent
borrowed-primary stop **and** the nonnil-candidate-policy stop. Semantic success
only reaches these stops; it grants no execution authority. Public
`platformStart` still reaches `startWindowsOwned` with nil policy and exactly
JOB_LIST + HANDLE_LIST, preserving its ordinary lifecycle.

## Controlled-creation assumptions, not arbitrary-token classification

This contract is defensible only for controlled creation of the retained owned
child, using the independently known exact creation profile, trusted native
query/duplication and trusted handle custody. Arbitrary externally supplied
restricted-token lookalikes can reproduce the matrix. It proves neither an exact
undocumented LPAC flag, universal AAP nonparticipation, universal token equality,
absence of concurrent token mutation, nor filesystem/network/IPC confinement.

Unexpected groups/restrictions and hostile broker-equivalent token mutation
remain explicit **activation gates**. This increment neither inventories every
group/restriction nor establishes a hostile-mutation boundary. Review must still
justify expected token configurations, controlled creation and custody before
any future activation. No native success may silently weaken those requirements.

## Required native fixture contract

The fixture explicitly constructs the complete native verification bundle. Its
strict derived-primary predicate, exact environment selection, zero capabilities
and attribute composition remain unchanged: SECURITY_CAPABILITIES, LPAC opt-out,
JOB_LIST and HANDLE_LIST, all **four**, for actual LPAC. The early noninheritable
SYNCHRONIZE witness is acquired before metadata/semantic validation. Its exact
signaled-WAIT and successful-close witnesses remain prerequisites to deleting
only the S_OK-owned exact generated profile. Missing witness/cleanup uncertainty
is failure and preserves the profile for ephemeral-runner disposal, not success.

Three repetitions each of hard-stop, cancellation and injected failure still
require `beforeResume` exactly once after real verification, zero resumes and
respectively the exact execution-disabled error, `context.Canceled`, or injected
sentinel. Unexpected creation, metadata, access or cleanup errors are failures;
there are no skips or looser accepted errors. A marker's absence is supplemental,
not proof of confinement. The paired ordinary reference remains a disposable,
suspended, three-attribute comparator only. Both references must complete their
expected OFF gates; historical error87 recognition has been removed from their
acceptance assertions. Ordinary AC rejection by the selected-LPAC authoritative
checker is additionally covered through the complete fake API matrix.

New Windows-only regressions cover every missing/partial outer and source
bundle with zero dependency operations, pre-primary validation, injected first
primary query, checker/error propagation, metadata-before-checker ordering,
ordinary AC rejection, exact one-shot source rights/ownership, partial open,
source and duplicate close uncertainty, and joined failures. All existing
metadata refusals remain or have fixed-contract equivalents. Historical
selector-value/error cases now prove nonauthority rather than preserving the
obsolete predicate. Fake token123 uses an explicit fake checker, never a native
checker. The deliberate native ordinary-child test proves non-AppContainer
refusal before checker entry. No checkptr bypass or dependency/cache patch is
used.

## Still-unproved activation gates

All remain OFF, independently of this contract's eventual native result:

- Parent and independent source review approved OFF-only inclusion; this does
  not replace native Windows normal, race/checkptr and vet, including new fake tests, actual
  helper, paired controls, all nine fixture modes and exact cleanup witnesses.
- Expected groups/restrictions, trusted creation/duplication/custody and a justified
  boundary against hostile broker-equivalent mutation. No arbitrary-token claim.
- Owned private single-link/no-reparse NTFS fixtures with separately reviewed
  minimal exact-profile ACLs and Low labels; positive workspace access and
  negative outside fake-credential/other-agent controls. No changes to real data
  or existing executables/trees, broad filesystem grants or migration.
- Exact-profile loopback-exemption inspection without mutation; synthetic
  IPv4/IPv6 loopback and named-pipe/IPC denial; intrinsic OS/profile access
  inventory. Zero capabilities alone do not establish those boundaries.
- Earliest-marker/resume ordering, restricted positive execution, gate-fault
  injections, descendants, abrupt parent death, Close/profile cleanup,
  restricted-success/failure handle growth and bounded crash/profile recovery.
- Unicode/quoting, reviewed environment compatibility and a managed Go-helper-only
  network-off prototype before any shell/runtime integration. No Bash/cmd/
  PowerShell fallback; elevated Windows Server does not establish standard-user
  Windows 11 behavior or product readiness.

No filesystem/network/IPC policy, ACL, installed profile or environment broadening
was added. Existing ephemeral fixtures alone may provision profiles on an
approved ephemeral Windows runner. No vault, userdata, AppSupport, normal
PID92423, installed application or reference checkout was accessed or changed.

## Local validation

Go **1.26.10**, macOS arm64, process/supervisor/MCP packages only:

- Normal `go test -count=1 -timeout=10m`: **exit 0**.
- Race `go test -race -count=1 -timeout=10m`: **exit 0**.
- `go vet`: **exit 0**.
- Windows amd64, CGO_ENABLED=0, each package's `go test -c`: **exit 0**
  (process, supervisor and MCP); `go vet` for all three: **exit 0**.
  Compilation only, no Windows execution on macOS.
- Workflow YAML parse/branch+matrix assertions and actionlint: **exit 0** each.
- gofmt and `git diff --check`: **exit 0**.

The owned-child workflow allowlist adds this isolated branch; every native
normal/race/vet lane is still required and every nonzero exit keeps the gate red.
There is no expected-red waiver. Native Windows execution remains **pending**;
this work must not be accepted or enabled based only on local checks.
