package linuxsandbox

import (
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
)

const helperPath = "/.pi-local/helper"

type identity struct {
	Dev uint64 `json:"dev"`
	Ino uint64 `json:"ino"`
}
type binding struct {
	Source     string   `json:"source"`
	Dest       string   `json:"dest"`
	BindFD     int      `json:"bindFD"`
	IdentityFD int      `json:"identityFD"`
	Identity   identity `json:"identity"`
	Directory  bool     `json:"directory"`
	Writable   bool     `json:"writable"`
}
type handoff struct {
	Version    int                 `json:"version"`
	Policy     Policy              `json:"policy"`
	Argv       []string            `json:"argv"`
	Bindings   []binding           `json:"bindings"`
	Namespaces map[string]identity `json:"namespaces"`
}

// plan is pure: all paths and descriptors have already been pinned/validated.
// Scaffold *everything* before importing writable trees. There must be no
// post-import setup operation traversing a user-writable tree, even implicitly.
func plan(h handoff, policyFD, envFD int) ([]string, error) {
	if err := h.Policy.Validate(); err != nil {
		return nil, err
	}
	if err := validateArgv(h.Argv); err != nil {
		return nil, err
	}
	if len(h.Bindings) != 5 {
		return nil, fail("setup_failed", "unexpected bind map")
	}
	expected := map[string]bool{"/usr": false, "/etc/ld.so.cache": false, helperPath: false, h.Policy.Workspace: true, h.Policy.TempDir: true}
	fds := map[int]bool{policyFD: true, envFD: true}
	if policyFD < 3 || envFD < 3 || policyFD > 65535 || envFD > 65535 || policyFD == envFD {
		return nil, fail("setup_failed", "invalid handoff descriptors")
	}
	for _, b := range h.Bindings {
		writable, ok := expected[b.Dest]
		if !ok || writable != b.Writable || !cleanAbsolute(b.Source) || b.Identity.Ino == 0 {
			return nil, fail("setup_failed", "invalid bind mapping")
		}
		if b.Dest != helperPath && b.Source != b.Dest {
			return nil, fail("setup_failed", "source destination remapping is unsupported")
		}
		if b.Dest == helperPath && (within(h.Policy.Workspace, b.Source) || within(h.Policy.TempDir, b.Source)) {
			return nil, fail("policy_invalid", "helper source overlaps writable grant")
		}
		if b.Directory != (b.Dest == "/usr" || b.Writable) {
			return nil, fail("setup_failed", "invalid bind type")
		}
		delete(expected, b.Dest)
		for _, fd := range []int{b.BindFD, b.IdentityFD} {
			if fd < 3 || fd > 65535 || fds[fd] {
				return nil, fail("setup_failed", "colliding bind descriptors")
			}
			fds[fd] = true
		}
	}
	if len(expected) != 0 {
		return nil, fail("setup_failed", "missing required binding")
	}
	args := []string{"--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net", "--new-session", "--die-with-parent", "--cap-drop", "ALL", "--hostname", "pi-local-offline", "--clearenv"}
	for _, entry := range engineEnvironment() {
		k, v, _ := strings.Cut(entry, "=")
		args = append(args, "--setenv", k, v)
	}
	args = append(args, "--proc", "/proc", "--remount-ro", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run", "--dir", "/home/sandbox", "--dir", "/.pi-local", "--dir", "/etc")
	// Empty ancestors reveal no host directory entries. Never bind home/data/agent.
	dirs := map[string]bool{}
	for _, b := range h.Bindings {
		dest := b.Dest
		if !b.Directory {
			dest = path.Dir(dest)
		}
		for dest != "/" {
			dirs[dest] = true
			dest = path.Dir(dest)
		}
	}
	ordered := make([]string, 0, len(dirs))
	for d := range dirs {
		ordered = append(ordered, d)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if len(ordered[i]) == len(ordered[j]) {
			return ordered[i] < ordered[j]
		}
		return len(ordered[i]) < len(ordered[j])
	})
	for _, d := range ordered {
		args = append(args, "--dir", d)
	}
	for _, alias := range [][2]string{{"usr/bin", "/bin"}, {"usr/sbin", "/sbin"}, {"usr/lib", "/lib"}, {"usr/lib64", "/lib64"}} {
		args = append(args, "--symlink", alias[0], alias[1])
	}
	for _, writable := range []bool{false, true} {
		if writable {
			args = append(args, "--remount-ro", "/")
		}
		for _, b := range h.Bindings {
			if b.Writable != writable {
				continue
			}
			flag := "--ro-bind-fd"
			if writable {
				flag = "--bind-fd"
			}
			args = append(args, flag, strconv.Itoa(b.BindFD), b.Dest)
		}
	}
	// chdir / cannot traverse writable content. The guard chdirs only after checks.
	args = append(args, "--chdir", "/", "--", helperPath, "guard", fmt.Sprint(policyFD), fmt.Sprint(envFD))
	return args, nil
}
