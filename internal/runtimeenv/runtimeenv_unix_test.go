//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly

package runtimeenv

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// All synthetic executables are non-login /bin/sh scripts, not real Node or
// user profile readers. Shared Unix fixtures keep imports valid on Linux/macOS.
func fakeNode(t *testing.T, file, body string, mode os.FileMode) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("#!/bin/sh\n"+body+"\n"), mode); err != nil {
		t.Fatal(err)
	}
	return file
}

func versionNode(t *testing.T, file, version string) string {
	t.Helper()
	return fakeNode(t, file, "[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 7\nprintf '%s\\n' '"+version+"'", 0o700)
}

func TestFindNodeSyntheticPrecedence(t *testing.T) {
	t.Setenv("PI_LOCAL_NODE", "")
	dir := filepath.Join(t.TempDir(), "space 工具")
	explicit := versionNode(t, filepath.Join(dir, "explicit"), "v22.19.0")
	bundled := versionNode(t, filepath.Join(dir, "bundled"), "v24.1.0")
	pathNode := versionNode(t, filepath.Join(dir, "path", "node"), "v23.0.0")
	t.Setenv("PI_LOCAL_NODE", explicit)
	check := func(want string) {
		t.Helper()
		got, err := FindNode(context.Background(), filepath.Dir(pathNode), bundled)
		if err != nil || got != want {
			t.Fatalf("got %q, %v want %q", got, err, want)
		}
	}
	check(explicit)
	t.Setenv("PI_LOCAL_NODE", "")
	check(bundled)
	versionNode(t, bundled, "v22.18.9")
	check(pathNode)
	t.Setenv("PI_LOCAL_NODE", explicit)
	versionNode(t, explicit, "v22.19.0-rc.1")
	check(pathNode)
	versionNode(t, explicit, "v22.19.0junk")
	versionNode(t, pathNode, "v21.99.0")
	if _, err := FindNode(context.Background(), filepath.Dir(pathNode), bundled); err == nil || !strings.Contains(err.Error(), "22.19") {
		t.Fatalf("expected minimum-version failure, got %v", err)
	}
}

func TestFindNodeExecutableBoundaries(t *testing.T) {
	t.Setenv("PI_LOCAL_NODE", "")
	dir := t.TempDir()
	good := versionNode(t, filepath.Join(dir, "good", "node"), "v22.19.0")
	noExec := fakeNode(t, filepath.Join(dir, "noexec", "node"), "exit 99", 0o600)
	isDir := filepath.Join(dir, "directory", "node")
	if err := os.MkdirAll(isDir, 0o700); err != nil {
		t.Fatal(err)
	}
	broken := fakeNode(t, filepath.Join(dir, "broken", "node"), "exit 42", 0o700)
	search := strings.Join([]string{filepath.Join(dir, "missing"), filepath.Dir(noExec), filepath.Dir(isDir), filepath.Dir(broken), filepath.Dir(good)}, ":")
	got, err := FindNode(context.Background(), search, "")
	if err != nil || got != good {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestFindNodeNoImplicitWorkspace(t *testing.T) {
	t.Setenv("PI_LOCAL_NODE", "")
	workspace := t.TempDir()
	node := versionNode(t, filepath.Join(workspace, "node"), "v22.19.0")
	t.Chdir(workspace)
	for _, search := range []string{"", ":", ".", "relative:.:"} {
		if got, err := FindNode(context.Background(), search, ""); err == nil {
			t.Fatalf("implicit workspace node from %q: %q", search, got)
		}
	}
	// A deliberate explicit relative override stays supported, but is made
	// absolute before os/exec so a bare name never triggers PATH lookup.
	for _, explicit := range []string{"node", "./node"} {
		t.Setenv("PI_LOCAL_NODE", explicit)
		got, err := FindNode(context.Background(), "", "")
		if err != nil || got != node {
			t.Fatalf("explicit %q: got %q %v", explicit, got, err)
		}
	}
}

func TestNativeNodeVersionCancellation(t *testing.T) {
	node := fakeNode(t, filepath.Join(t.TempDir(), "slow node"), "while :; do :; done", 0o700)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := nodeVersion(ctx, node); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("cancellation did not terminate synthetic executable promptly")
	}
	t.Setenv("PI_LOCAL_NODE", node)
	ctx, cancel2 := context.WithCancel(context.Background())
	cancel2()
	if _, err := FindNode(ctx, "", ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("FindNode lost cancellation: %v", err)
	}
}
