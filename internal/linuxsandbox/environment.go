package linuxsandbox

import (
	"sort"
	"strings"
	"unicode/utf8"
)

// This literal is the entire environment of dynamic bubblewrap AND the static
// guard. Never append os.Environ or targetEnv to it (including during probes).
func engineEnvironment() []string {
	return []string{"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "HOME=/home/sandbox", "TMPDIR=/tmp"}
}

func targetEnvironment(env []string, p Policy) ([]string, error) {
	if len(env) > MaxEnv {
		return nil, fail("environment_invalid", "too many environment entries")
	}
	values := map[string]string{}
	n := 0
	for _, entry := range env {
		n += len(entry) + 1
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" || !utf8.ValidString(entry) || strings.ContainsRune(entry, 0) {
			return nil, fail("environment_invalid", "invalid environment entry")
		}
		if _, exists := values[key]; exists {
			return nil, fail("environment_invalid", "duplicate environment key")
		}
		values[key] = value
	}
	if n > MaxEnvBytes {
		return nil, fail("environment_invalid", "environment exceeds 128 KiB")
	}
	// Host service discovery variables are intentionally not useful in the new root.
	for _, key := range []string{"SSH_AUTH_SOCK", "SSH_AGENT_PID", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"} {
		delete(values, key)
	}
	for key, value := range map[string]string{"HOME": "/home/sandbox", "USER": "sandbox", "LOGNAME": "sandbox", "TMPDIR": p.TempDir, "TMP": p.TempDir, "TEMP": p.TempDir, "PWD": p.Workspace, "PATH": "/usr/bin:/bin"} {
		values[key] = value
	}
	out := make([]string, 0, len(values))
	total := 0
	for k, v := range values {
		s := k + "=" + v
		total += len(s) + 1
		out = append(out, s)
	}
	sort.Strings(out)
	if len(out) > MaxEnv || total > MaxEnvBytes {
		return nil, fail("environment_invalid", "normalized environment exceeds bounds")
	}
	return out, nil
}
