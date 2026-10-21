package linuxsandbox

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

type mount struct {
	Point    string
	FSType   string
	Options  map[string]bool
	Optional []string
}

func mountPath(s string) (string, error) {
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' {
			out.WriteByte(s[i])
			continue
		}
		if i+3 >= len(s) {
			return "", fmt.Errorf("bad mount escape")
		}
		n, err := strconv.ParseUint(s[i+1:i+4], 8, 8)
		if err != nil || (n != 32 && n != 9 && n != 10 && n != 92) {
			return "", fmt.Errorf("bad mount escape")
		}
		out.WriteByte(byte(n))
		i += 3
	}
	return out.String(), nil
}
func parseMounts(r io.Reader) ([]mount, error) {
	s := bufio.NewScanner(io.LimitReader(r, (1<<20)+1))
	s.Buffer(make([]byte, 4096), 64<<10)
	var out []mount
	bytes := 0
	for s.Scan() {
		bytes += len(s.Bytes()) + 1
		if bytes > 1<<20 || len(out) >= 4096 {
			return nil, fmt.Errorf("mount table too large")
		}
		f := strings.Fields(s.Text())
		sep := -1
		for i, v := range f {
			if v == "-" {
				sep = i
				break
			}
		}
		if sep < 6 || len(f) < sep+4 {
			return nil, fmt.Errorf("malformed mount table")
		}
		p, err := mountPath(f[4])
		if err != nil {
			return nil, err
		}
		opts := map[string]bool{}
		for _, o := range strings.Split(f[5], ",") {
			opts[o] = true
		}
		out = append(out, mount{Point: p, FSType: f[sep+1], Options: opts, Optional: f[6:sep]})
	}
	if err := s.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("empty mount table")
	}
	return out, nil
}
func noDescendantMounts(mounts []mount, root string) error {
	for _, m := range mounts {
		if m.Point != root && within(root, m.Point) {
			return fail("layout_unsupported", "bind descendant mounts are not supported")
		}
	}
	return nil
}
func verifyMounts(mounts []mount, bindings []binding) error {
	allowed := map[string]string{"/": "tmpfs", "/proc": "proc", "/tmp": "tmpfs", "/run": "tmpfs", "/dev": "tmpfs", "/dev/pts": "devpts"}
	for _, name := range []string{"sys", "sysrq-trigger", "irq", "bus"} {
		allowed["/proc/"+name] = ""
	}
	for _, name := range []string{"null", "zero", "full", "random", "urandom", "tty", "console"} {
		allowed["/dev/"+name] = ""
	}
	for _, b := range bindings {
		allowed[b.Dest] = ""
	}
	seen := map[string]bool{}
	for _, m := range mounts {
		fs, ok := allowed[m.Point]
		if !ok || seen[m.Point] || fs != "" && fs != m.FSType {
			return fail("guard_failed", "unexpected mount or filesystem in fresh root")
		}
		seen[m.Point] = true
		if within("/proc", m.Point) && (!m.Options["ro"] || !m.Options["nosuid"] || !m.Options["nodev"] || !m.Options["noexec"]) {
			return fail("guard_failed", "all proc mounts must be readonly and hardened")
		}
		if m.Point == "/" && (!m.Options["ro"] || !m.Options["nosuid"] || !m.Options["nodev"]) {
			return fail("guard_failed", "unsafe fresh root flags")
		}
	}
	for _, required := range []string{"/", "/tmp", "/run", "/dev", "/dev/pts"} {
		if !seen[required] {
			return fail("guard_failed", "missing fresh root mount")
		}
	}
	procCount := 0
	for _, m := range mounts {
		if m.Point == "/proc" {
			procCount++
			if !m.Options["ro"] || !m.Options["nosuid"] || !m.Options["nodev"] || !m.Options["noexec"] {
				return fail("guard_failed", "proc must be readonly, nodev, nosuid, noexec")
			}
		}
	}
	if procCount != 1 {
		return fail("guard_failed", "missing or stacked private proc mount")
	}
	for _, b := range bindings {
		if err := noDescendantMounts(mounts, b.Dest); err != nil {
			return err
		}
		count := 0
		for _, m := range mounts {
			if m.Point != b.Dest {
				continue
			}
			count++
			if !m.Options["nosuid"] || !m.Options["nodev"] || (!b.Writable && !m.Options["ro"]) || (b.Writable && !m.Options["rw"]) {
				return fail("guard_failed", "unsafe import flags")
			}
			// Slave mounts can receive future host submounts after the identity check.
			// Refuse them rather than assuming that a one-time mountinfo scan suffices.
			if len(m.Optional) != 0 {
				return fail("layout_unsupported", "imports must be private, without propagation tags")
			}
		}
		if count != 1 {
			return fail("guard_failed", "missing or stacked import mount")
		}
	}
	return nil
}
