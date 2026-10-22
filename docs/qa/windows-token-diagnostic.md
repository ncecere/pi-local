# Windows token-only diagnostic — native result pending

Base: `2702c3f`; branch: `v05/appcontainer-token-diagnostics`.
This is a prerequisite measurement, not AppContainer/profile acceptance or a
launch-helper implementation. The earlier native run `39703803283` correctly
refused the suspended AppContainer child with TokenElevation=1. That refusal
and the unaccepted profile branch are not overridden here.

## Hard boundary

Only new Windows test files, this note and the dedicated workflow are added.
Production code, public Start's nil policy, the private before-resume refusal,
profile fixtures, runtime/candidate activation and existing workflow filters
are unchanged. In particular, `v05-windows-jobs.yml` still does **not** match
this branch: do not rerun its real-profile fixture from the administrator runner
while investigating tokens.

The diagnostic opens only the test process's primary token. It creates no
process/descendant/target, profile, directory, account or password; changes no
ACL, UAC/security policy, registry setting or privilege state; and uses no
impersonation, credential/vault/provider APIs or launch helper. It neither
opens nor signals the normal app (including PID 92423), and touches no normal
profile, Application Support, vault, CredMan or provider data. Go compilation
and test harness/cache activity are not token-diagnostic filesystem fixtures.

## APIs, ownership and bounded inspection

- `OpenProcessToken(CurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &owned)`:
  the process pseudo handle is only the documented input selector, never an
  owned handle. The resulting token is explicitly opened, owned and closed
  with `CloseHandle`; no token pseudo handle or thread-token fallback is used.
- Test-private DWORD queries for TokenElevation(20), TokenElevationType(18),
  TokenType(8) and TokenSessionId(12) each make exactly one aligned four-byte
  call and require success plus returned length **4**. The production DWORD
  allowlist remains 29/20/46.
- TokenIntegrityLevel(25), TokenUser(1), TokenGroups(2) and TokenPrivileges(3)
  use one probe and one fetch, bounded to 64 KiB, with exact returned length
  matching the probe. No resize/retry/fallback. Before native SID interpretation,
  word-aligned storage, array count/extents, embedded SID alignment/offset,
  revision, subauthority count and full byte extent are checked. SIDs must be
  beyond their complete header/array. BOOL SID validation, Len, Copy and Equals
  do not return native interior pointers. Integrity authority/count/RID are
  parsed from the bounded raw bytes, not x/sys IdentifierAuthority,
  SubAuthorityCount or SubAuthority (the prior checkptr hazard).
- Only a current TokenElevationTypeFull(2) source attempts TokenLinkedToken(19),
  exactly once into one pointer-sized output. That output **contains an owned
  token handle**, not a pointer to an allocation. The handle is closed even if
  the query reports a malformed length or error after populating output.
  Default(1) documents no UAC split-token link; other sources do not query it.
- Independently, `advapi32.dll` loaded with `NewLazySystemDLL` supplies
  `SaferCreateLevel(2, 0x20000, 1, &level, NULL)` and
  `SaferComputeTokenFromLevel(level, explicitProcessToken, &out, 0, NULL)`.
  These are documented **BOOL** returns, not HRESULTs; last-error is examined
  only on FALSE. The level uses **SaferCloseLevel**, and the output token uses
  **CloseHandle**. NULL output with flags=0 is failure. No SaferSetLevelInformation,
  policy mutation, MAKE_INERT, NULL_IF_EQUAL or CreateRestrictedToken experiment.
- Every non-null, non-reserved owned output is tracked on error paths too.
  Close attempts are idempotent and failures sticky; any close failure makes
  the test red, even with an otherwise qualifying token. Pseudo/invalid handles
  are rejected, never closed. Go-owned SID copies are not FreeSid allocations.

## Measured qualification, not inferred rights

A complete candidate inspection must establish primary TokenType=1,
TokenElevation **exactly 0**, canonical non-Full elevation type, integrity RID
**exactly 0x2000** under S-1-16, same user SID and session as the opened process
primary token. Linked candidates additionally must have Limited(3) elevation
type. Administrators and Power Users SIDs must each be absent or deny-only with
ENABLED clear; merely disabled is insufficient. Administrative privilege
classification uses the explicit public-name denylist in the test source,
including backup/restore, debug, impersonation, TCB, token creation/assignment,
load-driver and security/ownership privileges. All entries are inspected, not
just SeDebug. No denylisted privilege may be enabled. Enabled unknown privilege
LUIDs are conservatively refused. Ordinary SeChangeNotify, SeIncreaseWorkingSet
and SeTimeZone privileges may remain. Neither Admin membership nor Microsoft's
NORMALUSER description guarantees this predicate: elevation and integrity are
measured and mismatches refused. Disabled administrative privileges may remain
present and potentially be re-enabled; eligibility is metadata-only and must
not authorize launching. Any future launch authorization needs separate token
predicate hardening and independent validation, not reuse of this eligibility flag.

Both linked and SAFER outcomes/reasons are reported before deciding whether
there is any qualifying token. A verified linked limited token is preferred.
Any API/query/prerequisite/cleanup failure remains red, even if another token
qualifies. No qualifying token is a failure, never an unsupported/skip pass.
Successful qualification proves only inspectable token properties, not launch
rights, AppContainer behavior, confinement, Windows 11 parity or runtime safety.

Logs contain query class/phase, result code category and lengths; elevation
metadata, TokenType, IL RID; same-user/session **booleans**; only the two fixed
administrative groups' presence/attributes; public administrative privilege
names/attributes; eligibility and fixed refusal reasons. No user SID (or hash),
user/account name, SID/group dump, actual session ID, handles/addresses,
provider configuration or environment values are printed. Native error strings
are not logged.

## CI isolation and validation

The new push-only workflow matches **only** this branch and paths for its new
tests/workflow/go.mod/go.sum. It uses `windows-2025`, setup-go from go.mod and
only `^TestWindowsTokenDiagnostic(Native|Fake.*)$` in `internal/process`, normal
and race/checkptr; it does not run the package's other profile/process tests.
Strict PowerShell preflight requires GITHUB_ACTIONS=true,
RUNNER_ENVIRONMENT=github-hosted, RUNNER_OS=Windows and
PI_LOCAL_CI_TOKEN_DIAGNOSTIC=1. The native API boundary rechecks all four.
Missing prerequisites in an explicit/CI request are fatal. Only a completely
non-opted-in developer run may skip the native diagnostic; fake cases still run.
No Windows runtime execution has been performed locally.

Local Go 1.26.10 on macOS arm64: normal and race tests for process/supervisor/MCP,
then vet for all three, exited **0**. Windows amd64 CGO-disabled test compilation
(no execution) and vet for all three exited **0**. The dedicated YAML parses;
the author also observed actionlint v1.7.7 pass. The parent repeated those Go
normal/race/vet, Windows compilation/vet, YAML and unchanged-tracked-file checks
(`v05-token-only-diagnostic-parent-gate`, exit 0). Fake cases cover DWORD lengths/no-probe, bounded variable records,
SID/array malformations, full qualification/privilege traversal, sanitized
output, independent candidate reporting, CI prerequisites and owned lifetime
failures. These Windows fake cases have been compiled, **not run on macOS**.

Parent full-source review and independent security review approved only this
diagnostic scope; no findings blocked the measurement. The first native result
is recorded below. Compilation alone does not establish qualifying tokens or
native fake/race/checkptr acceptance. No launch/profile stage is approved.

## First native measurement — no qualifying token

Windows CI [39705935257](https://github.com/ncecere/pi-local/actions/runs/39705935257)
at `7a9fe47` completed normal fake cases and real token inspection, then correctly
failed because neither supported candidate qualified. The current primary token
was Default(1), elevated(1), Primary(1), High integrity (0x3000), with enabled
Administrators membership. Default has no UAC-linked limited token; no linked
query was attempted.

SAFER NORMALUSER inspection completed with matching user/session, Primary type,
deny-only Administrators membership and no enabled administrative/unknown
privileges, but retained elevation=1 and High integrity (0x3000). It was refused
for both reasons. No child, profile, account or policy mutation occurred. No
cleanup error was reported; native handle-growth behavior was not measured.
The workflow stopped at the failed normal diagnostic; race/vet steps were not
established by this run. The red prerequisite is not a token-parser failure,
unsupported success, or permission to relax elevation/integrity requirements.

A separate owned-token restriction-only experiment may be evaluated next,
after independent review. It must not mutate the input/process token, launch a child or alter global
policy, and its metadata eligibility still cannot authorize launch. Otherwise,
a separately provisioned genuine standard-user runner remains required.

### Official API references

- [SaferCreateLevel: BOOL signature, scope/level/open constants](https://learn.microsoft.com/en-us/windows/win32/api/winsafer/nf-winsafer-safercreatelevel)
- [SaferComputeTokenFromLevel: BOOL, explicit input and flags](https://learn.microsoft.com/en-us/windows/win32/api/winsafer/nf-winsafer-safercomputetokenfromlevel)
- [SaferCloseLevel: separate level-handle close](https://learn.microsoft.com/en-us/windows/win32/api/winsafer/nf-winsafer-safercloselevel)
