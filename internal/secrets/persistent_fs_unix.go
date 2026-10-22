//go:build darwin || linux

package secrets

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func ownedPrivate(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid()) && info.Mode().Perm()&0o077 == 0
}

func preparePrivateDir(path string, deps persistentDeps) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", ErrUnavailable
	}
	info, err := os.Lstat(abs)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.Mkdir(abs, 0o700); err != nil {
			return "", ErrUnavailable
		}
		info, err = os.Lstat(abs)
	}
	if err != nil {
		return "", ErrUnavailable
	}
	if !info.IsDir() || !ownedPrivate(info) {
		return "", ErrDenied
	}
	canonical, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", ErrUnavailable
	}
	// Sync the parent even on reopen, reconciling an earlier ambiguous mkdir.
	if deps.syncDir(filepath.Dir(canonical)) != nil {
		return "", ErrUnavailable
	}
	return canonical, nil
}

func privateFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return ErrUnavailable
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || !ownedPrivate(info) || !ok || stat.Nlink != 1 {
		return ErrDenied
	}
	return nil
}

func syncDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return ErrUnavailable
	}
	syncErr := f.Sync()
	closeErr := f.Close()
	if syncErr != nil || closeErr != nil {
		return ErrUnavailable
	}
	return nil
}
