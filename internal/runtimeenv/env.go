package runtimeenv

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// BaseEnv is the runtime's minimal inherited environment, never the app's secrets.
// No provider tokens, API keys, NODE_OPTIONS/NODE_PATH, or loader settings pass.
func BaseEnv(dataDir string) map[string]string {
	return baseEnvForOS(dataDir, runtime.GOOS, environmentLookup(runtime.GOOS, os.Environ()))
}

// environmentLookup snapshots an injected environ. Windows keys are insensitive
// to case; the last duplicate wins (as in os/exec's environment deduplication).
// Callers receive canonical allowlist spellings, never competing Path/PATH keys.
func environmentLookup(goos string, environ []string) func(string) (string, bool) {
	key := func(s string) string {
		if goos == "windows" {
			return strings.ToUpper(s)
		}
		return s
	}
	values := make(map[string]string)
	for _, entry := range environ {
		k, v, ok := strings.Cut(entry, "=")
		if ok && k != "" {
			values[key(k)] = v
		}
	}
	return func(k string) (string, bool) {
		v, ok := values[key(k)]
		return v, ok
	}
}

// Pure aside from the supplied lookup: tests never read the person's environment.
func baseEnvForOS(dataDir, goos string, lookup func(string) (string, bool)) map[string]string {
	env := map[string]string{"NODE_COMPILE_CACHE": filepath.Join(dataDir, "cache", "node")}
	keys := []string{"PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR", "SHELL"}
	if goos == "windows" {
		// SystemRoot is required by Windows child processes; USERPROFILE supports
		// home discovery; TEMP/TMP support temporary files. COMSPEC is Node's
		// child_process.exec shell override (otherwise cmd.exe), not a login shell.
		keys = append(keys, "SystemRoot", "USERPROFILE", "TEMP", "TMP", "COMSPEC")
	}
	for _, k := range keys {
		if v, ok := lookup(k); ok {
			if k == "PATH" {
				v = mergePathsForOS(goos, v, "")
			}
			env[k] = v
		}
	}
	return env
}
