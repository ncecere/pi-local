package datalock

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func requireLocked(t *testing.T, dir string) {
	t.Helper()
	lock, err := Acquire(dir)
	if lock != nil {
		lock.Close()
		t.Fatal("unexpectedly acquired a held lock")
	}
	var locked *LockedError
	if !errors.Is(err, ErrLocked) || !errors.As(err, &locked) {
		t.Fatalf("expected typed contention, got %T: %v", err, err)
	}
	if locked.Path != filepath.Join(dir, ".lock") || !isContention(errors.Unwrap(locked)) {
		t.Fatalf("contention lost path or OS cause: %+v", locked)
	}
}

func TestCloseIsIdempotentAndKeepsFile(t *testing.T) {
	dir := t.TempDir()
	first, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { first.Close() })
	before, err := os.Stat(filepath.Join(dir, ".lock"))
	if err != nil {
		t.Fatal(err)
	}
	requireLocked(t, dir)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	// A second close must not unlock/close an OS handle reused by a new owner.
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	requireLocked(t, dir)
	after, err := os.Stat(filepath.Join(dir, ".lock"))
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("lock file was removed or replaced: %v", err)
	}
}

func TestConcurrentClose(t *testing.T) {
	lock, err := Acquire(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			if err := lock.Close(); err != nil {
				t.Errorf("Close: %v", err)
			}
		})
	}
	wg.Wait()
}

func TestOpenErrorsAreNotContention(t *testing.T) {
	root := t.TempDir()
	tests := []struct {
		name string
		dir  string
	}{
		{"missing parent", filepath.Join(root, "missing")},
		{"lock path is a directory", filepath.Join(root, "directory")},
		{"parent is a file", filepath.Join(root, "file")},
	}
	if err := os.MkdirAll(filepath.Join(tests[1].dir, ".lock"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tests[2].dir, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			lock, err := Acquire(tt.dir)
			if lock != nil {
				lock.Close()
				t.Fatal("unexpected lock")
			}
			var pathErr *os.PathError
			var locked *LockedError
			if err == nil || errors.Is(err, ErrLocked) || errors.As(err, &locked) || !errors.As(err, &pathErr) {
				t.Fatalf("expected preserved I/O error, got %T: %v", err, err)
			}
			if pathErr.Err == nil || !errors.Is(err, pathErr.Err) {
				t.Fatalf("lost underlying I/O error: %v", err)
			}
		})
	}
}

// Only this test binary is launched or killed; no app/runtime/native process is involved.
func helperCommand(t *testing.T, dir, mode string) *exec.Cmd {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestLockHelperProcess$")
	cmd.Env = append(os.Environ(), "PI_LOCAL_DATALOCK_HELPER="+mode, "PI_LOCAL_DATALOCK_DIR="+dir)
	return cmd
}

func tryHelper(t *testing.T, dir, want string) {
	t.Helper()
	out, err := helperCommand(t, dir, "try").CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != want {
		t.Fatalf("helper: want %q, output %q, error %v", want, out, err)
	}
}

func holdHelper(t *testing.T, dir string) (*exec.Cmd, io.WriteCloser) {
	t.Helper()
	cmd := helperCommand(t, dir, "hold")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stdin.Close()
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || line != "held\n" {
		t.Fatalf("helper readiness: %q, %v", line, err)
	}
	return cmd, stdin
}

func TestSubprocessExclusivityAndIndependentDirectories(t *testing.T) {
	dir := t.TempDir()
	cmd, stdin := holdHelper(t, dir)
	requireLocked(t, dir)
	tryHelper(t, dir, "locked")
	tryHelper(t, t.TempDir(), "acquired")
	if _, err := stdin.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	tryHelper(t, dir, "acquired")
	// Check the reverse direction as well: a parent owner excludes a child.
	lock, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	tryHelper(t, dir, "locked")
}

func TestSubprocessCrashReleasesLock(t *testing.T) {
	dir := t.TempDir()
	cmd, _ := holdHelper(t, dir)
	requireLocked(t, dir)
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	var exitErr *exec.ExitError
	if err := cmd.Wait(); !errors.As(err, &exitErr) {
		t.Fatalf("expected killed helper exit, got %v", err)
	}
	// No cleanup/unlock ran in the child; the kernel released its handle.
	tryHelper(t, dir, "acquired")
}

func TestLockHelperProcess(t *testing.T) {
	mode := os.Getenv("PI_LOCAL_DATALOCK_HELPER")
	if mode == "" {
		return
	}
	lock, err := Acquire(os.Getenv("PI_LOCAL_DATALOCK_DIR"))
	if mode == "try" && errors.Is(err, ErrLocked) {
		var locked *LockedError
		if !errors.As(err, &locked) || !isContention(locked.Err) {
			t.Fatalf("lost typed OS contention: %v", err)
		}
		fmt.Println("locked")
		os.Exit(0)
	}
	if err != nil {
		t.Fatal(err)
	}
	switch mode {
	case "try":
		fmt.Println("acquired")
	case "hold":
		fmt.Println("held")
		if _, err := io.ReadFull(os.Stdin, make([]byte, 1)); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatalf("unknown helper mode %q", mode)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	os.Exit(0)
}
