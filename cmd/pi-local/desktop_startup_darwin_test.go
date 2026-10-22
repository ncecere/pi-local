//go:build darwin

package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/ncecere/pi-local/internal/api"
)

func TestLaunchAtLogin(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // never the real ~/Library/LaunchAgents
	d := desktop{dataDir: "/tmp/Pi Local & data"}
	if capability := d.Capabilities()[api.DesktopLaunchAtLogin]; !capability.Available || capability.Reason == "" {
		t.Fatalf("capability: %+v", capability)
	}
	if on, err := d.LaunchAtLogin(); err != nil || on {
		t.Fatalf("initially: %v %v", on, err)
	}
	if err := d.SetLaunchAtLogin(true); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(launchAgentPath())
	if err != nil {
		t.Fatal(err)
	}
	plist := string(raw)
	for _, want := range []string{"<string>dev.bitop.pi-local</string>", "<string>-hidden</string>", "<string>/tmp/Pi Local &amp; data</string>", "<key>RunAtLoad</key><true/>"} {
		if !strings.Contains(plist, want) {
			t.Fatalf("the LaunchAgent lacks %q:\n%s", want, plist)
		}
	}
	// A valid property list, as launchd reads it. Only lint the synthetic file.
	if out, err := exec.Command("plutil", "-lint", launchAgentPath()).CombinedOutput(); err != nil {
		t.Fatalf("plutil: %v %s", err, out)
	}
	if on, _ := d.LaunchAtLogin(); !on {
		t.Fatal("should be on")
	}
	if err := d.SetLaunchAtLogin(false); err != nil {
		t.Fatal(err)
	}
	if on, _ := d.LaunchAtLogin(); on {
		t.Fatal("should be off")
	}
	if err := d.SetLaunchAtLogin(false); err != nil {
		t.Fatalf("turning it off twice: %v", err)
	}
}

func TestStartupCapabilitiesDoNotProbeHome(t *testing.T) {
	// Even an unusable HOME cannot prevent the static capability from being read.
	t.Setenv("HOME", "")
	if !(desktop{}).Capabilities()[api.DesktopLaunchAtLogin].Available {
		t.Fatal("macOS startup support must not depend on HOME")
	}
}
