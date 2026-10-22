//go:build !darwin

package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/ncecere/pi-local/internal/api"
	"github.com/ncecere/pi-local/internal/host"
)

func TestStartupUnsupported(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	// A synthetic macOS-shaped tree must not be read or changed on other OSes.
	path := filepath.Join(home, "Library", "LaunchAgents", "dev.bitop.pi-local.plist")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	const sentinel = "not a real LaunchAgent"
	if err := os.WriteFile(path, []byte(sentinel), 0o600); err != nil {
		t.Fatal(err)
	}
	d := desktop{dataDir: t.TempDir()}
	if capability := d.Capabilities()[api.DesktopLaunchAtLogin]; capability.Available || capability.Reason == "" {
		t.Fatalf("capability: %+v", capability)
	}
	if d.Capabilities()["unknown"].Available {
		t.Fatal("unknown capability must fail closed")
	}
	check := func(err error) {
		t.Helper()
		var unavailable *host.UnavailableError
		if !errors.Is(err, host.ErrUnsupported) || !errors.As(err, &unavailable) ||
			unavailable.Platform != runtime.GOOS || string(unavailable.Operation) != api.DesktopLaunchAtLogin || unavailable.Reason == "" {
			t.Fatalf("expected typed unsupported: %v", err)
		}
	}
	on, err := d.LaunchAtLogin()
	check(err)
	if on {
		t.Fatal("must not report the synthetic macOS file as enabled")
	}
	check(d.SetLaunchAtLogin(true))
	check(d.SetLaunchAtLogin(false))
	if raw, err := os.ReadFile(path); err != nil || string(raw) != sentinel {
		t.Fatalf("synthetic file changed: %q, %v", raw, err)
	}
	// No valid home directory is needed for unsupported results.
	t.Setenv("HOME", "")
	t.Setenv("USERPROFILE", "")
	_, err = d.LaunchAtLogin()
	check(err)
	check(d.SetLaunchAtLogin(true))
}
