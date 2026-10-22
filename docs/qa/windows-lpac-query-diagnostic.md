# LPAC query-size diagnostic — OFF, native gate still red

This isolated diagnostic starts from `2a2e19b`. It does not change production
code, the DWORD verification contract, execution authorization or cleanup.
The parent environment reserved-component correction has passed bounded review
and local parent gates; its Windows-only cases still need native execution.

## Prior native evidence, not acceptance

Run **39713897288** at `00da7db` observed the filtered exact five-key environment
allow CreateProcessAsUserW to succeed. The retained suspended child passed
AppContainer=1, elevation=0, exact profile SID, zero capabilities and Low
integrity. The final aligned DWORD query for information class **46** returned
**ERROR_INVALID_PARAMETER (87)** in normal and race lanes. Verified callbacks=0,
resumes=0; profile preservation/cleanup remained uncertain. The gate stays red.
Existing environment/path fakes may have native corrections, but those remain
unverified here.

SDK enumeration 46 is confirmed; the current WDK documentation describes a
DWORD with nonzero meaning true. That does **not** establish Win32 public API
user-mode availability or an accepted buffer size. Neither a one-byte API
change nor an NtQueryInformationToken fallback is justified.

## Bounded test-only observation

The existing private `windowsLaunchHooks.tokenInformation` seam already runs
inside verification on the launcher's retained suspended-child QUERY-only token.
The native fixture supplies **`windows.GetTokenInformation` itself**, not a fake.
Only when class 46 is reached, the wrapper synchronously issues exactly three
additional queries on that same borrowed token, requesting **1, 4, 8 bytes** in
that order. Each uses fresh zeroed, aligned, owned eight-byte Go storage and an
initialized returned-length DWORD. No diagnostic buffer values are read, parsed,
accepted, logged or used to size allocations. No token is opened, closed or
reopened; handle rights and lifetime are unchanged.

Each observation contains only requested size, success, immediate returned-error
classification via `errors.As` to `syscall.Errno` (numeric-code-present and code),
and returned length. Unknown errors have no numeric code and no error strings.
**A failed query's returned length is not authoritative.** Logs add only these
numeric/boolean observations and neutral context; no token, handle, SID, profile
path, environment data, key names or privilege names. Existing owned-profile ID
logs are unchanged.

After the observations the wrapper performs the **original real query with the
same token, class, buffer pointer, requested length and returned-length pointer**,
forwarding its writes and exact error unchanged. The original four-byte query
alone remains authoritative. Diagnostic failures are not launch failures, nor are
diagnostic successes launch authorization. Even all three succeeding would not
prove LPAC readiness. There is no retry/fallback, error waiver, BOOLEAN gate,
ntdll call, allowed resume, UAC/global/ACL change or profile repair.

The unconditional OFF stop, suspended launch, four startup attributes, existing
token/elevation predicates and S_OK-only cleanup guard are untouched. If the
original DWORD query still returns 87, the native fixture must still fail with
verified=0/resumed=0 and preserve/report uncertain profile cleanup. The nine
native fixture cases remain **pending**, not accepted; first-failure stop remains.

## Validation and review boundary

Windows-only fakes cover 1/4/8 then original 4, other-class passthrough, borrowed
identity and original pointer/length identity, exact original error/output
forwarding, mixed/numeric/unknown errors, hostile buffer values and huge returned
lengths, and diagnostic non-authority. The owned storage uses no uintptr-to-pointer
metadata helpers and retains lifetime through each synchronous call.

Local validation used Go **1.26.10**, darwin/arm64, for
`./internal/process ./internal/supervisor ./internal/mcp`:

- macOS `go test -count=1 -timeout=10m`: **exit 0**.
- macOS `go test -race -count=1 -timeout=10m`: **exit 0**.
- macOS `go vet`: **exit 0**.
- Windows amd64 and arm64, `CGO_ENABLED=0`: each package's `go test -c`
  and each architecture's three-package `go vet`: **all exits 0**.

Source-only cross-compilation is **not execution of Windows fakes or native
fixtures**. The existing Windows jobs workflow adds only this isolated branch to
its push allowlist; no results are waived. Parent full-source review and bounded
independent security review approved this diagnostic only. The parent repeated
macOS process/supervisor/MCP normal/race/vet and Windows amd64 compilation/vet,
plus workflow YAML/actionlint (`v05-lpac-query-probe-parent-gate`, exit 0).
Actual Windows execution and the full native gate remain pending; no native
Windows acceptance is claimed by this change.
