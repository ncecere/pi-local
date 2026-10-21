# Offline Linux helper: version 1 contract

## Status and boundary

This is an **unwired, review-stage helper**, not a claim that Linux shell
sandboxing is supported. `runtime/src/lib/sandbox/linux.ts` remains unavailable;
no application capability flag, UI, packaging, provider, or transport changes are
part of this layer. **Production Linux `run` and `guard` always refuse with
`engine_unavailable`**, even if bwrap is installed. There is no production
activation flag or environment override. Candidate launcher/guard functions are
reachable only from a test-built fixture driver, not the shipped command.
Native Linux confinement has **not been exercised on the implementation host
(macOS)**. Independent security review and actual Ubuntu confinement evidence
are prerequisites to a separate activation change, not promised future results.

The initial platform is non-root Linux amd64, targeting Ubuntu 24.04 x64 with an
administrator-installed `/usr/bin/bwrap`. Other OS/architecture builds return
`platform_unsupported`, without executing the target. There is no network-enabled
mode, unsandboxed fallback, shell-string API, or configurable engine executable.
A failure to establish an invariant is a refusal, not degraded confinement.

Trust: the invoking application supplies policy and intended target environment;
the static helper, its installation ancestry, root-managed `/usr`, the loader
cache, kernel, and bubblewrap installation are trusted. An unsandboxed same-UID
adversary able to replace the helper or ptrace its launcher is not isolated by
this mechanism. Mutable grants and their entries are untrusted. Grant authority
is the constrained, preopened directory inode, not its subsequently mutable
host pathname. Preexisting hardlinks/content in an intentionally granted tree
are granted content: this is not a content/provenance or secret-scanning system.

## Reserved public invocation (currently disabled)

Build only this command, with `CGO_ENABLED=0`:

```
go build -o <trusted-installation>/pi-local-sandbox ./cmd/pi-local-sandbox
```

The reserved caller contract uses an argv array, not concatenated shell text.
Today a valid offline invocation still refuses at the production review gate:

```
["<helper>", "run", "--policy", "<JSON>", "--", "/bin/sh", "-c", "<target script>"]
```

The helper never interprets the target script. `/bin/sh -c` here is an explicit
choice of target, not helper-generated composition. A direct absolute program
with individual arguments is also supported. No policy/environment files are
written to disk. Policy paths are non-secret and visible in launcher arguments;
**target environment values must never be serialized into argv**. The helper
captures them from its own environment into a separate sealed memfd. A later
SandboxPlatform adapter must preserve these distinctions.

Example policy for an entirely disposable fixture:

```json
{
  "version": 1,
  "workspace": "/tmp/pi-fixture/home/data/agents/one/workspace",
  "tempDir": "/tmp/pi-fixture/home/data/agents/one/temp",
  "home": "/tmp/pi-fixture/home",
  "dataDir": "/tmp/pi-fixture/home/data",
  "agentDir": "/tmp/pi-fixture/home/data/agents/one",
  "protectedDirs": ["/tmp/pi-fixture/home/data/agents/two"],
  "network": false
}
```

Only `protectedDirs` is optional. Missing scalar paths fail validation; omitted
`network` means false. Unknown, case-variant, duplicate, null, trailing, invalid
UTF-8, or excessively nested JSON is refused. Policy: at most 16 KiB, depth 8,
32 supplemental protected roots; paths at most 4096 bytes. Paths must be clean,
absolute Linux paths without NUL, CR, LF, or backslash. Executable must be
absolute; at most 256 argv entries, 16 KiB per entry, 64 KiB total including
terminators. Target environment: at most 512 unique entries and 128 KiB including
terminators, valid UTF-8, no NUL. JSON-escaped handoffs are separately bounded
(512 KiB policy/argv metadata; 788480 bytes environment).

`network:true` or unknown version returns `policy_unsupported` before engine
startup or target execution. Go-side errors are one JSON object on stderr and
exit 125 (`usage`, `policy_invalid`, `policy_unsupported`, `argv_invalid`,
`environment_invalid`, `platform_unsupported`, `engine_unavailable`,
`layout_unsupported`, `stdio_unsupported`, `guard_failed`, `target_exec_failed`,
or generic `setup_failed`). Messages do not echo environment/argv. Once exec
has transferred control to bubblewrap, its setup failures retain its own
nonzero exit and stderr; they are not necessarily JSON or exit 125. A confined
target's ordinary exit status is bubblewrap's responsibility. None is retried.

## Accepted host layout

All imported paths must exist, with no symlink or magic-link components. Version
1 only accepts strict `home / dataDir / agentDir / {workspace,tempDir}` ancestry.
The two writable leaves are disjoint, never ancestors of each other, and cannot
contain the helper or protected roots. Neither dataDir nor agentDir is imported
wholesale. Supplemental protected roots must be under home. Reserved runtime
paths cannot be grant/home ancestors or descendants; fixture homes strictly
below `/tmp` are permitted.

Home must be caller-owned and not group/other writable. Components below home
must be caller-owned and not group/other writable; dataDir and every component
below it must additionally exclude all group/other permissions. Outer ancestors
must be root/caller-owned and not group/other writable, except root-owned sticky
`/tmp`. The final leaf FDs are opened with `openat2(RESOLVE_BENEATH |
RESOLVE_NO_XDEV | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)` from a pinned home;
ownership is checked on those descriptors, not just on an earlier path lookup.
Managed grants require ext-family (`EXT4_SUPER_MAGIC`) or tmpfs inode semantics.
External grants, crossings below home (including same-device bind mounts), and
bind descendants in imports are refused. Network/FUSE/overlay managed grants
are not supported. This narrow layout deliberately excludes many real projects.

Protected defaults are home-relative `.ssh`, `.aws`, `.gnupg`, `.config`,
`.local/share/keyrings`, and `Library/Keychains`. Existing defaults/supplemental
protected roots cannot be symlinked or cross mounts below home. Missing ones are
allowed. Literal overlap and equal-inode aliases to writable roots are refused.
Other host home/data files are absent too, not merely these named credentials.
Callers must select the correct agent and exclusively provision its managed
leaves; the helper does not authenticate an agent identity or discover app data.

The helper must have one link, no group/other write permission, no PT_INTERP or
PT_DYNAMIC ELF segment, and be native ELF64 x86-64. Its final pinned identity
must match `/proc/self/exe`. It must live outside every writable grant. Runtime
static checks do not make launching an incorrectly packaged dynamic helper
under poisoned loader variables safe: **the outer binary must already be a
trusted static build**. Bubblewrap and system-source ancestry must be root-owned,
non-setid, and not group/other writable; file-capability bwrap is refused.

Stdio must be open pipes/FIFOs or the narrowly recognized harmless device/TTY
classes in `standardDescriptors`. Regular files, sockets, directories, and
other device handles are refused. This prevents reopening application log files
or using an inherited host service socket. Caller-supplied stream contents are
intentional I/O. A later Node adapter must not assume libuv “pipes” are real
FIFOs; socket-backed stdio is currently unsupported.

## Candidate execution and descriptor protocol (test driver only)

1. **Static outer Go launcher.** Validate, pin roots, retain separate O_PATH
   identity descriptors, and capture original user/mount/PID/IPC/UTS/network
   namespace identities. Apply no-new-privileges, zero core limit, and parent
   death SIGKILL on the exec-ing locked OS thread. Feature-probe the fixed
   engine using only the fixed engine environment. Bound probe output/time.
2. **Immutable handoff.** Policy/argv/bind identities and target environment are
   separate memfds with WRITE/GROW/SHRINK/SEAL seals. FD numbers, not environment
   values, reach bwrap/guard argv. Bind FDs and retained identity duplicates are
   distinct: bwrap consumes setup FDs. `close_range(CLOEXEC)` plus a narrow
   explicit keep set excludes unrelated Go/application handles from bwrap.
3. **Exec `/usr/bin/bwrap`.** This replaces the caller-owned PID, not a supervisor
   spawned by this package. Require `--bind-fd` and `--ro-bind-fd` from the real
   `--help`; no version guess, ordinary-bind, or `/proc/self/fd` CLI-bind fallback.
   Every import uses the FD interface. Request user/mount/PID/IPC/UTS/network
   isolation, new session, die-with-parent, all caps dropped, and the normal
   bwrap PID-1 init/reaper (never `--as-pid-1`). No `--disable-userns` or sysctl
   modification is used. The syscall filter denies subsequent namespace calls.
4. **Static confined guard, same binary.** `guard <policy-fd> <env-fd>` is private
   handoff syntax, not a supported standalone execution API. Require immutable
   seals, strict bounds, all six changed namespace identities, parent PID 1,
   session ID 1, no effective/permitted/inheritable/bounding capabilities, and
   safe stdio. Compare each mounted root's device/inode with BOTH the sealed
   recorded identity and its still-open preopened O_PATH descriptor. Reopen
   destinations without symlinks. Validate mount flags, mount table, filesystem
   types, and every namespace-local scaffold directory before user code.
5. **Target.** Chdir to the verified workspace, mark every FD above 2 CLOEXEC,
   and install the native cBPF filter with `SECCOMP_FILTER_FLAG_TSYNC`. A positive
   failed-thread ID is failure, even with errno zero. Only then exec the target
   with its normalized target environment. The Go guard never installs target
   loader variables in its own environment. All identity/policy/env/runtime FDs
   close on successful exec. No user code runs on a rejected guard path.

Cleanup relies on the actual PID namespace init's death and bubblewrap's parent
chain, not a process-group kill. Children may fork/double-fork or setsid; they
remain in that namespace. Native tests track fixture descendants using pidfds
and test killing both the outer bwrap PID and its invoking fixture parent.

## Root filesystem and setup ordering

There is **no host-root bind**. The new root is tmpfs, remounted read-only after
scaffolding and read-only imports, before the writable imports:

| Path | Contents / access |
| --- | --- |
| `/usr` | Complete trusted host `/usr`, FD-bound read-only, nodev, nosuid; no descendant mounts |
| `/bin`, `/sbin`, `/lib`, `/lib64` | Exactly `usr/bin`, `usr/sbin`, `usr/lib`, `usr/lib64` symlinks; host must have this merged-usr layout |
| `/etc` | Only root-managed `/etc/ld.so.cache`, read-only; no passwd/group, nsswitch, hosts, resolv.conf, shadow, or other host config |
| `/.pi-local/helper` | Pinned static helper, read-only |
| `/proc` | New PID namespace proc, remounted ro/nodev/nosuid/noexec; bwrap may cover sys/irq/bus/sysrq-trigger read-only |
| `/dev` | bwrap minimal private tmpfs: null/zero/full/random/urandom/tty bind devices, private devpts/ptmx, empty shm, fd/stdio aliases, legacy core symlink; optional console only with TTY stdio |
| `/home/sandbox` | Empty synthetic home on read-only root |
| `/tmp`, `/run` | Private ephemeral tmpfs, not host mounts |
| workspace, tempDir | The only writable **host** bind leaves, rw/nodev/nosuid |
| home/data/agent ancestors | Empty synthetic scaffolding leading to the two leaves, not host directory listings |
| `/sys`, other host trees | Absent |

Scaffolding, symlinks, pseudo-filesystems, and read-only imports come first.
Writable leaves are imported last, with no later setup operation traversing a
writable tree. Disjoint destinations cannot be replaced via the first imported
leaf. The guard's exact scaffold listing rejects accidentally visible app files,
other agents, or credential entries. Read-only proc also blocks `/proc/1/mem`
writes into the otherwise unfiltered bwrap init; denying only ptrace syscalls
would not be enough.

Imports with propagation tags (including slave `master:` tags) are **refused**:
a one-time descendant scan cannot rule out future incoming host submounts.
Consequently some otherwise ordinary Ubuntu/shared-root layouts may fail the
gate. This implementation does not change host propagation, mount policies,
AppArmor, sysctls, or user namespace settings to make itself work. An unavailable
engine/topology is explicitly not a successful confinement test.

## Environments and syscall boundary

The *entire* environment of dynamic bwrap, its feature probe, and the static
guard is exactly:

```
PATH=/usr/bin:/bin
LANG=C
LC_ALL=C
HOME=/home/sandbox
TMPDIR=/tmp
```

It contains no inherited `LD_*`, `GLIBC_TUNABLES`, `NODE_OPTIONS`, `PYTHON*`,
`RUBY*`, `GODEBUG`, `DYLD_*`, or arbitrary caller values. Absence follows from a
fixed allowlist, not an incomplete list of known loader variable names.

Target env preserves caller entries only in the sealed handoff, including
loader/tool variables and intended secrets. It removes `SSH_AUTH_SOCK`,
`SSH_AGENT_PID`, `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `WAYLAND_DISPLAY`, and
`XDG_RUNTIME_DIR`; forces HOME `/home/sandbox`, USER/LOGNAME `sandbox`, PATH
`/usr/bin:/bin`, PWD workspace, and TMPDIR/TMP/TEMP tempDir. No host service
credentials are fetched. The target can of course read secrets intentionally
provided to it. Loader variables are safe only *after* filesystem, namespace,
FD, and seccomp checks, not before bwrap startup.

`internal/linuxsandbox/filter.go` is the complete fixed, reviewable native
x86-64 syscall allowlist. Numeric syscall IDs correspond to
`golang.org/x/sys v0.49.0/unix/zsysnum_linux_amd64.go` (already in this module).
Every unlisted call returns EPERM. Other audit architectures, i386, and x32 are
killed. There is no libseccomp or CGO dependency. Ordinary local file/memory,
signal, timing, process/thread, and event-loop operations are enumerated.

Mount/chroot/namespace, ptrace/process_vm, io_uring, keyring, kernel/System-V
IPC, and all `socket()` creation are denied, including AF_UNIX abstract sockets.
Only AF_UNIX/SOCK_STREAM/protocol-0 `socketpair` with optional NONBLOCK/CLOEXEC
is allowed. clone masks exclude all namespace, tracing, and high flags. ioctl
permits only TCGETS, TIOCGWINSZ, FIONREAD, with no high request bits; TIOCSTI and
TIOCLINUX are denied. arch_prctl permits native FS TLS setup/query; prctl permits
thread-name operations and read-only seccomp/NNP queries.

clone3 returns **EPERM, not ENOSYS**: no native glibc fallback has been certified.
This can prevent Node/pthread workloads from starting on modern glibc. There is
no claim of all-tools support, Node certification, resource/DoS isolation,
network-on behavior, or arbitrary external workspace support. Even benign
`/bin/sh` requires the native gate to pass. Unsupported syscalls fail visibly;
they do not trigger an unsandboxed retry or automatic allowlist expansion.

## Evidence and test commands

Sources inspected:

- Ubuntu Noble source commit
  [`e95a0205d97a5bf147053bc88f790cadb7ae8d65`](https://git.launchpad.net/ubuntu/+source/bubblewrap/commit/?id=e95a0205d97a5bf147053bc88f790cadb7ae8d65):
  `bubblewrap.c:setup_newroot` resolves ordinary sources via oldroot; the
  `debian/patches/Add-bind-fd-and-ro-bind-fd-to-let-you-bind-a-O_PATH-fd.patch`
  adds FD arguments but contains no post-mount identity comparison. Its prose
  is not a substitute for the implemented check.
- Upstream v0.10.0 commit
  [`dc63ec667e6546f34e0b6c088cdf8ae7c7dea0f3`](https://github.com/containers/bubblewrap/blob/dc63ec667e6546f34e0b6c088cdf8ae7c7dea0f3/bubblewrap.c):
  `setup_newroot` explicitly compares fstat(fd) with lstat(destination), explaining
  the cross-user-namespace fd-resolution race. Its setup/init/exec paths show
  separate setup-FD consumption and PID-1 inherited-FD cleanup.
- Noble `debian/changelog` at the same Ubuntu commit records
  `0.9.0-1ubuntu0.2`'s destination-symlink change and `0.9.0-1ubuntu0.3` dropping
  CVE-2026-87766 for a Flatpak regression. This helper therefore does not rely
  on that rolled-back destination protection. See also
  [the published package changelog](https://www.ubuntuupdates.org/package/core/noble/main/security/bubblewrap).

Portable tests inject identity swaps, closed descriptors, malicious mount
records, unexpected scaffold entries, bind-map failures, poisoned environments,
JSON/argv bounds, and interpreted BPF decisions. Linux-only safe fixture unit
tests cover sealed memfds and openat2 symlink rejection. None use real user data.

```
go test -race ./internal/linuxsandbox ./cmd/pi-local-sandbox
go vet ./internal/linuxsandbox ./cmd/pi-local-sandbox
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./cmd/pi-local-sandbox
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go test -c ./internal/linuxsandbox
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go vet ./internal/linuxsandbox ./cmd/pi-local-sandbox
```

Cross-building is not native execution. On a non-root Linux amd64 worker, the
explicit, temp-only native gate is:

```
PI_LOCAL_SANDBOX_NATIVE_TESTS=1 CGO_ENABLED=0 go test -count=1 -timeout=5m ./internal/linuxsandbox
```

It builds a static Go test driver into a fresh temporary fixture. Test-only
`TestMain` dispatch reaches `launchCandidate` / `guardCandidate`; the production
command remains disabled and has no equivalent bypass. The gate requires real
bwrap FD features, successful guard checks, filesystem/env isolation, concurrent
source replacements at both import destinations, native seccomp/ABI behavior,
and actual PID-namespace cleanup of orphaned setsid descendants. Unsafe nested
destination layouts are rejected by portable policy/plan tests rather than
mounted. Node is tested only if installed; absence explicitly skips that subtest
and certifies nothing about Node. An unavailable engine or failed guard is a
**fatal native gate failure**, not a skip or a green confinement claim. The
opt-in flag is only read by tests, never by the production helper.

No workflow, binary distribution, license/notices aggregation, native app,
Keychain, AppSupport directory, OS security policy, or persistent host data is
changed by these tests. All driver/workspace/credential/supervisor fixtures are temporary. Native tests have not been run from macOS and must not be
reported as passing merely because their test binary cross-compiles.
