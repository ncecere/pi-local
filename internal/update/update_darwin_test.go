//go:build darwin

package update

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDarwinInstallationCapabilityAndHeadlessStatus(t *testing.T) {
	capability := InstallationCapability()
	if !capability.Available || capability.Reason == "" {
		t.Fatalf("missing existing macOS installer: %+v", capability)
	}
	capability.Available = false
	if !InstallationCapability().Available {
		t.Fatal("caller changed build capability")
	}
	for _, u := range []*Updater{New("0.1.0", ""), New("0.1.0", filepath.Join(t.TempDir(), "missing", "Pi Local.app"))} {
		if st := u.Status(); st.CanInstall || st.InstallBlocked != nil {
			t.Fatalf("headless macOS status changed: %+v", st)
		}
	}
	u := New("0.1.0", "")
	u.Relaunch = func(string) { panic("headless relaunch") }
	if st := u.Status(); st.CanInstall || st.InstallBlocked != nil {
		t.Fatalf("unbundled macOS status changed: %+v", st)
	}
	exe, _ := os.Executable()
	if got, want := CurrentBundle(), BundleOf(exe); got != want {
		t.Fatalf("current bundle = %q, want %q", got, want)
	}
}

// fakeApp builds an ad-hoc signed "Pi Local.app" of a version, zipped with ditto, in dir.
func fakeApp(t *testing.T, dir, version, bundleID string) string {
	t.Helper()
	app := filepath.Join(dir, "build", "Pi Local.app")
	os.MkdirAll(filepath.Join(app, "Contents", "MacOS"), 0o755)
	os.WriteFile(filepath.Join(app, "Contents", "MacOS", "pi-local"), []byte("#!/bin/sh\necho "+version+"\n"), 0o755)
	plist := `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>` + bundleID + `</string><key>CFBundleExecutable</key><string>pi-local</string>
<key>CFBundleVersion</key><string>` + version + `</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`
	os.WriteFile(filepath.Join(app, "Contents", "Info.plist"), []byte(plist), 0o644)
	if out, err := exec.Command("codesign", "--force", "-s", "-", app).CombinedOutput(); err != nil {
		t.Fatalf("codesign: %v %s", err, out)
	}
	zip := filepath.Join(dir, "Pi-Local-"+version+"-macos-arm64.zip")
	if out, err := exec.Command("ditto", "-c", "-k", "--keepParent", app, zip).CombinedOutput(); err != nil {
		t.Fatalf("ditto: %v %s", err, out)
	}
	os.RemoveAll(filepath.Join(dir, "build"))
	return zip
}

func installed(t *testing.T, bundle string) string {
	t.Helper()
	return plistValue(bundle, "CFBundleVersion")
}

func TestCheckDownloadVerifyAndInstall(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // the old app goes to this Trash
	os.MkdirAll(filepath.Join(os.Getenv("HOME"), ".Trash"), 0o755)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	work := t.TempDir()
	// The installed app (0.1.0), in a folder of its own.
	apps := filepath.Join(t.TempDir(), "Applications")
	os.MkdirAll(apps, 0o755)
	oldZip := fakeApp(t, work, "0.1.0", BundleID)
	exec.Command("ditto", "-x", "-k", oldZip, apps).Run()
	bundle := filepath.Join(apps, "Pi Local.app")
	if installed(t, bundle) != "0.1.0" {
		t.Fatal("setup")
	}
	// The release (0.2.0), signed.
	zip := fakeApp(t, work, "0.2.0", BundleID)
	sig, _ := Sign(priv, zip)
	os.WriteFile(zip+".sig", []byte(sig), 0o644)
	gh := fakeGitHub(t, "0.2.0", map[string]string{filepath.Base(zip): zip, filepath.Base(zip) + ".sig": zip + ".sig"})

	u := New("0.1.0", bundle)
	u.Key, u.APIBase = pub, gh.URL
	relaunched := make(chan string, 1)
	u.Relaunch = func(b string) { relaunched <- b }
	st := u.Check(context.Background())
	if !st.Available || st.Latest.Version != "0.2.0" || st.Latest.Notes != "Notes for 0.2.0" || !st.CanInstall {
		t.Fatalf("check: %+v", st)
	}
	if err := u.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case b := <-relaunched:
		if b != bundle {
			t.Fatalf("relaunched %s", b)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("no relaunch; status %+v", u.Status())
	}
	if v := installed(t, bundle); v != "0.2.0" {
		t.Fatalf("after installing: %s", v)
	}
	trashed, _ := filepath.Glob(filepath.Join(os.Getenv("HOME"), ".Trash", "Pi Local.app *"))
	if len(trashed) != 1 {
		t.Fatalf("the old app should be in the Trash: %v", trashed)
	}
	if leftovers, _ := filepath.Glob(filepath.Join(apps, ".pi-local-update-*")); len(leftovers) != 0 {
		t.Fatalf("staging left behind: %v", leftovers)
	}
}

func TestATamperedUpdateIsRefused(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	work := t.TempDir()
	apps := t.TempDir()
	exec.Command("ditto", "-x", "-k", fakeApp(t, work, "0.1.0", BundleID), apps).Run()
	bundle := filepath.Join(apps, "Pi Local.app")

	try := func(version, bundleID string, sign func(zip string) string) string {
		dir := t.TempDir()
		zip := fakeApp(t, dir, version, bundleID)
		os.WriteFile(zip+".sig", []byte(sign(zip)), 0o644)
		gh := fakeGitHub(t, "0.2.0", map[string]string{"Pi-Local-0.2.0-macos-arm64.zip": zip, "Pi-Local-0.2.0-macos-arm64.zip.sig": zip + ".sig"})
		u := New("0.1.0", bundle)
		u.Key, u.APIBase = pub, gh.URL
		u.Relaunch = func(string) { t.Error("relaunched after a refused update") }
		u.Check(context.Background())
		if err := u.Install(context.Background()); err != nil {
			return err.Error()
		}
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			if st := u.Status(); st.Stage != nil && *st.Stage == "failed" {
				return *st.Error
			}
			time.Sleep(50 * time.Millisecond)
		}
		return "no failure"
	}
	_, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	signAs := func(name string, key ed25519.PrivateKey) func(string) string {
		return func(zip string) string {
			renamed := filepath.Join(filepath.Dir(zip), name)
			os.Rename(zip, renamed)
			s, _ := Sign(key, renamed)
			os.Rename(renamed, zip)
			return s
		}
	}
	cases := map[string]string{
		"another key":   try("0.2.0", BundleID, signAs("Pi-Local-0.2.0-macos-arm64.zip", otherKey)),
		"another app":   try("0.2.0", "com.evil.app", signAs("Pi-Local-0.2.0-macos-arm64.zip", priv)),
		"wrong version": try("0.1.5", BundleID, signAs("Pi-Local-0.2.0-macos-arm64.zip", priv)),
	}
	wants := map[string]string{"another key": "signature", "another app": "isn't Pi Local", "wrong version": "says it is"}
	for name, got := range cases {
		if !strings.Contains(got, wants[name]) {
			t.Errorf("%s: %q", name, got)
		}
	}
	if v := installed(t, bundle); v != "0.1.0" {
		t.Fatalf("a refused update changed the app: %s", v)
	}
	_ = fmt.Sprint
}

func TestBundleOf(t *testing.T) {
	if got := BundleOf("/Applications/Pi Local.app/Contents/MacOS/pi-local"); got != "/Applications/Pi Local.app" {
		t.Fatal(got)
	}
	if got := BundleOf("/Users/me/bin/pi-local"); got != "" {
		t.Fatal(got)
	}
}

func TestAnAppThatCantBeReplacedWhereItIsSaysWhy(t *testing.T) {
	for _, b := range []string{"/Volumes/Pi Local/Pi Local.app", "/private/var/folders/x/AppTranslocation/ABC/d/Pi Local.app", "/System/Pi Local.app"} {
		u := New("0.1.0", b)
		u.Relaunch = func(string) {}
		u.LoadAutoCheck = func() bool { return true }
		if st := u.Status(); st.CanInstall || st.InstallBlocked == nil || !strings.Contains(*st.InstallBlocked, "Applications") {
			t.Errorf("%s: %+v", b, st)
		}
	}
	u := New("0.1.0", filepath.Join(t.TempDir(), "Pi Local.app"))
	u.Relaunch = func(string) {}
	if st := u.Status(); !st.CanInstall || st.InstallBlocked != nil {
		t.Fatalf("a writable folder: %+v", st)
	}
}

// An update makes a backup first, after the archive is verified and before anything is replaced; a backup that fails
// stops the update and leaves the app as it was.
func TestABackupIsMadeBeforeAnUpdateInstalls(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	os.MkdirAll(filepath.Join(os.Getenv("HOME"), ".Trash"), 0o755)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	work := t.TempDir()
	apps := filepath.Join(t.TempDir(), "Applications")
	os.MkdirAll(apps, 0o755)
	exec.Command("ditto", "-x", "-k", fakeApp(t, work, "0.1.0", BundleID), apps).Run()
	bundle := filepath.Join(apps, "Pi Local.app")
	zip := fakeApp(t, work, "0.2.0", BundleID)
	sig, _ := Sign(priv, zip)
	os.WriteFile(zip+".sig", []byte(sig), 0o644)
	gh := fakeGitHub(t, "0.2.0", map[string]string{filepath.Base(zip): zip, filepath.Base(zip) + ".sig": zip + ".sig"})

	newUpdater := func(hook func(context.Context) error) (*Updater, chan string) {
		u := New("0.1.0", bundle)
		u.Key, u.APIBase = pub, gh.URL
		relaunched := make(chan string, 1)
		u.Relaunch = func(b string) { relaunched <- b }
		u.BeforeInstall = hook
		u.Check(context.Background())
		return u, relaunched
	}

	// The backup fails: the update stops with a message, and the installed app is untouched.
	u, relaunched := newUpdater(func(context.Context) error { return fmt.Errorf("the disk is full") })
	if err := u.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if st := u.Status(); st.Stage != nil && *st.Stage == "failed" {
			if st.Error == nil || !strings.Contains(*st.Error, "backup before it failed") || !strings.Contains(*st.Error, "the disk is full") {
				t.Fatalf("the failure: %+v", st.Error)
			}
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if st := u.Status(); st.Stage == nil || *st.Stage != "failed" {
		t.Fatalf("the update should have failed: %+v", st)
	}
	select {
	case <-relaunched:
		t.Fatal("relaunched after a failed backup")
	default:
	}
	if v := installed(t, bundle); v != "0.1.0" {
		t.Fatalf("a failed backup changed the app: %s", v)
	}

	// The backup succeeds: it ran while the old app was still in place, then the update installed.
	var during string
	var stageDuring string
	u, relaunched = newUpdater(nil)
	u.BeforeInstall = func(context.Context) error {
		during = installed(t, bundle)
		if st := u.Status(); st.Stage != nil {
			stageDuring = *st.Stage
		}
		return nil
	}
	if err := u.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-relaunched:
	case <-time.After(30 * time.Second):
		t.Fatalf("no relaunch; status %+v", u.Status())
	}
	if during != "0.1.0" || stageDuring != "backing-up" {
		t.Fatalf("the backup ran with app %q at stage %q", during, stageDuring)
	}
	if v := installed(t, bundle); v != "0.2.0" {
		t.Fatalf("after installing: %s", v)
	}
}
