# Native Windows process ownership

`Start` on Windows treats `exec.Cmd` as a **launch descriptor**, not an exec
process. It never calls `Cmd.Start`/`Wait`, and never fabricates `Cmd.Process`,
`ProcessState`, or `exec.ExitError`. Use `Tree.PID()` for diagnostics and
`Tree.ExitCode()` after `Done`/`Wait` for the actual native status. PID remains
stable through Close but grants no signalling authority. ExitCode is -1 before
completion/unavailable. Native nonzero exits use `ExitStatusError` (uint32).
Unix still has exactly one `cmd.Wait`, after PID-pinned signal retirement.

## Launch and cleanup

1. Validate context, Cmd.Err, descriptor features, paths/argv/environment.
2. Create an unnamed, non-inheritable job with KILL_ON_JOB_CLOSE and neither
   breakaway flag. Validate ALL three stdio handles before making ANY
   inheritable duplicate: reject NULL, INVALID_HANDLE_VALUE/pseudo-handles,
   GetFileType errors, UNKNOWN, and every type other than DISK/PIPE/CHAR.
   Duplicate only these validated three file handles as inheritable.
3. CreateProcessW with an explicit absolute application and cwd, Unicode env,
   STARTUPINFOEX JOB_LIST + HANDLE_LIST, and CREATE_SUSPENDED. There is no
   launch-then-assign, helper executable, or fallback.
4. Verify IsProcessInJob against this exact job while still suspended. Recheck
   launch context, then resume using the retained primary thread handle.
5. Wait using the retained process handle, record its real exit code, terminate
   remaining job descendants on leader exit, and finish bounded copier I/O.
   Hold the last job handle until Close has joined cleanup. Concurrent Close is
   idempotent; abrupt app death instead closes the handle in the kernel.

Windows 10+ and compatible nested-job policy are required. Unsupported startup
attributes or nested containment fail before user code. No elevation, service,
or administrator access is required under normal job policy. Jobs are lifecycle
containment, **not AppContainer/security sandboxes**. Broker-mediated processes
can escape ordinary child inheritance; restricting brokers is future policy.

Windows Term is deliberately not fake Unix SIGTERM. GracefulStop gives a bounded
cooperative grace then TerminateJobObject. Supervisor runtime shutdown first
closes its opt-in stdin EOF watchdog; MCP stdin remains JSON for probes and null
for login commands. Gateway registration still precedes launch, with existing
startup failure/unready cleanup and readiness ordering.

## Descriptor and I/O limits

- Reject nonnil SysProcAttr, Cancel (including CommandContext), ExtraFiles,
  already-started commands, malformed env/NUL arguments, and implicit batch
  shell launching. No fields are silently ignored to enable an unsafe fallback.
- Use caller-owned files or readers/writers, or NewInputPipe/NewOutputPipe.
  Do not use Cmd.StdinPipe/StdoutPipe/StderrPipe: their private exec bookkeeping
  has no native owner. Cmd methods must not be called after handing it to Start.
  Caller-owned files must remain open and stable until Start returns; concurrent
  descriptor mutation/closure is outside the ownership contract. A closed file
  is rejected, never promoted via DuplicateHandle's CURRENT_PROCESS (-1)
  pseudo-handle semantics. Type validation uses x/sys's same-syscall captured
  GetLastError; UNKNOWN fails even without an API error. Process/thread/token/
  job handles are not files and cannot enter the inheritance list.
- NewInputPipe owns both endpoints and closes its parent copy of the child read
  handle in Started. Closing it provides the runtime EOF signal.
- NewOutputPipe remains independent of reaping. Native wait never closes its
  reader or caller-owned writer. Its existing callback-aware post-exit drain
  policy is unchanged, preserving final large/slowly consumed JSON results.
- Native internal stdout/stderr copier writes are serialized even for a shared
  non-comparable consumer. Internal pipes are closed on cleanup, never caller
  streams. Post-exit copying uses Cmd.WaitDelay (default two seconds on Windows);
  expiration is exec.ErrWaitDelay, not a fabricated process exit failure.
  Arbitrary Reader/Writer callbacks must return. A blocked user callback cannot
  be forcibly interrupted by closing a local pipe and can outlive bounded Wait;
  it cannot retain a job/process handle through the copier.

## Required native gate (not replaced by cross-compilation)

Run on ordinary Windows 10/11 CI without elevation, with all state in temp dirs
and Memory secrets:

```
go test -count=1 -timeout=3m ./internal/process ./internal/supervisor ./internal/mcp
go test -race -count=1 -timeout=5m ./internal/process ./internal/supervisor ./internal/mcp
go vet ./internal/process ./internal/supervisor ./internal/mcp
```

The Windows-only synthetic helpers cover suspended exact-job membership before
an earliest marker, injected verify/cancel/resume failures with no marker,
child/grandchild and leader-first crash cleanup, abrupt owner death, breakaway
refusal, strict handle inheritance, closed stdin/stdout/stderr rejection before
ANY duplication, non-file process/thread/token/job rejection, safe scalar-only
pseudo-handle checks, injected file-type failures with handle-count loops,
reviewed DISK/PIPE/CHAR controls, concurrent Close, real exit status, Unicode
executable/args/cwd/env + JSON stdin, runtime EOF/null login, shared output
serialization, bounded copier cleanup, handle-count loops, supervisor gateway
failure cleanup, and large final supervisor/MCP stdout with slow callbacks.
The original Unix PID-pinning and zero-loss probe regressions remain enabled.
No native execution claim may be inferred from `go test -exec true`.

## Handle-count investigation and enclosing-job regression

Native CI run 39688559328 reached the normal Windows suite and reported only
`TestWindowsHandleCleanup` failing (125 -> 137 handles); Windows race/vet did
not run after that normal-suite failure. This is not a proven per-launch leak:
the old baseline launched null stdio without copiers, while its measured loop
used stdout/stderr `io.Discard` copiers and Windows pipe/IOCP machinery. The
12-handle difference alone cannot distinguish runtime initialization from lost
launch resources. No production cleanup change is justified by that trace.

The source ownership audit found these explicit release paths:

| Resource | Successful launch | Refused/failed launch |
| --- | --- | --- |
| Attribute-list allocation | Delete on Start return | Same defer |
| Three inheritable stdio duplicates | Close on Start return | Close every duplicate obtained before the failure |
| Primary thread | Close after ResumeThread | Terminate/reap suspended leader, close thread |
| Process handle | Retained until idempotent Tree.Close, after wait/I/O cleanup | Terminate/reap then close |
| Unnamed job | Retained until Tree.Close; kernel kill-on-last-close on app death | Terminate and close |
| Owned null/pipe child endpoints | Close immediately after duplication/start | prepare/start cleanup closes all obtained endpoints |
| Internal parent pipe endpoints | Bounded finish closes all after copier completion/timeout | Close all; no copiers started |
| External InputPipe/OutputPipe | Remain caller-owned | Remain caller-owned |

The replacement count regression uses **30 success/failure pairs of identical
warmup paths**, including the same stdout/stderr copier preparation and diagnostic
sampler as the measured paths. It then records three batches of ten successful
launches, three of ten suspended failures, and three of ten mixed pairs. Every
success checks Wait/Close errors and every owned pipe File's closed sentinel;
every failure must reach the injected suspended gate and produce no marker.

The original **+8 total handle budget is unchanged**, applied both per phase and
across ALL post-warmup phases, not renewed per batch/launch. This bounded allowance
covers one late Go M plus one IOCP initialization and small sampling jitter: Go
1.26.7 `runtime/os_windows.go` minit/semacreate can retain one thread handle, two
events, two timers and one wait-completion packet per M. Warmup is intended to
exercise these paths, not assert that this explains the observed CI delta.
Process/Job/File type counts, when available, additionally allow **zero growth**.
A live negative control deliberately retains thirty non-inheritable event handles
and requires the same counter/detector to reject their per-launch slope; every
control handle is explicitly closed. These tests disable automatic GC for their
bounded measurement and restore its setting afterward; no forced GC/finalizer
repair is used. A GC-count change during measurement fails the ownership gate.

Diagnostics log total handles, Go thread-creation count, goroutines, automatic GC
count, and object-type counts. Bounded NT queries inspect only this test process;
object names, filesystem paths, kernel addresses and other processes are never
queried/logged. If runner policy denies type introspection, it is logged explicitly
and the mandatory total-count gate still runs. The new measurements have not yet
executed on Windows: a persistent slope or runtime growth beyond the unchanged
budget remains a failure with phase diagnostics, not an assumed test artifact.

`TestWindowsRestrictiveEnclosingJobFailsBeforeExecution` installs an active-process
limit of one in a separate synthetic helper's own kill-on-close job. It verifies
exact membership and installed limits, then requires the target's atomic
CreateProcessW to fail with access-denied/quota status before the resume callback
or marker. A control launch must work before installing the constraint. The test
parent is never assigned to this restrictive job. Unsupported enclosing runner
policy is a structured **failure**, never a skipped or generically accepted error.
The helper reports then exits without closing its own last job handle prematurely;
the kernel closes it at helper death. This fixture too requires native CI execution.

## Disabled AppContainer candidate: policy/token slice only

This is **not runtime activation or Windows confinement evidence**. `Start` still
calls `startWindows` with no restricted policy, installs exactly JOB_LIST and
HANDLE_LIST, and retains the same wait/exit/close semantics. `win32.ts`, shell
selection, UI, defaults, trusted platforms and runtime integration are unchanged.

The only candidate entry is package-private `startWindowsOwned`, with private
`windowsAppContainerPolicy` and synthetic launch hooks inside `internal/process`.
There is no public SID/capability API. The policy snapshots an exact profile SID
into Go-owned memory. Its capabilities pointer/count/reserved are always zero.
A non-nil policy adds SECURITY_CAPABILITIES (0x20009), and explicit LPAC also adds
ALL_APPLICATION_PACKAGES_POLICY (0x2000f), DWORD opt-out=1. Attribute failure has
no retry as ordinary AppContainer or Job-only. The original three validated stdio
duplicates remain the **entire** inherited handle list.

The disabled candidate now also has a private borrowed-primary-token test seam:
zero still uses CreateProcessW; nonzero requires a real primary handle and a
non-nil policy, and directly uses CreateProcessAsUserW with the same startup
attributes, suspension and failure cleanup. The test owner holds/closes that
token, never the launcher. An independent borrowed-token stop supplements the
policy stop before ResumeThread. The strict owned-token derivation, privilege
**presence** predicate, source-backed API review and unproven native attribute
combination are documented in
[`docs/qa/windows-appcontainer-candidate.md`](../../docs/qa/windows-appcontainer-candidate.md).
No runtime caller uses this seam.

### Current fixed verification contract (private and still OFF)

The complete explicit query+semantic-checker and source-ownership bundles are
validated before any borrowed-primary token query. Only the owned-launch boundary
may deliberately select complete native bundles; partial injections never acquire
per-field native defaults. After suspended creation and exact owned-job verification,
the candidate opens TOKEN_QUERY through the retained process handle, never PID,
adding TOKEN_DUPLICATE up front only for selected LPAC verification. Before the
common resume gate it requires:

- TokenIsAppContainer (29) = 1 and TokenElevation (20) = 0;
- TokenAppContainerSid (31) exactly matching the copied profile SID;
- TokenCapabilities (30) GroupCount = 0 (no network capability);
- TokenIntegrityLevel (25) with an integrity label exactly S-1-16-4096 (Low);
- Selected LPAC always invokes the fixed behavioral checker: a distinct owned
  impersonation duplicate, repeated metadata/identity checks, exact-bound in-memory
  descriptors and successful AccessCheck A/B/C DENY/DENY/ALLOW. API failures are
  refusal, never DENY. This is controlled own-child creation evidence, not an
  arbitrary-token classifier, exact undocumented flag or universal AAP proof.

Selector46 is no longer an authority or error-triggered fallback. Historical
queries returned87 for1/4/8; those failures remain historical evidence, not a
waiver accepted by the new fixture. Fixed fields 29 and20 use `queryCandidateDWORD`: one direct query into
aligned storage with an exact four-byte extent, requiring both nil error and
returned length exactly four. Unknown classes, short/zero/oversized results and
all errors refuse; there is no sizing probe, retry or error-based fallback.
TOKEN_ELEVATION contains one DWORD, not a variable-size token record. Only
TOKEN_GROUPS (capabilities), TOKEN_APPCONTAINER_INFORMATION and integrity use
the existing aligned, at-most-64-KiB allocation, one bounded sizing call and one fetch, with
explicit returned-length checks and SDK-shaped native headers. Embedded SIDs
must fit entirely after their header inside the returned allocation before any
SID API interprets them. No returned pointers escape verification.
The checker owns only its distinct duplicate. The launcher retires its source
exactly once before `beforeResume`, including partial-error output; joined close
uncertainty refuses. Existing owned-process/job termination, reaping, stdio and
attribute cleanup still cover candidate failures. Complete contract, custody,
controlled-creation assumptions and pending native gates are recorded in
[fixed-verification QA](../../docs/qa/windows-lpac-fixed-verification.md).

**Even a successfully verified candidate is deliberately refused before
ResumeThread**, with `errWindowsAppContainerExecutionDisabled`. There is no
switch or environment variable that enables execution. This hard stop is needed
because zero capabilities alone do not establish the required network/IPC and
filesystem boundary. In particular loopback exemptions have not been queried.
No production profile, ACL, named pipe or network mutation is implemented here.
The test-only owned profile below is not a user profile; no installed executable
or real credential store is a fixture.

### Historical original selector46 slice: prepared tests and missing evidence

The following preparation/native-attempt notes preserve their historical evidence.
They do not describe current selector46 authority or count as a pass for the new
fixed verification contract above; its normal/race/checkptr/vet native gate is
separate and still pending.

`appcontainer_windows_test.go` has synthetic SID/layout/ownership checks; exact
zero-capability/LPAC attribute checks; malformed, oversized, truncated and failed
token-query cases; wrong/missing profile SID, capabilities, integrity, elevation
and LPAC refusal; invalid embedded SID bounds; and required-attribute failures
before target creation/stdio duplication with no marker. A native ordinary-child
negative control queries its retained token while suspended, refuses it as not
AppContainer, and checks that ordinary launch still has exactly two attributes
and no earliest child marker. It also directly reads the suspended child's real
TokenElevation DWORD through that retained handle; ordinary elevation is logged,
not required to be zero (CI may be elevated). The real LPAC gate still requires
TokenElevation = 0. The existing Job suite still supplies
verify/membership/cancel/resume, strict handle inheritance, descendants, abrupt
owner death, Unicode and cleanup regressions. Synthetic token buffers are **not**
observations of a real AppContainer token. The real restricted-child token path
now has the suspended-only fixture below; its first native attempt failed before
full token verification, and corrected native execution remains pending.

Run the existing native gate above, or focus on this first slice with:

```
go test -count=1 -timeout=3m -run 'TestWindowsAppContainer|TestWindowsAtomicSuspendedLaunch|TestWindowsFailuresNeverExecute' ./internal/process
```

On the development Mac, targeted process/supervisor/MCP normal tests, race tests
and vet passed. Windows amd64 `go test -exec=true` cross-compilation and vet
passed; **no Windows tests executed**. This does not count as a native pass, nor
as a full-repository pass. Independent security review approved only this
disabled, private policy/token slice and repeated those local checks. The
API/SDK sources below inform the boundary; they do not replace native evidence.

### Owned-profile suspended-token fixture (test-only, native pass pending)

`appcontainer_fixture_windows_test.go` binds userenv through SystemDLL, interprets
low-32-bit HRESULTs (not GetLastError), and passes NULL capabilities/count zero.
Only ephemeral GitHub-hosted Windows CI may invoke these bindings. Each subtest
uses a random UUID-v4 `pi-local-ci-v05-` name; only S_OK establishes ownership.
Already-exists is a failure with no deletion authority. Other outcomes report
partial-creation uncertainty and the exact name, never blindly delete or scan.
The returned SID is copied into Go storage before FreeSid. Fake API cases check
copy survival, collision/uncertain outcome refusal, nil SID, FreeSid/delete error
propagation, exact-name deletion and idempotence. The cleanup guard's fake cases
also cover attempted launch without a retained handle (token/duplicate failure),
close without a signaled WAIT witness, signal without close, sticky cleanup
uncertainty, and signaled-and-closed idempotent deletion. Before any launch attempt,
S_OK-owned profiles can be deleted even when SID provisioning failed; existing or
ambiguous creation never grants deletion authority. These Windows-only tests have
only been cross-compiled here, not executed on the Mac.

The native gate copies the current trusted Go test image into a fresh blank
owned temp directory, checks NTFS/no-reparse and single-link regular-file status,
and changes no ACLs (especially not on the original image or its parents).
On success, three bounded repetitions each exercise zero-capability LPAC
hard-stop, post-verification cancellation and injected failure. After the first
failed subtest (including cleanup failure), the already-failed parent returns
without provisioning further profiles; the failed gate is not skipped or passed.
Job/token hooks are nil:
`beforeResume` must be reached **exactly once after real job/token validation**,
with real exact-job recheck and a still-live suspended process. The hard-stop
case requires the exact `errWindowsAppContainerExecutionDisabled`, never an
access-denied, unsupported or generic startup error. The resume witness must
remain zero and itself cannot execute the target. Only one non-inheritable
SYNCHRONIZE duplicate is retained; after Start returns it must be signaled and
explicitly closed before exact-owned-profile deletion. The shared test-only
cleanup guard starts with no launch attempt and no postlaunch witness; it marks
the attempt immediately before calling startWindowsOwned. After an attempt,
deletion requires the retained duplicate's WAIT_OBJECT_0 witness, successful
close, and no recorded cleanup uncertainty. Cleanup errors fail the test and
remain sticky even after a successful emergency LIFO close. Synchronous launch
return alone is not evidence: its failure defer does not report all native
Terminate/Wait/Close errors. An early token/Create/DuplicateHandle failure with
no retained witness therefore preserves and reports the exact owned profile,
while the exact positive LPAC gate still fails. That profile may remain until
the ephemeral runner is discarded; this is not generalized recovery or a claim
of leak-free profile cleanup.
The earliest-marker absence is supplemental, not proof of denied/allowed writes.
No target instruction is intentionally executed. These repetitions are not a
restricted-child handle-growth proof or a profile crash-recovery implementation.

No image-read grants have been added. Initial suspended image mapping succeeded
in the first native attempt described below, but that is not an image-read or
filesystem access proof for other environments. ACCESS_DENIED must fail this
candidate gate; if encountered, the next reviewed step is minimum profile-SID
RX/Low-label ACLs on only a new fixture, not broad grants or waiving the positive
token gate.
This proves neither filesystem/network isolation nor shell compatibility; there
is no System32/runtime fallback. Profile-intrinsic folders and registry access
also preclude claiming that only fixture files exist.

Mac Go 1.26.10 process/supervisor/MCP normal/race/vet and Windows amd64
compilation/vet passed; these are local checks only. Baseline native CI
**39701058074** ran older commit `10eff97`, not these tests: its Windows normal
suite passed but Windows race hit checkptr in SID.IdentifierAuthority via
policy.snapshot. This branch now includes the separate SID helper fix from
`appcontainer-candidate`; this fixture does not duplicate that production fix.
Corrected-primitive native CI **39702054324** is separate and does not count as
native evidence for this fixture or its cleanup guard. An elevated GHA Windows
Server pass would still not establish standard-user Windows 11 behavior.

Independent review found an early-failure cleanup flaw: the first fixture version
assumed reap until a duplicate was obtained. Correction `1f1dd0f` requires the
explicit postlaunch witnesses described above; bounded re-review closed that
finding. The parent repeated Mac normal/race/vet and Windows compilation/vet
checks after the correction (`v05-owned-profile-cleanup-parent-gate`, exit 0).
None of those checks executed Windows-only fixture cases.

### First native fixture failure and fixed-size query correction

Native CI **39702898481** on `4d9168c` passed Mac/Linux normal, race and vet,
but Windows normal failed the real LPAC fixture; Windows race/vet did not run
after that failure. All nine profile creations returned S_OK. The suspended
atomic CreateProcessW, exact-job check and TokenIsAppContainer = 1 check were
reached successfully, then the zero-length TokenElevation (20) sizing probe
returned ERROR_BAD_LENGTH (24). Every subtest reported verified-callback = 0
and resume-witness = 0. No real profile-SID equality, capability count, Low
integrity or LPAC flag (46) verification was reached, nor a successful complete
LPAC token gate, retained-handle reap witness or exact-name profile deletion.
The cleanup guard correctly preserved/reported all nine exact owned profiles
because their postlaunch reap/close witnesses were missing; ephemeral runner
discard, not recovery cleanup, was the remaining boundary.

The correction separates fixed DWORD queries from variable records rather than
accepting ERROR_BAD_LENGTH or omitting elevation. The model deliberately returns
ERROR_BAD_LENGTH to zero-length fixed-field probes; contract tests require one
non-nil, aligned four-byte query, nil error and exact returned length. Failure
cases retain unsupported/denied/bad-length, changed-size, truncated/zero and
overreported refusal, including valid bytes plus an error. Existing bounded
variable/SID checks and checkptr-compatible SID parsing remain unchanged.
Microsoft's [TOKEN_ELEVATION layout](https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-token_elevation)
is one DWORD; pinned x/sys v0.49.0 `Token.IsElevated` likewise queries a direct
uint32 buffer and checks its returned size (its Boolean failure folding is not
used here).

Local Go 1.26.10 checks for this correction exited 0: Mac process/supervisor/MCP
normal tests, race tests and vet (`v05-dword-mac-gate`), plus Windows amd64
compilation with `go test -exec=true` and vet (`v05-dword-final-windows-cross-gate`).
No Windows tests executed locally, and no checkptr/race checks were disabled.

Corrected native Windows normal/race/vet execution remains pending parent review
and bounded security review. Local compilation does not verify these token or
fixture cases. Fixture changes stay isolated on `v05/appcontainer-fixtures`;
this is not approval to enable the candidate or merge fixtures into v0.5.

### Blockers before any restricted target may resume

All of the following remain unimplemented/unproven, not silently weakened:

- Native evidence for the prepared owned-profile suspended-token fixture above,
  including creation/image-read feasibility and successful exact-name cleanup.
  Crash cleanup still needs a trusted parent's retained exact generated name;
  no profile reuse, foreign deletion, scanning or orphan recovery is implemented.
- Fresh private single-link/no-reparse NTFS fixtures only: a copied static Go
  helper exe (RX), blank workspace/temp (RW), and minimum SID ACLs plus Low
  integrity labels before target access. Never rewrite the existing test exe,
  installed application or an existing tree. Outside-fixture ACL/content
  negative controls must stay unchanged. General filesystem grants, migration
  and profile journals require a separate review.
- Real positive execution and earliest-marker ordering only after both exact
  token and job verification; failures at all gates must terminate/reap without
  a marker. Add restricted-child capability/SID/query/membership/cancel/resume
  fault injections and restricted success/failure handle-growth measurements.
- Query NetworkIsolation loopback exemptions for that exact profile; refuse
  unexpected exposure without modifying global exemptions. Prove IPv4/IPv6
  loopback and synthetic control named-pipe denial where possible, never using
  internet or live application endpoints. Record common OS/SystemDLL/intrinsic
  access rather than claiming only fixture directories exist.
- Prove workspace writes, outside fake credentials/other-agent/control denial,
  parent inspection and unexpected-handle denial; restricted descendants,
  parent death, Close and profile cleanup; quoted Unicode paths/arguments and a
  reviewed environment allowlist. No real secrets, providers or user installs.
- A managed Go-helper-only network-off prototype comes first. Bash/cmd/
  PowerShell substitution is not a fallback. pi-durable 1.3 hardcoded Bash,
  taskkill and environment integration remain future work. Elevated GHA
  Windows Server execution would not prove standard-user Windows 11 product
  behavior; unsupported APIs or unsafe ACL uncertainty must remain blockers.

Additional sources inspected for this slice:

- Pinned x/sys v0.49.0 `windows/security_windows.go`,
  `zsyscall_windows.go`, `exec_windows.go`: SID Copy returns Go-owned storage;
  OpenProcessToken/GetTokenInformation use advapi32 via NewLazySystemDLL; the
  token helpers' unbounded retry loops are not used by this candidate.
- [SDK WinBase.h](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/WinBase.h)
  and [winnt.h](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/winnt.h):
  attribute indices 9/15, opt-out DWORD=1, SECURITY_CAPABILITIES layout,
  TOKEN_APPCONTAINER_INFORMATION and TOKEN_INFORMATION_CLASS numeric ordering.
- [Launch an AppContainer](https://learn.microsoft.com/windows/win32/secauthz/implementing-an-appcontainer):
  explicit LPAC opt-out attribute and additional intrinsic resource restrictions.
- [GetTokenInformation](https://learn.microsoft.com/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation)
  and [TOKEN_INFORMATION_CLASS](https://learn.microsoft.com/windows/win32/api/winnt/ne-winnt-token_information_class):
  query-only access, buffer contracts, token classes and LPAC definition.
- [CreateAppContainerProfile](https://learn.microsoft.com/windows/win32/api/userenv/nf-userenv-createappcontainerprofile):
  HRESULT, existing-profile refusal and FreeSid ownership (now bound only by the
  CI-only test fixture; not a production facility or a native pass).
- [DeleteAppContainerProfile](https://learn.microsoft.com/windows/win32/api/userenv/nf-userenv-deleteappcontainerprofile):
  exact-name profile deletion and HRESULT failure reporting.

## Sources inspected

- Go 1.26.7 `src/syscall/exec_windows.go`: SysProcAttr has no job-list attribute;
  StartProcess builds handle attributes but closes the primary thread handle.
  `src/os/exec/exec_windows.go`: ignore broken/no-data stdin pipe errors.
- x/sys v0.49.0 `windows/exec_windows.go`, `types_windows.go`: attribute list
  container, ComposeCommandLine, STARTUPINFOEX and job limit structures.
- [Windows SDK WinBase.h](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/WinBase.h):
  ProcThreadAttributeJobList=13 and ProcThreadAttributeValue(13,FALSE,TRUE,FALSE)
  = 0x0002000d (local constant because x/sys does not export it).
- [UpdateProcThreadAttribute](https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute): JOB_LIST and inheritable HANDLE_LIST.
- [Job Objects](https://learn.microsoft.com/windows/win32/procthread/job-objects): nested jobs, inheritance, breakaway and kill-on-close.
- [IsProcessInJob](https://learn.microsoft.com/windows/win32/api/jobapi/nf-jobapi-isprocessinjob): exact supplied-job membership query.
- [GetFileType](https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getfiletype): reviewed file kinds and UNKNOWN/GetLastError ambiguity. x/sys's `windows/zsyscall_windows.go` captures type/error in the same call; UNKNOWN with zero last error maps to EINVAL in this version, also rejected.
- [DuplicateHandle](https://learn.microsoft.com/windows/win32/api/handleapi/nf-handleapi-duplicatehandle): converts pseudo process/thread handles into real handles; invalid stdio must never reach it.
- [AssignProcessToJobObject](https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject) and [basic job limits](https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information): active-process limit admission failure and nested-job constraints.
- Test-only handle snapshot layout: [PHNT ntpsapi.h](https://github.com/winsiderss/phnt/blob/master/ntpsapi.h), `PROCESS_HANDLE_TABLE_ENTRY_INFO` / `PROCESS_HANDLE_SNAPSHOT_INFORMATION`. Failure/incomplete classification degrades diagnostics only, never disables the total-count gate.
