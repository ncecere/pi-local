package linuxsandbox

import (
	"path"
	"sort"
)

// scaffold contains only directories owned by the fresh root layout, never an
// imported tree. Listing these cannot race with target code: the target has not
// started, and no host grant contains one of these namespace-local directories.
func scaffold(bindings []binding) map[string]map[string]bool {
	dirs := map[string]map[string]bool{"/": {}}
	add := func(p string, isDir bool) {
		if isDir && dirs[p] == nil {
			dirs[p] = map[string]bool{}
		}
		for p != "/" {
			parent := path.Dir(p)
			if dirs[parent] == nil {
				dirs[parent] = map[string]bool{}
			}
			dirs[parent][path.Base(p)] = true
			p = parent
		}
	}
	for _, p := range []string{"/home/sandbox", "/etc", "/.pi-local"} {
		add(p, true)
	}
	for _, p := range []string{"/proc", "/dev", "/tmp", "/run", "/bin", "/sbin", "/lib", "/lib64"} {
		add(p, false)
	}
	// tmp and run are private tmpfs, but may contain scaffolding for managed
	// fixture roots. They must not contain any other entries at guard time.
	dirs["/tmp"] = map[string]bool{}
	dirs["/run"] = map[string]bool{}
	for _, b := range bindings {
		add(b.Dest, false)
	}
	return dirs
}
func verifyScaffold(bindings []binding, list func(string) ([]string, error)) error {
	dirs := scaffold(bindings)
	ordered := make([]string, 0, len(dirs))
	for p := range dirs {
		ordered = append(ordered, p)
	}
	sort.Strings(ordered)
	for _, p := range ordered {
		entries, err := list(p)
		if err != nil {
			return fail("guard_failed", "cannot inspect fresh scaffold")
		}
		if len(entries) != len(dirs[p]) {
			return fail("guard_failed", "fresh root contains unexpected entries")
		}
		for _, entry := range entries {
			if !dirs[p][entry] {
				return fail("guard_failed", "fresh root contains unexpected data")
			}
		}
	}
	return nil
}

// identityCheck separates inode comparison from Linux syscalls for adversarial
// tests. An fd identity, not a re-resolved source string, authorizes each mount.
func identityCheck(bindings []binding, probe func(binding) (identity, identity, error)) error {
	for _, b := range bindings {
		source, mounted, err := probe(b)
		if err != nil || source != b.Identity || mounted != source {
			return fail("guard_failed", "mounted root does not match preopened descriptor")
		}
	}
	return nil
}
