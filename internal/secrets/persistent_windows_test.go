//go:build windows

package secrets

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type refusingVault struct{ called bool }

func (v *refusingVault) Get(context.Context, string) (string, error) {
	v.called = true
	return "", ErrNotFound
}
func (v *refusingVault) Set(context.Context, string, string) error {
	v.called = true
	return ErrBackend
}

func TestPersistentWindowsRefusesBeforeIO(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not-created")
	v := &refusingVault{}
	_, err := OpenPersistent(context.Background(), Options{Dir: dir, Vault: v})
	if !errors.Is(err, ErrUnsupported) || v.called {
		t.Fatal("must refuse without vault access")
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unsupported platform touched directory")
	}
}
