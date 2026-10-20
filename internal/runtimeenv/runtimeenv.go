// Package runtimeenv finds what the agent runtime needs on this machine: a Node binary, the person's own PATH (an
// app opened from Finder gets a minimal one, without Homebrew, nix or version managers), and the runtime bundle
// written out from the app's own copy.
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
	"strings"
	"time"

	"github.com/ncecere/pi-local/internal/supervisor"
)

// LoginPath is the PATH the person's login shell sets up, or the process's own PATH if that can't be read.
func LoginPath(ctx context.Context) string {
	current := os.Getenv("PATH")
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	// A login shell (not interactive: no prompts, no rc noise on stdout); the marker separates PATH from anything a
	// profile prints.
	out, err := exec.CommandContext(ctx, shell, "-l", "-c", `printf '__PI_PATH__%s' "$PATH"`).Output()
	if err != nil {
		return current
	}
	_, path, found := strings.Cut(string(out), "__PI_PATH__")
	if !found || strings.TrimSpace(path) == "" {
		return current
	}
	return mergePaths(strings.TrimSpace(path), current)
}

// mergePaths is a's entries, then b's that a lacks.
func mergePaths(a, b string) string {
	seen := map[string]bool{}
	var out []string
	for _, p := range append(strings.Split(a, ":"), strings.Split(b, ":")...) {
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return strings.Join(out, ":")
}

// MinNodeMajor, MinNodeMinor: the runtime needs node:sqlite and pi-durable's engines (Node 22.19).
const MinNodeMajor, MinNodeMinor = 22, 19

// FindNode returns a Node binary new enough for the runtime: explicit (PI_LOCAL_NODE), bundled next to the app,
// or the first on path.
func FindNode(ctx context.Context, path string, bundled string) (string, error) {
	var candidates []string
	if v := os.Getenv("PI_LOCAL_NODE"); v != "" {
		candidates = append(candidates, v)
	}
	if bundled != "" {
		candidates = append(candidates, bundled)
	}
	for _, dir := range strings.Split(path, ":") {
		if dir != "" {
			candidates = append(candidates, filepath.Join(dir, "node"))
		}
	}
	var problems []string
	for _, c := range candidates {
		info, err := os.Stat(c)
		if err != nil || info.IsDir() || info.Mode()&0o111 == 0 {
			continue
		}
		version, err := nodeVersion(ctx, c)
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
	msg := fmt.Sprintf("Pi Local needs Node.js %d.%d or newer to run agents", MinNodeMajor, MinNodeMinor)
	if len(problems) > 0 {
		msg += " (found: " + strings.Join(problems, "; ") + ")"
	}
	return "", errors.New(msg)
}

func nodeVersion(ctx context.Context, node string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, node, "--version").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func atLeast(version string, major, minor int) bool {
	var M, m, p int
	if _, err := fmt.Sscanf(strings.TrimPrefix(version, "v"), "%d.%d.%d", &M, &m, &p); err != nil {
		return false
	}
	return M > major || (M == major && m >= minor)
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
