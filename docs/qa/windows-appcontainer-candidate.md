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

## Next gate and non-goals

Investigate a documented, owned non-elevated primary-parent token on ephemeral
CI, with actual token inspection and atomic Job/HANDLE_LIST lifecycle. Do not
relax elevation checks, impersonate a thread and assume CreateProcessW changes
its primary context, use undocumented token flags, or change global UAC/security
policy. Unsupported prerequisites remain a red gate, never a skipped success.

Actual restricted execution, filesystem grants/Low labels, network/loopback and
broker/control IPC denial, restricted descendant teardown/resource growth,
standard-user Windows 11 behavior and product packaging remain unverified.
No real vault, provider data, user installation or normal app is a fixture.
