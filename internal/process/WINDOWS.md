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
