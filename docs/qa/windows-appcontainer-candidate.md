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

## Restricted-primary / CreateProcessAsUser candidate (native gate red)

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

The parent repeated Mac process/supervisor/MCP normal/race tests and vet,
Windows compilation/vet, whitespace and clean-source checks at `37cea8b`
(`v05-asuser-suspended-fixture-parent-gate`, exit 0). These do not execute the
new Windows native or fake cases. Independent security review approved only
the OFF suspended slice and repeated local normal/race/vet and Windows
compilation/vet successfully. That review approved the OFF suspended slice,
not execution or a passing native launch.

The workflow now explicitly selects this isolated branch and runs the full
process/supervisor/MCP normal, race and vet suites on macOS, Linux and Windows.
All three commands are attempted even after a failure; saved exit codes are
aggregated, and any nonzero result fails the gate. This environment correction
does not change that workflow.

### First AsUser native failure: historical evidence, not a passing gate

Native CI **39711691511** at `09f96dc` passed macOS/Linux. Windows completed
all required commands: **normal=1, race=1, vet=0**. Both Windows test builds
passed the strict derived-primary **presence** predicate, S_OK profile creation,
owned NTFS/reparse/DACL/mandatory-label observations and installation of all four
startup attributes. CreateProcessAsUserW then failed with
**ERROR_ENVVAR_NOT_FOUND (203)**, verified callbacks=0 and resumes=0. Each build
stopped after its first failed case and preserved/reported the owned profile
without a retained reap witness. The local historical log is
`.cache/asuser-first-native-failure.log`; it is not new acceptance evidence.

**203 does not identify which variable or attribute caused the failure.** The
older administrator/CreateProcessW fixture reached the elevation=1 refusal with
an inherited environment. The AsUser fixture simultaneously changed the token/
creation API and reduced the environment to SystemRoot (from the parent) plus
three synthetic helper keys. Those changes were confounded; neither the old
result nor this error proves an attribute incompatibility or a universal Windows
environment requirement.

### Narrow selected-environment counterfactual (native execution pending)

Primary sources support a bounded hypothesis, not a proven diagnosis:

- Chromium's [broker source](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/sandbox/win/src/broker_services.cc)
  uses CreateProcessAsUserW with extended suspended/Unicode startup information
  and explicitly retains LOCALAPPDATA: **"Needed for App Container processes."**
  Its [startup helper](https://chromium.googlesource.com/chromium/src/+/refs/tags/135.0.7049.99/sandbox/win/src/startup_information_helper.cc)
  composes SECURITY_CAPABILITIES, LPAC opt-out, JOB_LIST and HANDLE_LIST.
  Chromium's broader environment and other sandbox mechanisms are **not** copied
  here. These sources do not establish compatibility with our exact predicate.
- [GetSystemWindowsDirectoryW](https://learn.microsoft.com/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemwindowsdirectoryw)
  supplies the authoritative OS directory; it need not be on a particular drive
  or have a particular directory name. Pinned x/sys v0.49.0 already wraps it.
- [CreateEnvironmentBlock](https://learn.microsoft.com/windows/win32/api/userenv/nf-userenv-createenvironmentblock)
  returns a double-NUL Unicode block for the given token; FALSE means do not
  inherit the current process environment. It supplies no allocation length and
  returns BOOL, not HRESULT. [DestroyEnvironmentBlock](https://learn.microsoft.com/windows/win32/api/userenv/nf-userenv-destroyenvironmentblock)
  frees that allocation and also returns BOOL. User-profile-dependent variables
  are not guaranteed when a profile is not loaded; this fixture does **not** load
  one and treats missing selected metadata as a red prerequisite.

The test-only helper calls CreateEnvironmentBlock with the existing **derived**
token and **FALSE**, checks its selected SystemRoot against the authoritative OS
root, and retains only LOCALAPPDATA and that authoritative root. Both paths must
be nonempty, fully qualified, valid local DOS metadata paths; there is no assumed
OS location or empty explicit SystemRoot. The only parent-environment observation
is a single SystemRoot lookup, reported as four booleans (present/nonempty/
absolute/case-normalized equal). No value, user identity, profile SID, actual path
or provider credential is printed or written to artifacts.

The target receives exactly **five** keys: **SystemRoot**, **LOCALAPPDATA**,
**PL_WINDOWS_JOB_HELPER**, **PL_WINDOWS_JOB_MODE**, **PL_WINDOWS_JOB_DIR**. The
last three retain their existing synthetic values. PATH, COMSPEC, TEMP/TMP,
USERNAME, USERPROFILE, APPDATA, provider and loader environment are not restored.
LOCALAPPDATA is only current ephemeral CI user metadata; no personal filesystem
contents are opened. No registry read, GetAll process-environment read,
GetUserProfileDirectory, LoadUserProfile, fallback/retry, attribute removal,
security repair, account/UAC/ACL change or USERPROFILE expansion is added.

The native reader trusts the documented API allocation and termination, with a
64-KiB (32,768 UTF-16 code-unit) scan cap, 8,192-unit entry cap and 1,024-entry
cap; the cap is **not** a claimed allocation length. It advances from a live raw
pointer without fabricating an oversized slice. It scans unknown entries without
copying their values; only the two case-insensitive selections become strings.
Duplicate selections, malformed/oversized/truncated data, missing metadata and
invalid/mismatched paths fail closed. Synthetic parser tests instead use an
explicitly bounded slice, never native-pointer reads.

Every nonnil returned block, including partial output on API failure, receives
one destruction attempt. A destruction failure is sticky/redacted and clears
the selected result. Preparation, validation and destruction finish **before any
profile provisioning**. Fake dependency injection has no native fallback and
checks token/FALSE arguments, selection/casing/duplicates/bounds, five-key Unicode
payload/double NUL, synthetic FakeSecret exclusion, malformed paths, ownership,
close failure and data-free errors. The creation API, derived token helper,
application/cwd, four attributes, suspension, real child checks, both independent
hard stops, witness requirement and S_OK-only deletion authority are unchanged.
Production/runtime APIs, windowsDescriptor and the normal app are untouched.

Local Go 1.26.10 macOS process/supervisor/MCP normal/race tests and vet plus
Windows amd64 compilation/vet passed. The parent repeated those gates and
clean-source/whitespace checks at `b745649`
(`v05-asuser-filtered-environment-parent-gate`, exit 0). They do not execute the
Windows-only fake or native cases. Parent full-source and bounded independent
security reviews approved this correction only; native cause and the full
nine-case normal/race gate still require deliberate push and actual results. Only a new complete nine-case native pass could support
this **minimal counterfactual**; it would not establish universal Windows
environment requirements or erase the historical 203 result.

### Reserved-component fixture correction (new native gate pending)

Native CI **39713897288** remained red in both Windows normal and race runs:
`TestWindowsAppContainerEnvironmentPathsAndLegacy` reported an accepted invalid
path without a case label. Separately, the five-key environment reached successful
CreateProcessAsUserW and child elevation=0/SID/capability/Low-integrity checks,
but class 46 returned ERROR_INVALID_PARAMETER (87). That distinct LPAC query
failure is not addressed here; no full native acceptance is claimed. The earlier
203 failure and its historical log remain unchanged.

Go 1.26.10 `src/internal/filepathlite/path_windows.go:isReservedName` delegates
reserved names with extensions to `RtlIsDosDeviceName_U`, explicitly allowing
Windows-version-dependent answers. This establishes a policy gap; the original
zero-based case 17 is the source-backed suspect, not a newly observed native
case result. The test-only validator now explicitly rejects component basenames
CON/PRN/AUX/NUL/CONIN$/CONOUT$ and COM/LPT plus 1–9 or superscript ¹/²/³,
case-insensitively before extensions (including spaces before the extension).
Existing validation remains in place; no accepted input class is broadened.

Original bad cases retain their order with index-only subtest labels. Additional
synthetic cases cover reserved suffixes/ancestor components, dot traversal,
ordinary non-device counterexamples, and ASCII/BMP/supplementary UTF-16 entry
boundaries. The conservative path byte cap and parser code-unit cap are unchanged.
The exact five-key environment, authoritative-root/legacy behavior, launcher,
primary-token helper, flags, native queries and lifetimes are untouched. macOS
tests and Windows compilation/vet cannot execute these Windows-only cases;
parent review, bounded independent review and new native normal/race/vet evidence
remain required before calling the correction accepted.

Actual restricted execution, filesystem grants/Low labels, network/loopback and
broker/control IPC denial, restricted descendant teardown/resource growth,
standard-user Windows 11 behavior and product packaging remain unverified.
No real vault, provider data, user installation or normal app is a fixture.
