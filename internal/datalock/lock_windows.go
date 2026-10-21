//go:build windows

package datalock

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// Every owner locks the same byte at offset zero, including on an empty file.
func lockFile(f *os.File) error {
	return windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
}

func unlockFile(f *os.File) error {
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &windows.Overlapped{})
}

func isContention(err error) bool {
	return errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}
