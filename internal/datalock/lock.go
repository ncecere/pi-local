// Package datalock owns the data directory's nonblocking, single-instance lock.
// The persistent .lock file must never be removed or replaced while in use.
package datalock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// ErrLocked identifies contention, not permissions or other I/O failures.
var ErrLocked = errors.New("data directory is already locked")

// LockedError reports contention while preserving the underlying OS error.
type LockedError struct {
	Path string
	Err  error
}

func (e *LockedError) Error() string        { return fmt.Sprintf("locking %s: %v", e.Path, e.Err) }
func (e *LockedError) Unwrap() error        { return e.Err }
func (e *LockedError) Is(target error) bool { return target == ErrLocked }

// Lock owns an open, locked handle until Close. A Lock must not be copied.
// Close is safe to call repeatedly or concurrently.
type Lock struct {
	file *os.File
	once sync.Once
	err  error
}

// Acquire locks dir/.lock exclusively without waiting. The directory must exist.
// Only OS lock-contention errors match ErrLocked and have type *LockedError.
// The OS releases the lock if the owning process exits, including after a crash.
func Acquire(dir string) (*Lock, error) {
	path := filepath.Join(dir, ".lock")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(f); err != nil {
		f.Close()
		if isContention(err) {
			return nil, &LockedError{Path: path, Err: err}
		}
		return nil, fmt.Errorf("locking %s: %w", path, err)
	}
	return &Lock{file: f}, nil
}

// Close releases the lock and closes its handle, but never removes the lock file.
// Repeated calls return the same result without touching a reused OS handle.
func (l *Lock) Close() error {
	l.once.Do(func() {
		l.err = errors.Join(unlockFile(l.file), l.file.Close())
	})
	return l.err
}
