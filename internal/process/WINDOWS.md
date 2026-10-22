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

After suspended CreateProcessW and exact owned-job verification, the candidate
opens TOKEN_QUERY through the retained process handle, never the numeric PID.
Before reaching the common resume gate it requires:

- TokenIsAppContainer (29) = 1 and TokenElevation (20) = 0;
- TokenAppContainerSid (31) exactly matching the copied profile SID;
- TokenCapabilities (30) GroupCount = 0 (no network capability);
- TokenIntegrityLevel (25) with an integrity label exactly S-1-16-4096 (Low);
- TokenIsLessPrivilegedAppContainer (46) = 1 when LPAC was selected. Unsupported
  LPAC attributes/queries are refusal, not permission to downgrade.

Token queries use an aligned, at-most-64-KiB allocation, one bounded sizing call
and one fetch, explicit returned-length checks, and SDK-shaped native headers.
Embedded SIDs must fit entirely after their header inside the returned allocation
before any SID API interprets them. No returned pointers escape verification.
The query-only token closes on every exit; existing owned-process/job
termination, reaping, stdio and attribute cleanup cover candidate failures too.

**Even a successfully verified candidate is deliberately refused before
ResumeThread**, with `errWindowsAppContainerExecutionDisabled`. There is no
switch or environment variable that enables execution. This hard stop is needed
because zero capabilities alone do not establish the required network/IPC and
filesystem boundary. In particular loopback exemptions have not been queried.
No production profile, ACL, named pipe or network mutation is implemented here.
The test-only owned profile below is not a user profile; no installed executable
or real credential store is a fixture.

### Prepared tests and missing evidence

`appcontainer_windows_test.go` has synthetic SID/layout/ownership checks; exact
zero-capability/LPAC attribute checks; malformed, oversized, truncated and failed
token-query cases; wrong/missing profile SID, capabilities, integrity, elevation
and LPAC refusal; invalid embedded SID bounds; and required-attribute failures
before target creation/stdio duplication with no marker. A native ordinary-child
negative control queries its retained token while suspended, refuses it as not
AppContainer, and checks that ordinary launch still has exactly two attributes
and no earliest child marker. The existing Job suite still supplies
verify/membership/cancel/resume, strict handle inheritance, descendants, abrupt
owner death, Unicode and cleanup regressions. Synthetic token buffers are **not**
observations of a real AppContainer token. The real restricted-child token path
now has the suspended-only fixture below, still awaiting native execution.

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

### Owned-profile suspended-token fixture (test-only, native result pending)

`appcontainer_fixture_windows_test.go` binds userenv through SystemDLL, interprets
low-32-bit HRESULTs (not GetLastError), and passes NULL capabilities/count zero.
Only ephemeral GitHub-hosted Windows CI may invoke these bindings. Each subtest
uses a random UUID-v4 `pi-local-ci-v05-` name; only S_OK establishes ownership.
Already-exists is a failure with no deletion authority. Other outcomes report
partial-creation uncertainty and the exact name, never blindly delete or scan.
The returned SID is copied into Go storage before FreeSid. Fake API cases check
copy survival, collision/uncertain outcome refusal, nil SID, FreeSid/delete error
propagation, exact-name deletion and idempotence; these Windows-only tests have
also only been cross-compiled here.

The native gate copies the current trusted Go test image into a fresh blank
owned temp directory, checks NTFS/no-reparse and single-link regular-file status,
and changes no ACLs (especially not on the original image or its parents).
Three bounded repetitions each exercise zero-capability LPAC hard-stop,
post-verification cancellation and injected failure. Job/token hooks are nil:
`beforeResume` must be reached **exactly once after real job/token validation**,
with real exact-job recheck and a still-live suspended process. The hard-stop
case requires the exact `errWindowsAppContainerExecutionDisabled`, never an
access-denied, unsupported or generic startup error. The resume witness must
remain zero and itself cannot execute the target. Only one non-inheritable
SYNCHRONIZE duplicate is retained; after Start returns it must be signaled and
explicitly closed before exact-owned-profile deletion. Cleanup errors fail the
test; uncertain reap/duplicate closure blocks deletion and reports the name.
The earliest-marker absence is supplemental, not proof of denied/allowed writes.
No target instruction is intentionally executed. These repetitions are not a
restricted-child handle-growth proof or a profile crash-recovery implementation.

No image-read grants have been added: whether initial suspended image mapping
works without them is **unproven**. ACCESS_DENIED must fail this candidate gate;
if encountered, the next reviewed step is minimum profile-SID RX/Low-label ACLs
on only a new fixture, not broad grants or waiving the positive token gate.
This proves neither filesystem/network isolation nor shell compatibility; there
is no System32/runtime fallback. Profile-intrinsic folders and registry access
also preclude claiming that only fixture files exist.

Mac Go 1.26.10 process/supervisor/MCP normal/race/vet and Windows amd64
compilation/vet passed; these are local checks only. Baseline native CI **39701058074** ran older commit `10eff97`,
not these tests: its Windows normal suite passed but Windows race hit checkptr
in SID.IdentifierAuthority via policy.snapshot. The separate fix from
`appcontainer-candidate` must be reviewed/merged before native race CI; this
fixture does not duplicate that production fix. An elevated GHA Windows Server pass would
still not establish standard-user Windows 11 behavior.

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
