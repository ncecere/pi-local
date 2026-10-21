//go:build darwin || linux

package datalock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestContentionErrnos(t *testing.T) {
	for _, tt := range []struct {
		err  error
		want bool
	}{
		{syscall.EWOULDBLOCK, true},
		{syscall.EAGAIN, true},
		{syscall.EACCES, false},
		{syscall.EPERM, false},
		{syscall.EIO, false},
		{syscall.EBADF, false},
		{syscall.ENOLCK, false},
		{syscall.EINTR, false},
		{errors.New("other failure"), false},
		{nil, false},
	} {
		if got := isContention(tt.err); got != tt.want {
			t.Errorf("isContention(%v) = %v, want %v", tt.err, got, tt.want)
		}
		if tt.err != nil && isContention(fmt.Errorf("wrapped: %w", tt.err)) != tt.want {
			t.Errorf("wrapped error classification: %v", tt.err)
		}
	}
}

func TestPermissionErrorIsPreserved(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses file permission checks")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".lock"), nil, 0o400); err != nil {
		t.Fatal(err)
	}
	lock, err := Acquire(dir)
	if lock != nil {
		lock.Close()
		t.Fatal("unexpected lock on read-only file")
	}
	var locked *LockedError
	if !errors.Is(err, os.ErrPermission) || errors.Is(err, ErrLocked) || errors.As(err, &locked) {
		t.Fatalf("expected preserved permission error, got %T: %v", err, err)
	}
}
