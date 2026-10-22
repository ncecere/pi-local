# Windows AppContainer candidate — disabled, native acceptance incomplete

This branch is not an executable sandbox or Windows desktop acceptance. Public
process Start retains ordinary owned-Job lifecycle containment; the private
AppContainer candidate unconditionally refuses before ResumeThread. Runtime
Win32 sandbox support remains unavailable. The normal-profile app is untouched.

## Reviewed slices and observed gates

- Primitive `0bbee59` and SID correction `d1ecfb0`: independent security review
  approved only the disabled private policy/token scope. Initial native CI
  39701058074 passed Windows normal and macOS/Linux, but Windows race/checkptr
  crashed in x/sys's SID-authority interior-pointer helper. The correction
  parses exact bounded canonical SID bytes; no race/checkptr weakening.
- Corrected native CI 39702054324 passed normal/race process/supervisor/MCP and
  vet on macos-15, ubuntu-24.04 and windows-2025. It exercised synthetic token
  parsers, attribute refusal and ordinary suspended-child negative controls,
  not a real restricted token. Integrated primitive gates are recorded in
  the v0.5 branch's `docs/qa/v0.5.md`.
- Test-only owned-profile fixture `90945eb`, cleanup correction `1f1dd0f`:
  independent review found and then closed a missing-reap-witness deletion
  flaw. Post-attempt deletion now requires a retained-handle WAIT_OBJECT_0
  witness, successful close and no sticky cleanup uncertainty. Missing
  witnesses preserve and report the exact owned profile. Existing/ambiguous
  creation never grants deletion authority. Mac tests and Windows compilation
  are not execution of these Windows-only guards.

## Real-profile fixture failures (not passing confinement evidence)

Native CI 39702898481 at `4d9168c` passed macOS/Linux but failed Windows normal
before its race step. Nine fresh, random, synthetic profile creations returned
S_OK. Suspended creation, exact Job membership and TokenIsAppContainer=1 checks
succeeded; the null/zero-sized TokenElevation sizing query failed with
ERROR_BAD_LENGTH. No post-verification callback or resume occurred. The cleanup
guard preserved/reported profiles without retained reap witnesses, on the
otherwise disposable hosted runner; no leak-free cleanup claim is made.

Correction `0d3824b` queries fixed DWORD classes 29/20/46 exactly once into an
aligned non-null four-byte buffer. Both nil error and returned length four are
required; canonical values remain mandatory. Variable record bounds and the
execution stop are unchanged. Bounded security review and parent Mac
normal/race/vet plus Windows compilation/vet passed. Success still requires all
nine fixture cases; after any unexpected subtest failure, further profile
provisioning stops while the parent test remains failed.

Native CI 39703803283 at `0d3824b` passed macOS/Linux but failed Windows normal:
the fixed TokenElevation query succeeded and returned **1** for the AppContainer
child (LPAC requested but not yet verified) from the administrator hosted-runner
context. The required value is 0,
so refusal was correct. The first fixture failed with verified callback=0 and
resumes=0; no further profiles were provisioned. The exact owned profile was
preserved/reported because no reap witness was retained. Remaining SID,
capability, integrity and LPAC checks were not reached; race execution of the
new fixture was not established.

## Restricted-primary / CreateProcessAsUser candidate (native gate pending)

The separate token-only diagnostic at `1fbc6bf` (CI 39707791990) observed
CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | LUA_TOKEN) produce elevation=0,
High integrity. Lowering **only the derived** token to Medium preserved the
captured original fields. Linked/SAFER candidates had remained elevation=1.
Those results are metadata observations, not launch authorization. In particular,
the old diagnostic's unknown-*enabled* check did not reject every disabled,
unknown privilege's presence. Neither diagnostic native entrypoint was copied
here: ordinary full Windows tests must not activate the diagnostic's separate
explicit-opt-in fatal prerequisite.

This slice adds only a private borrowed `windowsLaunchHooks.primaryToken` seam:
zero retains CreateProcessW; nonzero requires a non-nil policy and a real,
queryable primary-token handle before creation. It dispatches directly through
x/sys's existing CreateProcessAsUserW wrapper, with the same descriptor,
STARTUPINFOEX, SECURITY_CAPABILITIES, LPAC opt-out, JOB_LIST, HANDLE_LIST, three
stdio duplicates, suspended/Unicode flags, retained handles and synchronous
failure cleanup. No helper executable runs first. The launcher never closes the
borrowed token; its test owner holds it until synchronous cleanup returns.
An independent nonzero-token stop and the existing policy stop both precede
ResumeThread. This is still not an executable sandbox.

### Source-backed API review

- Pinned x/sys v0.49.0 `windows/zsyscall_windows.go:715` exports
  `CreateProcessAsUser(Token, ..., *StartupInfo, *ProcessInformation)` and calls
  CreateProcessAsUserW directly; no dependency addition is needed.
- [CreateProcessAsUserW](https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw)
  accepts STARTUPINFOEX with EXTENDED_STARTUPINFO_PRESENT. The token needs
  TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY access. The restricted
  caller-primary exemption concerns **SeAssignPrimaryTokenPrivilege**, not
  those handle access rights. The API can enable existing necessary caller
  privileges (including SeIncreaseQuotaPrivilege) for the call. Before/after
  captured-field equality does **not** prove whole-token equality or absence of
  transient privilege enabling. No AdjustTokenPrivileges is used by this code.
- [CreateRestrictedToken](https://learn.microsoft.com/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)
  documents flags 0x1/0x4 and inherits input handle rights/type. The test opens
  its explicit current primary once with QUERY | DUPLICATE | ASSIGN_PRIMARY |
  ADJUST_DEFAULT, so the derived-only label prerequisite is requested upfront.
  No widening/reopen/retry, thread impersonation, linked/SAFER fallback or token
  assignment privilege acquisition is attempted. All three SID/privilege counts
  and array pointers are zero/NULL. The SystemDLL wrapper interprets BOOL, not
  HRESULT; alias/null/pseudo/partial-output ownership is checked.
- [Privilege constants](https://learn.microsoft.com/windows/win32/secauthz/privilege-constants)
  describe the narrow present-privilege exceptions: SeChangeNotifyPrivilege
  (traverse checking), SeIncreaseWorkingSetPrivilege (working-set size) and
  SeTimeZonePrivilege (timezone). This test-only choice is not a general proof
  of standard-user authority. Every other LUID is rejected **by presence**,
  including sensitive, disabled, removed-but-still-present and unknown entries.
- The exact combination **restricted primary + SECURITY_CAPABILITIES + LPAC +
  JOB_LIST + HANDLE_LIST** is not established by the individual API contracts.
  It requires native normal/race evidence. Profile/desktop/image-access
  incompatibility, privilege absence and unsupported attributes must fail, not
  trigger desktop ACL edits, LoadUserProfile, policy repair or ordinary launch.

### Strict test-only predicate and acceptance

The owned token must inspect completely as primary, elevation exactly zero,
canonical Default/Limited (never Full), exact Medium, same user and session,
Administrators/Power Users absent or strictly deny-only, and only the three
ordinary privilege IDs present. Every group SID/attribute and privilege
LUID/attribute is bounded and captured, not just enabled privileges. Fixed
fields use one aligned exact four-byte query; variable records are capped at
64 KiB and refuse changed sizes, malformed pointers/counts/attributes and
duplicates. Unknown/lower integrity cannot be raised. Only a distinct live
owned derived token with complete primary/identity metadata can be lowered
from an explicitly known higher integrity RID; actual postlabel metadata is
requeried. Original captured fields are witnessed after derivation and after
launch attempts; SID/session/LUID/handle values are not logged.

The existing hosted-CI-only fixture retains all 3x3 modes, real Job/child-token
checks, exact error/checked=1/resumed=0 expectations and first-failure stop.
It observes all four installed attributes, reads the S_OK-owned profile folder's
NTFS/reparse and DACL/mandatory-label ACL metadata without repairs, and uses a
fresh single-link executable copy. The actual child must pass elevation=0,
exact profile SID, no capabilities, Low integrity and LPAC before refusal.
The retained SYNCHRONIZE witness must be signaled and closed before profile
deletion; uncertain early failures still preserve/report the exact name.

Intended hosted gates, unchanged workflow: full process/supervisor/MCP normal,
race and vet on macOS, Linux and Windows. Local Mac checks and Windows cross
compilation are not native token/profile/attribute evidence. No native Windows
execution has been performed for this slice. Parent review and a separate
workflow branch-filter change must precede any native run.

Actual restricted execution, filesystem grants/Low labels, network/loopback and
broker/control IPC denial, restricted descendant teardown/resource growth,
standard-user Windows 11 behavior and product packaging remain unverified.
No real vault, provider data, user installation or normal app is a fixture.
