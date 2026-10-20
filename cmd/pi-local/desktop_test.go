package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestLaunchAtLogin(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // never the real ~/Library/LaunchAgents
	d := desktop{dataDir: "/tmp/Pi Local & data"}
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
	// A valid property list, as launchd reads it.
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

func TestAppleStrings(t *testing.T) {
	cases := map[string]string{
		`plain`:            `"plain"`,
		`say "hi" \ there`: `"say \"hi\" \\ there"`,
		"two\nlines":       `"two lines"`,
	}
	for in, want := range cases {
		if got := appleString(in); got != want {
			t.Errorf("appleString(%q) = %s, want %s", in, got, want)
		}
	}
	if got := appleString(strings.Repeat("x", 500)); len([]rune(got)) > 245 {
		t.Errorf("a long string isn't shortened: %d", len(got))
	}
}

func TestPlural(t *testing.T) {
	if plural(0, "agent working", "agents working", "Nothing working") != "Nothing working" ||
		plural(1, "agent working", "agents working", "") != "1 agent working" ||
		plural(3, "agent working", "agents working", "") != "3 agents working" {
		t.Fatal("plural")
	}
}
