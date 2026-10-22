# LPAC AccessCheck diagnostic: no replacement authority

Isolated branch `v05/lpac-accesscheck-diagnostic`, base `ea1b963`. Production
process/token code is unchanged. The original four-byte selector-46 gate remains
mandatory and continues to fail if the public API returns 87. No process resumes
are permitted, and no semantic observation enables the runtime sandbox.

Prior native run 39718662135 passed Windows environment-path and query-wrapper
fakes in normal/race builds. Real suspended children reached AppContainer,
elevation=0, exact profile, zero capabilities and Low IL before selector 46.
All diagnostic requests of 1/4/8 bytes returned error 87; normal=1/race=1/vet=0.
This does not justify changing to BOOLEAN or accepting unsupported queries.

## Supported semantic API experiment

Microsoft's AppContainer documentation describes user/package permission
intersection and LPAC opting out of All Application Packages. Chromium commit
`20f043d5ef7456dc6ef4a0652519b171f225f8d2`,
`sandbox/win/src/app_container_test.cc:CheckLpacToken`, provides implementation
precedent for SecurityImpersonation duplication and in-memory AccessCheck LPAC
controls. It does not prove this fixture or replace native acceptance.

The diagnostic wraps real exact-Job verification and preserves its exact returned
(member,error) pair. After successful membership, it acquires the existing
SYNCHRONIZE cleanup witness earlier, before token validation can fail. The previous
beforeResume duplication is removed; signaled/closed/no-sticky-error profile
cleanup predicates are unchanged. Missing or uncertain witnesses never authorize
profile deletion.

Through the retained child process handle, one OpenProcessToken requests
QUERY|DUPLICATE. A distinct non-inheritable SecurityImpersonation duplicate requests
QUERY only. Source/duplicate non-46 metadata, type/level and identities are checked.
Both owned token handles receive one retirement attempt; errors remain sticky.
No caller/thread impersonation or rights-widening retry occurs.

Native public APIs construct independent in-memory descriptors with user owner,
primary group, no SACL, and concrete FILE_READ_DATA grants. Three controls are
required: user-only DENY; user+All Application Packages DENY for LPAC/ALLOW for
ordinary AC; user+exact profile ALLOW for both. API failure is not DENY. Mapping,
SID/descriptor extents, privilege buffers/counts, returned rights/status and a
single bounded insufficient-buffer retry are validated. Software descriptor
construction is used only by injected tests, not the native path.

The separately selected paired-control test creates fresh S_OK-owned LPAC and
ordinary-AC references. Ordinary mode is only a disposable suspended comparator,
never a candidate fallback. Both require independent signaled/closed cleanup and
zero resumes. The LPAC reference explicitly recognizes only the observed original
selector-46/87 refusal after successful semantic observations; this is a diagnostic
result, not acceptance of the separate mandatory candidate gate. Unexpected
creation, metadata, access or cleanup errors fail the control. The original 3x3
candidate fixture still expects its exact completed gate and therefore stays red
on 87. Its selected four attributes, query wrapper and unconditional stops remain.

Reports contain booleans/numeric outcomes only, not SID, user, token, handle, path
or backend error text. No file ACL, Low label, network, IPC, profile repair/load,
account or global policy is modified. These are in-memory permission observations,
not filesystem/network/IPC confinement or physical Windows 11 desktop proof.

## Validation boundary

The initial author ran macOS process/supervisor/MCP normal/race/vet successfully.
Initial Windows compilation found two errors; those were corrected. Parent
Windows amd64 process/supervisor/MCP compilation and vet then passed
(`v05-lpac-accesscheck-crosscompile-recovery`, exit 0). Workflow lint passed during
authorship. Parent full-source review and independent security review approved
this diagnostic only, with no findings. Final parent macOS process/supervisor/MCP
normal/race/vet, Windows amd64 compilation/vet and workflow YAML/actionlint passed
(`v05-lpac-accesscheck-final-parent-gate`, exit 0). No Windows fake or native
diagnostic has executed at this stage. Native normal/race/vet remains mandatory
before interpretation or integration; the original candidate failure is not waived.
No native acceptance is claimed; this isolated branch is not merged into v0.5.
