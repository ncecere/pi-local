# Windows LPAC semantic checker — private, unwired, OFF

## Scope and evidence

This increment adds only a package-private Windows helper. It does not call the
helper from `startWindowsOwned`, replace the authoritative selector46 verifier,
resume a process, provision a profile, change capabilities or ACLs, or enable
network/IPC access. `appcontainer_windows.go` and the existing native diagnostic
remain unchanged. No relaxed `lpac=false` policy is fabricated to bypass a
selected policy.

The parent-reported, reviewed **test-only** diagnostic `17fdb6b`, native run
**39721890954**, observed LPAC controls **DENY / DENY / ALLOW** and ordinary
AppContainer controls **DENY / ALLOW / ALLOW**. Windows normal/race injected and
paired tests passed, with zero resumes and independent signaled-and-closed
cleanup witnesses. The original candidate still fails selector46 with error87.
These are historical diagnostic observations, **not native execution or
acceptance of this production helper**. Independent review conditionally
approved a fixed behavioral contract for the OFF primitive, not an error
fallback, undocumented flag equality or universal confinement.

## Controlled-creation limitation (mandatory)

The matrix is suitable **only for controlled creation through retained own child
handles**, using the exact creation profile known independently of the token.
It is not a classifier for arbitrary handles, PIDs or externally supplied
restricted-token lookalikes: such tokens can mimic the same read-grant matrix.
A successful check does not prove a universal LPAC flag, complete token equality,
absence of concurrent token mutation, or confinement of files, network or IPC.

Unexpected restriction/group configurations and hostile broker-equivalent token
mutation remain **activation gates**. This increment does not enumerate every
restriction/group or establish an anti-mutation boundary. A future boundary must
justify the controlled source of the child token, expected restrictions/groups,
handle custody, and protection from hostile mutation before wiring can be
approved. An AccessCheck observation is not a substitute for those prerequisites.

## Helper contract

`verifyWindowsLPACSemantics` borrows a source token already opened with
`TOKEN_QUERY | TOKEN_DUPLICATE` by a future deliberate launcher boundary. It
never closes the source, opens/reopens a process or token, looks up a PID, or
widens rights after denial. The injected API has no open operation. Its complete
query/duplicate/close/buildSD/validSD/access bundle is checked before any token
operation; partial injection has no native fallback. The separate native
constructor resolves every required SystemDLL binding together.

The helper requires a Primary source, exact AppContainer=1/elevation=0, the
independently supplied exact profile, empty capabilities and exact Low integrity.
SID data is copied from bounded, aligned owned token-query buffers without native
interior-pointer reconstruction. The new parser accepts only the two documented
integrity-attribute forms used by the reviewed diagnostic. It does not alter the
old verifier's checks or errors and never reads selector46.

Only one distinct `TokenImpersonation` duplicate at `SecurityImpersonation`, with
`TOKEN_QUERY` requested, is owned. Source aliases (including low-bit handle-tag
aliases), pseudo/null outputs and failed partial outputs cannot be accepted.
Distinct real partial output is retired even on failure. The duplicate must pass
its own metadata, type/level and exact source-user/primary-group equality checks.
Its one retirement attempt is sticky: an uncertain close refuses success and is
never retried against a potentially recycled handle. The caller still owns and
must independently retire the borrowed source.

Three independent in-memory self-relative descriptors have exact owner=user,
group=primary group, no SACL, and only unflagged `ACCESS_ALLOWED_ACE` entries with
`FILE_READ_DATA` (1):

| Control | ACE identities | Required successful decision |
| --- | --- | --- |
| A | user only | DENY |
| B | user plus exact AAP `S-1-15-2-1` | DENY |
| C | user plus exact creation profile | ALLOW |

All descriptors are built before any native SD walker. Validation binds every
owner, group and ACE identity to the original inputs, exact count/mask/flags,
headers and extents; it rejects overlap, gaps, trailing bytes and shared SD
storage, while allowing native component reordering. Builder arguments are
independent copies so construction cannot rewrite the expected identities.
Native construction uses documented security-descriptor/ACL APIs; software
construction exists only in tests.

AccessCheck uses DWORD/BOOL4, GENERIC_MAPPING16, PRIVILEGE_SET20 and aligned
privilege storage. At most one insufficient-buffer retry is allowed, only for a
strictly larger size no greater than 4 KiB. Other failure outputs are ignored;
API failure is never DENY. Successful outputs require bounded privilege extent,
zero participating privileges, canonical status and exact granted read rights.
Opaque API/cleanup error text is not printed; numeric classification and
`errors.Is`/`errors.As` causes are retained. No token identities are logged.

## Tests and pending gates

Direct Windows fake tests use explicit adapters to the existing diagnostic
fixtures; fake source/duplicate operations never use real native token calls.
They cover all 63 incomplete API bundles with zero operations, borrowed-source
custody, paired ordinary-AC rejection, both tokens' metadata errors and bounded
SID layouts, duplicate identity/type/level, aliases/pseudo/partial outputs,
sticky close uncertainty, each control's API/output/retry failures, construction
errors and exact content binding. Every byte mutation and truncation of each
canonical SD is refused. A separate regression test proves successful semantic
checks cannot waive the old selector46 value or error87 gate.

Local validation uses **Go 1.26.10**:

- macOS process/supervisor/MCP normal tests, race tests and vet;
- Windows amd64 test compilation and vet for those packages;
- formatting and whitespace checks. No workflow change or workflow lint needed.

Compilation/vet do **not** execute the new Windows fake tests or native helper.
Native Windows execution, a push, and launcher wiring are intentionally pending
**parent plus independent review**. The next separately reviewed increment must
establish its deliberate borrowed-token boundary and preservation of all launch
stops, then obtain actual Windows normal/race/checkptr fake and native evidence
(including paired controls and independent cleanup). Selector46 remains mandatory
in this branch despite the historical diagnostic matrix. Filesystem,
network/IPC and broader confinement gates remain separate and unimplemented.

No real vault, AppSupport, provider, native application, foreign process or
reference checkout is used by this increment.
