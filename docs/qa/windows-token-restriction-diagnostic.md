# Third bounded Windows token-only diagnostic — metadata predicate passed

Base `7a9fe47`; branch `v05/appcontainer-restricted-token-diagnostics`.
This is the LAST bounded owned-token experiment before requiring a standard
runner if no candidate qualifies. No deployment or launch change is approved.

## Existing evidence (reported first-stage native run)

Run `39705935257`: all normal fake cases passed and inspection completed.
Current primary: Default elevation type (1), elevation 1, High IL (0x3000),
Administrators enabled. No linked-token query was appropriate or attempted.
SAFER NORMALUSER: same user/session, primary (1), Administrators deny-only,
no enabled administrative privileges, but still elevation 1 and High IL.
The native gate correctly failed, no child/profile was created, and that
workflow's race stage did not run after its normal-stage failure. These facts
are prior evidence, not results from this new experiment.

## Documented experiment and boundaries

Only new Windows tests, a dedicated workflow and this note are added. Existing
1181-line token_diagnostic test pair, first diagnostic workflow and owned-jobs
workflow remain byte-identical. Their push branch filters exclude this branch.
No production, launch, profile, ACL, UAC, account, current/process-token or
privilege adjustment; no impersonation, password, credential, provider or
network probe. No contact with the living app/PID 92423, vault, CredMan,
Application Support or real user-profile data. Build/test caches are harness
activity, not diagnostic fixtures.

The test opens only its own explicit primary token with TOKEN_QUERY |
TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT, then calls SystemDLL advapi32 CreateRestrictedToken with
DISABLE_MAX_PRIVILEGE (0x1) | LUA_TOKEN (0x4), all three counts zero and all
three array pointers NULL. Current Microsoft Learn and Microsoft's SDK
winnt.h document LUA_TOKEN, not a reserved flag. No claim that it normalizes
elevation follows from that documentation. BOOL return handling ignores stale
last error on success. Owned real outputs are closed even on partial failure;
input aliases/pseudo handles cannot reach candidate inspection or label writes.
Close failures remain red and are never retried.

After complete prelabel inspection, a distinct live owned derived token must
be primary, same user/session and have a recognized SDK integrity RID. Below
medium is refused (no increase); exact medium requires no Set. Higher known
IL permits only a downward SetTokenInformation(TokenIntegrityLevel) attempt on
that derived object, using an aligned TOKEN_MANDATORY_LABEL and embedded,
Go-owned S-1-16-8192 SID, exact header+12-byte extent and KeepAlive through return.
CreateRestrictedToken retains input handle access rights, so the derived-label
prerequisite TOKEN_ADJUST_DEFAULT is requested explicitly on the initial open,
not added by reopening after a failure. The input handle is never a label-write
target: distinct owned-output checks and before/after inspected-field witnesses
remain mandatory. No privilege enabling or access-retry fallback is attempted.
A denied label operation stays red even if later metadata happens to qualify.

Full actual postlabel metadata is re-queried, including after Set failure.
Qualification requires primary=1, elevation EXACTLY 0, canonical non-Full type,
exact medium IL 0x2000, same user/session, Administrators/Power Users absent or
deny-only with enabled clear, no enabled administrative or unknown privilege.
Elevation 1 is never waived. An unchanged witness strictly compares every field
captured by diagInspect before/after, not whole-token identity. SID/session
values, handles, addresses, token IDs and raw native error strings are not logged.
Qualification is METADATA ONLY: disabled admin privileges may be enableable;
this proves neither launch authorization, standard-user security nor confinement.

## Tests and observed local gates

New fake cases cover ownership/aliases/pseudo handles, exact flags and NULL
parameters, partial errors, BOOL semantics, downward-only label payload bounds,
alignment/lifetime, prelabel identity/session/type gates, elevation refusal,
postlabel requery rather than assumption, malformed records, sticky failures,
privacy, four-exact-environment preflight and captured-field witness comparison.
Fakes acquire no real native token/profile/process.

macOS arm64 Go 1.26.10: process/supervisor/MCP normal tests **exit 0**, race
**exit 0**, vet **exit 0**. Windows amd64 cross-compilation of all three test
packages **exit 0** and cross-vet **exit 0**. These do not execute Windows tests.
Those gates preceded final fake-only additions; final process cross-build/vet
and actionlint results are recorded by the implementation commit check.
PyYAML validation, exact new-branch filter isolation, narrow test-name regex
and byte-identical prior-file checks **exit 0**. PowerShell itself is unavailable
locally; its aggregate-exit behavior has not been executed here.

The push-only windows-2025 workflow selects ONLY
`^TestWindowsTokenRestrictionDiagnostic(Native|Fake.*)$`, with setup-go from
go.mod and the reused four exact environment checks plus explicit opt-in.
Normal and race/checkptr run even when normal is red, then vet; all exit codes
are saved and any nonzero makes the aggregate fail. No old profile/child test
is selected. Only a completely non-opted-in developer Windows native function
may skip; explicit CI missing prerequisites/qualification/API/cleanup fails.

Parent full-source and independent security reviews approved DIAGNOSTIC ONLY,
including the explicit initial rights and known-RID corrections. No findings
blocked this measurement. Native Windows results are recorded below. No local Windows API execution was possible.
All APIs/flags used are documented. Local compilation did not measure their
behavior; only the scoped native observations below establish the tested result,
not portability or launch/confinement guarantees.

## Native result — not launch authorization

Windows CI [39707791990](https://github.com/ncecere/pi-local/actions/runs/39707791990)
at `1fbc6bf` passed normal/native/fake tests, race/checkptr and vet; aggregate
exit codes were `normal=0 race=0 vet=0`. Both native builds observed:

- A distinct restricted primary token with elevation **0**, Default type (1),
  initially High integrity (0x3000), same user/session, Administrators deny-only,
  no reported known administrative privileges and no unknown enabled privilege.
- After lowering only that derived token's label: elevation **0**, Medium
  integrity **0x2000**, and the same restricted group/privilege observations.
- The input process token's captured fields unchanged before/after.

No child/profile/account, ACL or global policy was created or changed by this
measurement. Native handle-growth and whole-token equivalence were not proved.
Metadata eligibility must not authorize launch: disabled/unclassified privilege
presence, process-creation rights, actual child token, atomic ownership and
confinement require separate stricter review and native verification. Earlier
red linked/SAFER and administrator-parent profile gates remain red evidence.

## Official references checked

- https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken
- https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-settokeninformation
- https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_mandatory_label
- https://learn.microsoft.com/en-us/windows/win32/secauthz/access-rights-for-access-token-objects
- https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/winnt.h
- https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/securitybaseapi.h

Final post-edit process Windows amd64 compilation **exit 0**, cross-vet
**exit 0**, diff whitespace check **exit 0**. Attempted actionlint returned
**exit 127** (command unavailable); actionlint is NOT validated here. YAML
validation above passed, but does not replace actionlint or Windows execution.

After the explicit up-front rights and conservative known-RID correction, the
parent repeated Go 1.26.10 Mac normal/race/vet, Windows compilation/vet, YAML and
whitespace checks; all passed (`v05-owned-restriction-diagnostic-parent-gate`,
exit 0). The parent also ran actionlint v1.7.7 through its pinned Go command;
that check passed, superseding the earlier unavailable-command result. These
checks still do not execute Windows-only native or fake cases.
