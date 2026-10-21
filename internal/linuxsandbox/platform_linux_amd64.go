//go:build linux && amd64

package linuxsandbox

import (
	"bytes"
	"context"
	"debug/elf"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

const sealMask = unix.F_SEAL_SEAL | unix.F_SEAL_SHRINK | unix.F_SEAL_GROW | unix.F_SEAL_WRITE

var namespaceNames = []string{"user", "mnt", "pid", "ipc", "uts", "net"}

func fdIdentity(fd int) (identity, error) {
	var st unix.Stat_t
	err := unix.Fstat(fd, &st)
	return identity{uint64(st.Dev), st.Ino}, err
}
func pinned(p string, directory bool) (int, error) {
	flags := unix.O_PATH | unix.O_CLOEXEC
	if directory {
		flags |= unix.O_DIRECTORY
	}
	return unix.Openat2(unix.AT_FDCWD, p, &unix.OpenHow{Flags: uint64(flags), Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
}
func statFD(fd int) (unix.Stat_t, error) {
	var st unix.Stat_t
	err := unix.Fstat(fd, &st)
	return st, err
}

// Validate *every* ancestor, without symlink following. Sticky root-owned /tmp
// is the one writable ancestor exception, permitting exclusively temp fixtures.
// All directories from dataDir to either leaf must be owned by us and mode 0700.
func privateAncestry(p Policy) error {
	uid := uint32(os.Geteuid())
	seen := map[string]bool{}
	for _, leaf := range []string{p.Workspace, p.TempDir} {
		for dir := leaf; ; dir = path.Dir(dir) {
			if !seen[dir] {
				fd, err := pinned(dir, true)
				if err != nil {
					return fail("layout_unsupported", "missing, symlinked, or unsupported directory ancestry")
				}
				st, err := statFD(fd)
				unix.Close(fd)
				if err != nil {
					return err
				}
				if within(p.DataDir, dir) {
					if st.Uid != uid || st.Mode&0077 != 0 {
						return fail("layout_unsupported", "managed data ancestry must be private and owned by caller")
					}
				} else {
					stickyTmp := dir == "/tmp" && st.Uid == 0 && st.Mode&unix.S_ISVTX != 0
					if (st.Uid != 0 && st.Uid != uid) || (st.Mode&0022 != 0 && !stickyTmp) {
						return fail("layout_unsupported", "unsafe home ancestry")
					}
				}
				seen[dir] = true
			}
			if dir == "/" {
				break
			}
		}
	}
	// No cross-mount component between home and writable leaves, including bind
	// mounts with matching st_dev. RESOLVE_NO_XDEV is stronger than device checks.
	home, err := pinned(p.Home, true)
	if err != nil {
		return err
	}
	defer unix.Close(home)
	for _, leaf := range []string{p.Workspace, p.TempDir} {
		rel := strings.TrimPrefix(leaf, p.Home+"/")
		fd, err := unix.Openat2(home, rel, &unix.OpenHow{Flags: unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_XDEV | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
		if err != nil {
			return fail("layout_unsupported", "external or bind-mounted managed ancestry")
		}
		unix.Close(fd)
	}
	return nil
}

func managedFilesystem(fd int) error {
	var st unix.Statfs_t
	if err := unix.Fstatfs(fd, &st); err != nil {
		return err
	}
	if st.Type != unix.EXT4_SUPER_MAGIC && st.Type != unix.TMPFS_MAGIC {
		return fail("layout_unsupported", "managed grants require ext-family or tmpfs inode identity semantics")
	}
	return nil
}

// The final imported FD must itself be obtained through the constrained walk;
// an earlier path check followed by an unconstrained reopen would reintroduce a
// bind-mount/symlink swap window. Validate ownership on these exact descriptors.
func pinnedManaged(p Policy, leaf string) (int, error) {
	home, err := pinned(p.Home, true)
	if err != nil {
		return -1, err
	}
	defer unix.Close(home)
	st, err := statFD(home)
	if err != nil {
		return -1, err
	}
	if st.Uid != uint32(os.Geteuid()) || st.Mode&0022 != 0 {
		return -1, fail("layout_unsupported", "home must be owned by caller and not group/other writable")
	}
	rel := strings.TrimPrefix(leaf, p.Home+"/")
	parts := strings.Split(rel, "/")
	for i := range parts {
		prefix := strings.Join(parts[:i+1], "/")
		fd, err := unix.Openat2(home, prefix, &unix.OpenHow{Flags: unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_XDEV | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
		if err != nil {
			return -1, fail("layout_unsupported", "managed root changed or crossed a mount during pinning")
		}
		st, err := statFD(fd)
		if err != nil {
			unix.Close(fd)
			return -1, err
		}
		abs := p.Home + "/" + prefix
		private := within(p.DataDir, abs)
		if st.Uid != uint32(os.Geteuid()) || st.Mode&0022 != 0 || private && st.Mode&0077 != 0 {
			unix.Close(fd)
			return -1, fail("layout_unsupported", "pinned managed ancestry is not caller-private")
		}
		if i == len(parts)-1 {
			if err := managedFilesystem(fd); err != nil {
				unix.Close(fd)
				return -1, err
			}
			return fd, nil
		}
		unix.Close(fd)
	}
	return -1, fail("layout_unsupported", "empty managed root")
}

func checkProtectedAliases(p Policy, bindings []binding) error {
	home, err := pinned(p.Home, true)
	if err != nil {
		return err
	}
	defer unix.Close(home)
	for _, secret := range protectedRoots(p) {
		rel := strings.TrimPrefix(secret, p.Home+"/")
		fd, err := unix.Openat2(home, rel, &unix.OpenHow{Flags: unix.O_PATH | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_XDEV | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
		if err == unix.ENOENT {
			continue
		}
		if err != nil {
			return fail("layout_unsupported", "protected roots must not be symlinked or cross mounts")
		}
		id, err := fdIdentity(fd)
		unix.Close(fd)
		if err != nil {
			return err
		}
		for _, b := range bindings {
			if b.Writable && b.Identity == id {
				return fail("policy_invalid", "protected and writable roots alias the same inode")
			}
		}
	}
	return nil
}

func trustedRootPath(p string) error {
	for dir := p; ; dir = path.Dir(dir) {
		fd, err := pinned(dir, false)
		if err != nil {
			return fail("engine_unavailable", "required system path is missing or symlinked")
		}
		st, err := statFD(fd)
		unix.Close(fd)
		if err != nil {
			return err
		}
		if st.Uid != 0 || st.Mode&0022 != 0 || st.Mode&06000 != 0 {
			return fail("engine_unavailable", "system paths must be root-owned, non-setid, and not group/other writable")
		}
		if dir == "/" {
			break
		}
	}
	return nil
}

type boundedOutput struct{ bytes.Buffer }

func (b *boundedOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 64<<10 {
		return 0, errors.New("engine output too large")
	}
	return b.Buffer.Write(p)
}
func requireEngine() error {
	if err := trustedRootPath("/usr/bin/bwrap"); err != nil {
		return err
	}
	f, err := os.Open("/usr/bin/bwrap")
	if err != nil {
		return err
	}
	_, capErr := unix.Fgetxattr(int(f.Fd()), "security.capability", nil)
	f.Close()
	if capErr == nil || (capErr != unix.ENODATA && capErr != unix.ENOTSUP) {
		return fail("engine_unavailable", "file-capability bubblewrap is not supported")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/bwrap", "--help")
	cmd.Env = engineEnvironment()
	var output boundedOutput
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Run(); err != nil {
		return fail("engine_unavailable", "bubblewrap feature probe failed")
	}
	for _, feature := range []string{"--bind-fd ", "--ro-bind-fd ", "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--new-session", "--die-with-parent", "--cap-drop", "--clearenv", "--remount-ro"} {
		if !strings.Contains(output.String(), feature) {
			return fail("engine_unavailable", "bubblewrap is missing required FD/namespace features")
		}
	}
	return nil
}

func sealed(name string, raw []byte) (int, error) {
	fd, err := unix.MemfdCreate(name, unix.MFD_CLOEXEC|unix.MFD_ALLOW_SEALING)
	if err != nil {
		return -1, err
	}
	ok := false
	defer func() {
		if !ok {
			unix.Close(fd)
		}
	}()
	for off := 0; off < len(raw); {
		n, err := unix.Write(fd, raw[off:])
		if err != nil {
			return -1, err
		}
		if n == 0 {
			return -1, io.ErrShortWrite
		}
		off += n
	}
	if _, err := unix.FcntlInt(uintptr(fd), unix.F_ADD_SEALS, sealMask); err != nil {
		return -1, err
	}
	ok = true
	return fd, nil
}
func readSealed(fd, limit int) ([]byte, error) {
	seals, err := unix.FcntlInt(uintptr(fd), unix.F_GET_SEALS, 0)
	if err != nil || seals&sealMask != sealMask {
		return nil, fail("guard_failed", "handoff must have immutable seals")
	}
	st, err := statFD(fd)
	if err != nil {
		return nil, err
	}
	if st.Size < 1 || st.Size > int64(limit) || st.Mode&unix.S_IFMT != unix.S_IFREG {
		return nil, fail("guard_failed", "invalid handoff size or type")
	}
	raw := make([]byte, int(st.Size))
	n, err := unix.Pread(fd, raw, 0)
	if err != nil {
		return nil, err
	}
	if n != len(raw) {
		return nil, io.ErrUnexpectedEOF
	}
	return raw, nil
}
func namespaces() (map[string]identity, error) {
	out := map[string]identity{}
	for _, name := range namespaceNames {
		var st unix.Stat_t
		if err := unix.Stat("/proc/self/ns/"+name, &st); err != nil {
			return nil, err
		}
		out[name] = identity{uint64(st.Dev), st.Ino}
	}
	return out, nil
}
func mountsNow() ([]mount, error) {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return parseMounts(f)
}

func staticSelf(p Policy) (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	if !cleanAbsolute(self) {
		return "", fail("engine_unavailable", "helper must have a stable canonical installation path")
	}
	for _, root := range []string{p.Workspace, p.TempDir} {
		if within(root, self) {
			return "", fail("policy_invalid", "helper cannot be inside a writable grant")
		}
	}
	// /proc/self/exe is a trusted kernel magic link to the running executable,
	// unlike user-controlled path resolution. Its identity must match our pin.
	f, err := os.Open("/proc/self/exe")
	if err != nil {
		return "", err
	}
	defer f.Close()
	ef, err := elf.NewFile(f)
	if err != nil {
		return "", err
	}
	defer ef.Close()
	if ef.Machine != elf.EM_X86_64 || ef.Class != elf.ELFCLASS64 {
		return "", fail("engine_unavailable", "helper must be native amd64 ELF")
	}
	for _, prog := range ef.Progs {
		if prog.Type == elf.PT_INTERP || prog.Type == elf.PT_DYNAMIC {
			return "", fail("engine_unavailable", "helper must be statically linked (CGO_ENABLED=0)")
		}
	}
	fd, err := pinned(self, false)
	if err != nil {
		return "", err
	}
	defer unix.Close(fd)
	a, err := fdIdentity(fd)
	if err != nil {
		return "", err
	}
	b, err := fdIdentity(int(f.Fd()))
	if err != nil {
		return "", err
	}
	st, err := statFD(fd)
	if err != nil {
		return "", err
	}
	if st.Nlink != 1 || st.Mode&0022 != 0 {
		return "", fail("engine_unavailable", "helper must have one link and must not be group/other writable")
	}
	if a != b {
		return "", fail("engine_unavailable", "helper installation identity changed")
	}
	return self, nil
}

func standardDescriptors() error {
	for fd := 0; fd < 3; fd++ {
		st, err := statFD(fd)
		if err != nil {
			return fail("stdio_unsupported", "all three standard streams must be open")
		}
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFIFO:
		case unix.S_IFCHR:
			// Only null/zero/random/urandom or a terminal, not arbitrary privileged devices.
			maj, min := unix.Major(uint64(st.Rdev)), unix.Minor(uint64(st.Rdev))
			if !(maj == 1 && (min == 3 || min == 5 || min == 8 || min == 9)) && !(maj == 4 || maj == 136 || maj == 5 && min == 0) {
				return fail("stdio_unsupported", "unsupported standard device")
			}
		default:
			return fail("stdio_unsupported", "regular files, sockets, and non-stream standard handles are not allowed")
		}
	}
	return nil
}

// Production activation requires a separately reviewed source change, not an
// environment variable, CLI switch, or a successful feature probe. Only the
// test-built native fixture driver below this package's tests reaches candidates.
func launch(Policy, []string, []string) error { return reviewRequired() }
func guard([]string) error                    { return reviewRequired() }
func reviewRequired() error {
	return fail("engine_unavailable", "Linux helper is disabled pending independent security review and actual Ubuntu confinement evidence")
}

func launchCandidate(p Policy, argv, env []string) error {
	runtime.LockOSThread() // NNP and PDEATHSIG apply to the exec-ing OS thread.
	defer runtime.UnlockOSThread()
	parent := os.Getppid()
	if os.Getuid() != os.Geteuid() || os.Getgid() != os.Getegid() || os.Geteuid() == 0 {
		return fail("engine_unavailable", "only non-root, non-setid invocation is supported")
	}
	if parent <= 1 {
		return fail("engine_unavailable", "a live invoking parent is required")
	}
	if err := unix.Prctl(unix.PR_SET_PDEATHSIG, uintptr(unix.SIGKILL), 0, 0, 0); err != nil {
		return err
	}
	if os.Getppid() != parent {
		return fail("engine_unavailable", "invoking parent changed during setup")
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return err
	}
	if err := unix.Setrlimit(unix.RLIMIT_CORE, &unix.Rlimit{Cur: 0, Max: 0}); err != nil {
		return err
	}
	if err := standardDescriptors(); err != nil {
		return err
	}
	if err := privateAncestry(p); err != nil {
		return err
	}
	self, err := staticSelf(p)
	if err != nil {
		return err
	}
	running, err := os.Open("/proc/self/exe")
	if err != nil {
		return err
	}
	defer running.Close()
	approvedHelper, err := fdIdentity(int(running.Fd()))
	if err != nil {
		return err
	}
	if err := requireEngine(); err != nil {
		return err
	}
	for _, source := range []string{"/usr", "/etc/ld.so.cache"} {
		if err := trustedRootPath(source); err != nil {
			return err
		}
	}
	for _, alias := range [][2]string{{"/bin", "usr/bin"}, {"/sbin", "usr/sbin"}, {"/lib", "usr/lib"}, {"/lib64", "usr/lib64"}} {
		dest, err := os.Readlink(alias[0])
		if err != nil || dest != alias[1] {
			return fail("layout_unsupported", "only the exact merged-/usr alias layout is supported")
		}
	}
	ns, err := namespaces()
	if err != nil {
		return err
	}
	h := handoff{Version: Version, Policy: p, Argv: argv, Namespaces: ns}
	var keep []int
	defer func() {
		for _, fd := range keep {
			unix.Close(fd)
		}
	}()
	// Move inherited descriptors above runtime descriptors; never dup over Go's
	// epoll/eventfd handles. Bubblewrap consumes bind FDs; identity duplicates live
	// until guard verification. Neither kind is ever inherited by target code.
	promote := func(fd int) (int, error) {
		n, err := unix.FcntlInt(uintptr(fd), unix.F_DUPFD_CLOEXEC, 64)
		unix.Close(fd)
		if err == nil {
			keep = append(keep, n)
		}
		return n, err
	}
	for _, spec := range []binding{{Source: "/usr", Dest: "/usr", Directory: true}, {Source: "/etc/ld.so.cache", Dest: "/etc/ld.so.cache"}, {Source: self, Dest: helperPath}, {Source: p.Workspace, Dest: p.Workspace, Directory: true, Writable: true}, {Source: p.TempDir, Dest: p.TempDir, Directory: true, Writable: true}} {
		var fd int
		var err error
		if spec.Writable {
			fd, err = pinnedManaged(p, spec.Source)
		} else {
			fd, err = pinned(spec.Source, spec.Directory)
		}
		if err != nil {
			return err
		}
		fd, err = promote(fd)
		if err != nil {
			return err
		}
		id, err := fdIdentity(fd)
		if err != nil {
			return err
		}
		if spec.Dest == helperPath && id != approvedHelper {
			return fail("engine_unavailable", "helper changed between validation and pinning")
		}
		identFD, err := unix.FcntlInt(uintptr(fd), unix.F_DUPFD_CLOEXEC, 64)
		if err != nil {
			return err
		}
		keep = append(keep, identFD)
		spec.BindFD = fd
		spec.IdentityFD = identFD
		spec.Identity = id
		h.Bindings = append(h.Bindings, spec)
	}
	if err := checkProtectedAliases(p, h.Bindings); err != nil {
		return err
	}
	// Check current topology and inode aliases. Guard repeats both checks on the
	// resulting namespace; neither this scan nor a lexical path is authorization.
	mounts, err := mountsNow()
	if err != nil {
		return err
	}
	for i, b := range h.Bindings {
		if err := noDescendantMounts(mounts, b.Source); err != nil {
			return err
		}
		for j := 0; j < i; j++ {
			if h.Bindings[j].Identity == b.Identity {
				return fail("layout_unsupported", "aliased import roots")
			}
		}
	}
	raw, err := json.Marshal(h)
	if err != nil {
		return err
	}
	if len(raw) > MaxHandoff {
		return fail("policy_invalid", "encoded handoff exceeds bounds")
	}
	fd, err := sealed("pi-local-policy-v1", raw)
	if err != nil {
		return err
	}
	policyFD, err := promote(fd)
	if err != nil {
		return err
	}
	raw, err = json.Marshal(env)
	if err != nil {
		return err
	}
	if len(raw) > MaxEnvJSON {
		return fail("environment_invalid", "encoded environment exceeds bounds")
	}
	fd, err = sealed("pi-local-env-v1", raw)
	if err != nil {
		return err
	}
	envFD, err := promote(fd)
	if err != nil {
		return err
	}
	args, err := plan(h, policyFD, envFD)
	if err != nil {
		return err
	}
	// An exec, not a new process group: the PID the caller owns becomes bwrap's
	// supervisor. CLOEXEC closes arbitrary app/runtime/inherited descriptors.
	if err := unix.CloseRange(3, ^uint(0), unix.CLOSE_RANGE_CLOEXEC); err != nil {
		return err
	}
	for _, fd := range keep {
		if _, err := unix.FcntlInt(uintptr(fd), unix.F_SETFD, 0); err != nil {
			return err
		}
	}
	if os.Getppid() != parent {
		return fail("engine_unavailable", "invoking parent exited during setup")
	}
	if err := unix.Exec("/usr/bin/bwrap", append([]string{"/usr/bin/bwrap"}, args...), engineEnvironment()); err != nil {
		return fail("engine_unavailable", "bubblewrap exec failed")
	}
	return fail("setup_failed", "unreachable exec return")
}

func verifyIdentities(bindings []binding) error {
	return identityCheck(bindings, func(b binding) (identity, identity, error) {
		id, err := fdIdentity(b.IdentityFD)
		if err != nil {
			return id, identity{}, err
		}
		if b.Writable {
			if err := managedFilesystem(b.IdentityFD); err != nil {
				return id, identity{}, err
			}
		}
		fd, err := pinned(b.Dest, b.Directory)
		if err != nil {
			return id, identity{}, err
		}
		defer unix.Close(fd)
		mounted, err := fdIdentity(fd)
		return id, mounted, err
	})
}
func verifyNamespaces(original map[string]identity) error {
	current, err := namespaces()
	if err != nil {
		return err
	}
	if len(original) != len(namespaceNames) {
		return fail("guard_failed", "incomplete namespace handoff")
	}
	for _, name := range namespaceNames {
		old, ok := original[name]
		if !ok || old.Ino == 0 || old == current[name] {
			return fail("guard_failed", "required namespace was not replaced")
		}
	}
	if os.Getpid() <= 1 || os.Getppid() != 1 {
		return fail("guard_failed", "bubblewrap PID init is required")
	}
	session, err := unix.Getsid(0)
	if err != nil || session != 1 {
		return fail("guard_failed", "a new bubblewrap session is required")
	}
	return nil
}
func noCapabilities() error {
	var hdr unix.CapUserHeader
	hdr.Version = unix.LINUX_CAPABILITY_VERSION_3
	var data [2]unix.CapUserData
	if err := unix.Capget(&hdr, &data[0]); err != nil {
		return err
	}
	for _, d := range data {
		if d.Effective != 0 || d.Permitted != 0 || d.Inheritable != 0 {
			return fail("guard_failed", "guard still has capabilities")
		}
	}
	knownLimit := false
	for i := 0; i < 64; i++ {
		v, err := unix.PrctlRetInt(unix.PR_CAPBSET_READ, uintptr(i), 0, 0, 0)
		if err == unix.EINVAL {
			knownLimit = true
			break
		}
		if err != nil {
			return err
		}
		if v != 0 {
			return fail("guard_failed", "bounding capabilities remain")
		}
	}
	if !knownLimit {
		return fail("guard_failed", "unknown capability ABI exceeds the reviewed bounds")
	}
	return nil
}
func applyFilter() error {
	ins := Filter()
	native := make([]unix.SockFilter, len(ins))
	for i, v := range ins {
		native[i] = unix.SockFilter{Code: v.Code, Jt: v.JT, Jf: v.JF, K: v.K}
	}
	prog := unix.SockFprog{Len: uint16(len(native)), Filter: &native[0]}
	result, _, errno := unix.RawSyscall(unix.SYS_SECCOMP, unix.SECCOMP_SET_MODE_FILTER, unix.SECCOMP_FILTER_FLAG_TSYNC, uintptr(unsafe.Pointer(&prog)))
	runtime.KeepAlive(native)
	// TSYNC can return an offending TID as a positive result, without errno.
	if errno != 0 || result != 0 {
		return fail("guard_failed", "seccomp TSYNC could not confine all Go threads")
	}
	return nil
}

func guardCandidate(args []string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if len(args) != 2 {
		return fail("guard_failed", "guard requires sealed handoff descriptors")
	}
	pfd, err := strconv.Atoi(args[0])
	if err != nil {
		return fail("guard_failed", "invalid guard descriptor")
	}
	efd, err := strconv.Atoi(args[1])
	if err != nil || pfd < 3 || efd < 3 || pfd == efd || pfd > 65535 || efd > 65535 {
		return fail("guard_failed", "invalid guard descriptors")
	}
	raw, err := readSealed(pfd, MaxHandoff)
	if err != nil {
		return err
	}
	var h handoff
	if err := strictJSON(raw, MaxHandoff, &h); err != nil {
		return err
	}
	if h.Version != Version {
		return fail("guard_failed", "unknown handoff version")
	}
	if _, err := plan(h, pfd, efd); err != nil {
		return err
	}
	if err := verifyNamespaces(h.Namespaces); err != nil {
		return err
	}
	if err := noCapabilities(); err != nil {
		return err
	}
	if err := standardDescriptors(); err != nil {
		return err
	}
	if err := verifyIdentities(h.Bindings); err != nil {
		return err
	}
	mounts, err := mountsNow()
	if err != nil {
		return err
	}
	if err := verifyMounts(mounts, h.Bindings); err != nil {
		return err
	}
	if err := verifyScaffold(h.Bindings, func(p string) ([]string, error) {
		fd, err := unix.Openat2(unix.AT_FDCWD, p, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
		if err != nil {
			return nil, err
		}
		f := os.NewFile(uintptr(fd), p)
		defer f.Close()
		entries, err := f.ReadDir(512)
		if err != nil && err != io.EOF {
			return nil, err
		}
		if len(entries) >= 512 {
			return nil, errors.New("scaffold too large")
		}
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		return names, nil
	}); err != nil {
		return err
	}
	if _, err := os.Lstat("/sys"); !os.IsNotExist(err) {
		return fail("guard_failed", "host sysfs path must not exist")
	}
	raw, err = readSealed(efd, MaxEnvJSON)
	if err != nil {
		return err
	}
	var env []string
	if err := strictJSON(raw, MaxEnvJSON, &env); err != nil {
		return err
	}
	normalized, err := targetEnvironment(env, h.Policy)
	if err != nil {
		return err
	}
	if err := unix.Chdir(h.Policy.Workspace); err != nil {
		return fail("guard_failed", "workspace chdir failed")
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return err
	}
	if err := unix.CloseRange(3, ^uint(0), unix.CLOSE_RANGE_CLOEXEC); err != nil {
		return err
	}
	// No target-supplied environment is ever installed in this Go process. execve
	// receives it only after all checks and a process-wide filter are in force.
	if err := applyFilter(); err != nil {
		return err
	}
	if err := unix.Exec(h.Argv[0], h.Argv, normalized); err != nil {
		return fail("target_exec_failed", "target exec failed inside the offline sandbox")
	}
	return fail("guard_failed", "unreachable exec return")
}
