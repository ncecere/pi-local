# Windows loopback inventory: API evidence and unresolved bounds

Status: research only. No native binding, query, configuration mutation, process
experiment or activation is implemented or approved here. Both execution-disabled
stops and the unavailable Win32 runtime remain unchanged. The separately prepared
token-shape observation increment does not call this API.

## Verified sources

Fresh source research used these official repositories, without executing them:

- MicrosoftDocs/sdk-api, `docs`, commit
  `656e9656bfaef34dd29cd7ee9e1146aec17e924c`.
- microsoft/win32metadata, `main`, commit
  `2f767671802301cf043c717d66bf004ed7863487`.

Parent read the GetConfig documentation/example and SDK declaration. Relevant
pinned files:

- [GetConfig documentation, including cleanup example](https://github.com/MicrosoftDocs/sdk-api/blob/656e9656bfaef34dd29cd7ee9e1146aec17e924c/sdk-api-src/content/networkisolation/nf-networkisolation-networkisolationgetappcontainerconfig.md#L58-L151).
- [SDK declaration](https://github.com/microsoft/win32metadata/blob/2f767671802301cf043c717d66bf004ed7863487/generation/WinSDK/RecompiledIdlHeaders/um/networkisolation.h#L149-L154).
- [SID_AND_ATTRIBUTES layout](https://github.com/microsoft/win32metadata/blob/2f767671802301cf043c717d66bf004ed7863487/generation/WinSDK/RecompiledIdlHeaders/um/winnt.h#L10753-L10760).
- [HeapSize limits and wrong-heap caveat](https://github.com/MicrosoftDocs/sdk-api/blob/656e9656bfaef34dd29cd7ee9e1146aec17e924c/sdk-api-src/content/heapapi/nf-heapapi-heapsize.md#L92-L102).

## Exact API and successful-result ownership

`NetworkIsolationGetAppContainerConfig` takes **two output pointers**, not flags:

```c
DWORD WINAPI NetworkIsolationGetAppContainerConfig(
    DWORD *count, PSID_AND_ATTRIBUTES *entries);
```

The DWORD return is `ERROR_SUCCESS` (zero) or an error value. It is not BOOL,
HRESULT or an instruction to read GetLastError. The API is exported by
FirewallAPI.dll; any future binding must use the trusted SystemDLL path.
`NETISO_FLAG_FORCE_COMPUTE_BINARIES` belongs to a different enumeration API.

Entries identify containers allowed to send loopback traffic, not merely API
capability. Each record has a SID pointer followed by DWORD attributes, with
native alignment: 16-byte records on x64/ARM64, 8 bytes on x86. SID bytes are
not inline in the entry array.

Microsoft's example explicitly calls `HeapFree(GetProcessHeap(), 0, entry.Sid)`
for **each** entry, then the same operation on the array. Do not substitute
LocalFree, FreeSid, or NetworkIsolationFreeAppContainers: the last frees the
different enumeration result.

The example initializes outputs to zero/null and invokes cleanup even after a
query error. This is official partial-output cleanup precedent, **not** a stated
invariant covering every inconsistent error count/pointer/ownership combination.
A future implementation must not blindly traverse arbitrary partial outputs or
claim that the example proves safe bounds for malformed responses.

## What remains blocked

There is no caller capacity, allocation byte length, exact-SID filter, pagination
or documented maximum in this API. Native allocation precedes caller inspection.
A subsequent count/2MiB traversal limit cannot impose a global allocation bound.
No bounded equivalent was established by this research.

Success annotations support trusting Windows to return readable indicated entries
and SID objects. They do not independently establish native allocation extents.
IsValidSid/GetLengthSid are not extent checks. HeapSize can give per-block sizes
only under a valid process-heap-pointer assumption; wrong-heap input is undefined.
It does not remove the initial allocation gap or establish partial-error ownership.

Therefore a strictly bounded, unqualified in-process implementation is **not
approved**. Do not add a guessed deallocator, silently accept partial output,
truncate traversal then report absence, or convert any failure into NoExemption.

## Candidate decisions for separate review—not implementation instructions

1. Retain a fake-only membership seam while the native contract is unresolved.
2. Explicitly review trusted-native success/error assumptions and caller-side
   processing limits, without falsely describing them as an OS allocation cap.
3. Consider a separate trusted, read-only observer process with a reviewed
   pre-resume resource envelope, deadline, bounded output and retained-handle
   cleanup. Process retirement could contain hanging calls and let the OS retire
   uncertain heap state; it is not a global service/kernel allocation bound, nor
   permission to bypass the restricted launcher's OFF stops. Its launcher,
   identity, memory accounting, error privacy and cleanup need separate review.

No option is selected. The observer would not be an unsandboxed retry of an
untrusted agent or a way to run a restricted probe through beforeResume. No
native call, new launcher, Job limit, ACL or exemption change is authorized by
this note.

## Required membership and evidence contract

A future injectable read-only result should distinguish **Exempt / NoExemption /
Unknown**. Compare only the exact canonical SID of the newly S_OK-owned profile;
keep unrelated global entries private and discard them after inspection. Log no
SIDs, names, pointers, addresses or backend text. A matching exemption blocks
progress. Query/extent/cleanup/timeout uncertainty stays Unknown and also blocks
progress; absence requires a complete successful inspected snapshot.

Tests must cover exact/nonmatching membership, empty success, DWORD errors,
inconsistent outputs, count arithmetic, native extents, duplicate/aliased heap
ownership, cleanup and late uncertainty. Fakes must never invoke native methods
on fabricated pointers. Resource and cancellation assertions must state which
process/allocation they actually bound.

Even a valid NoExemption is configuration evidence at one instant. It neither
proves IPv4/IPv6 enforcement nor excludes concurrent configuration changes,
broker access or other IPC. Future actual network/pipe denial probes need their
own reviewed synthetic endpoints and positive controls; timeouts, missing endpoints
and generic failures are not authorization denials. Never call SetAppContainerConfig,
add exemptions, invoke CheckNetIsolation.exe or query live application endpoints
as a shortcut. Runtime and supported-OS acceptance remain unapproved.

Independent security review `b107e599` checked the cited SDK/docs, ownership,
partial-output qualifications, privacy and resource claims and approved this as
research-only documentation with no actionable findings. It did not approve a
native binding, observer launcher, execution experiment or activation.
