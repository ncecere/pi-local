// Package runtimeenv discovers Node, recovers Unix login PATHs for GUI launches,
// filters the runtime environment, and writes the app's embedded runtime bundle.
// It does not infer platform-specific application package layouts.
package runtimeenv

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/ncecere/pi-local/internal/supervisor"
)

// LoginPath reads a non-interactive login shell on Unix, never on Windows.
// Empty and relative entries are excluded even when login recovery fails.
func LoginPath(ctx context.Context) string {
	lookup := environmentLookup(runtime.GOOS, os.Environ())
	current, _ := lookup("PATH")
	shell, _ := lookup("SHELL")
	return loginPathForOS(ctx, runtime.GOOS, current, shell, commandOutput)
}

type commandRunner func(context.Context, string, ...string) ([]byte, error)

func commandOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	// A shell wrapper/profile can leave a descendant holding stdout open after
	// cancellation. Bound pipe draining as well as the direct process lifetime.
	cmd.WaitDelay = 250 * time.Millisecond
	return cmd.Output()
}

func loginPathForOS(ctx context.Context, goos, current, shell string, run commandRunner) string {
	current = mergePathsForOS(goos, current, "")
	if goos == "windows" {
		return current
	}
	if !absolutePath(goos, shell) {
		shell = "/bin/sh"
		if goos == "darwin" {
			shell = "/bin/zsh"
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if ctx.Err() != nil {
		return current
	}
	// The marker separates PATH from profile output. Tests inject the executor;
	// they must not source the developer's actual login profiles.
	out, err := run(ctx, shell, "-l", "-c", `printf '__PI_PATH__%s' "$PATH"`)
	if err != nil {
		return current
	}
	_, recovered, found := strings.Cut(string(out), "__PI_PATH__")
	if !found || strings.TrimSpace(recovered) == "" {
		return current
	}
	return mergePathsForOS(goos, strings.TrimSpace(recovered), current)
}

func mergePaths(a, b string) string {
	return mergePathsForOS(runtime.GOOS, a, b)
}

// MinNodeMajor, MinNodeMinor: the runtime needs node:sqlite and pi-durable's engines (Node 22.19).
const MinNodeMajor, MinNodeMinor = 22, 19

// FindNode tries PI_LOCAL_NODE, the caller's exact bundled candidate, then PATH.
// Explicit relative paths (including a bare filename) deliberately resolve against
// the cwd, never PATH. PATH itself accepts only absolute dirs. Windows probes only
// node.exe, without PATHEXT, shell wrappers, or Unix executable-bit requirements.
func FindNode(ctx context.Context, path string, bundled string) (string, error) {
	lookup := environmentLookup(runtime.GOOS, os.Environ())
	explicit, _ := lookup("PI_LOCAL_NODE")
	candidates := nodeCandidates(runtime.GOOS, explicit, bundled, path)
	var problems []string
	seen := map[string]bool{}
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		c := candidate
		if !filepath.IsAbs(c) {
			var err error
			c, err = filepath.Abs(c)
			if err != nil {
				continue
			}
		}
		if seen[pathKey(runtime.GOOS, c)] {
			continue
		}
		seen[pathKey(runtime.GOOS, c)] = true
		if !nodeExecutableName(runtime.GOOS, c) {
			continue
		}
		info, err := os.Stat(c)
		if err != nil || !nodeFileMode(runtime.GOOS, info.Mode()) {
			continue
		}
		version, err := nodeVersion(ctx, c)
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", c, err))
			continue
		}
		if !atLeast(version, MinNodeMajor, MinNodeMinor) {
			problems = append(problems, fmt.Sprintf("%s is %s", c, version))
			continue
		}
		return c, nil
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	msg := fmt.Sprintf("Pi Local needs Node.js %d.%d or newer to run agents", MinNodeMajor, MinNodeMinor)
	if len(problems) > 0 {
		msg += " (found: " + strings.Join(problems, "; ") + ")"
	}
	return "", errors.New(msg)
}

func nodeFileMode(goos string, mode os.FileMode) bool {
	return mode.IsRegular() && (goos == "windows" || mode&0o111 != 0)
}

func nodeVersion(ctx context.Context, node string) (string, error) {
	return nodeVersionWithRunner(ctx, node, 10*time.Second, commandOutput)
}

func nodeVersionWithRunner(ctx context.Context, node string, timeout time.Duration, run commandRunner) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	out, err := run(ctx, node, "--version")
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// Require a stable semver, not a partial version, banner, or prerelease.
var stableNodeVersion = regexp.MustCompile(`^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$`)

func atLeast(version string, major, minor int) bool {
	parts := stableNodeVersion.FindStringSubmatch(version)
	if parts == nil {
		return false
	}
	values := [3]uint64{}
	for i := range values {
		n, err := strconv.ParseUint(parts[i+1], 10, 64)
		if err != nil {
			return false
		}
		values[i] = n
	}
	return values[0] > uint64(major) || (values[0] == uint64(major) && values[1] >= uint64(minor))
}

// WriteBundle writes the runtime bundle to <dir>/<hash>/runtime.mjs once (a new app version gets a new directory)
// and returns how to run it.
func WriteBundle(dir string, script []byte, node string) (supervisor.Runtime, error) {
	sum := sha256.Sum256(script)
	target := filepath.Join(dir, hex.EncodeToString(sum[:8]))
	file := filepath.Join(target, "runtime.mjs")
	if existing, err := os.ReadFile(file); err != nil || sha256.Sum256(existing) != sum {
		if err := os.MkdirAll(target, 0o700); err != nil {
			return supervisor.Runtime{}, err
		}
		tmp := file + ".tmp"
		if err := os.WriteFile(tmp, script, 0o600); err != nil {
			return supervisor.Runtime{}, err
		}
		if err := os.Rename(tmp, file); err != nil {
			return supervisor.Runtime{}, err
		}
	}
	return supervisor.Runtime{Node: node, Args: []string{"--disable-warning=ExperimentalWarning"}, Script: file, Dir: target}, nil
}
