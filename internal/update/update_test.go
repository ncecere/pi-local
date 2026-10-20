package update

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.2.0", "0.1.0", true},
		{"0.1.0", "0.1.0", false},
		{"0.1.10", "0.1.9", true},
		{"1.0.0", "1.0.0-rc.1", true},
		{"1.0.0-rc.2", "1.0.0-rc.1", true},
		{"0.1.0", "0.1.0-dev", true},
		{"0.1.0", "6dc49f2-dirty", true}, // a development build is older than any release
		{"junk", "0.1.0", false},
		{"v0.3.0", "0.2.9", true},
	}
	for _, c := range cases {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

func TestSignatures(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	path := filepath.Join(dir, "Pi-Local-0.2.0-macos-arm64.zip")
	os.WriteFile(path, []byte("archive bytes"), 0o600)
	sig, err := Sign(priv, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(pub, path, sig); err != nil {
		t.Fatalf("a good signature: %v", err)
	}
	// Changed bytes, another name, another key, garbage: all refused.
	os.WriteFile(path, []byte("archive bytes!"), 0o600)
	if err := Verify(pub, path, sig); err == nil {
		t.Fatal("a changed archive passed")
	}
	os.WriteFile(path, []byte("archive bytes"), 0o600)
	if err := VerifyNamed(pub, path, "Pi-Local-0.3.0-macos-arm64.zip", sig); err == nil {
		t.Fatal("a signature moved to another name passed")
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	if err := Verify(other, path, sig); err == nil {
		t.Fatal("another key passed")
	}
	if err := Verify(pub, path, "not base64!"); err == nil {
		t.Fatal("garbage passed")
	}
	// The key built into the app is a real key.
	if len(PublicKey) != ed25519.PublicKeySize {
		t.Fatal("the release public key")
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

// fakeGitHub serves a latest release with an archive and its signature.
func fakeGitHub(t *testing.T, version string, files map[string]string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/ncecere/pi-local/releases/latest" {
			var assets []map[string]any
			for name := range files {
				assets = append(assets, map[string]any{"name": name, "browser_download_url": srv.URL + "/dl/" + name, "size": 1})
			}
			json.NewEncoder(w).Encode(map[string]any{"tag_name": "v" + version, "body": "Notes for " + version, "html_url": "https://example.com/r", "published_at": time.Now(), "assets": assets})
			return
		}
		if name, found := strings.CutPrefix(r.URL.Path, "/dl/"); found {
			if path, ok := files[name]; ok {
				http.ServeFile(w, r, path)
				return
			}
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
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

func TestNoReleasesYet(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	u := New("0.1.0", "")
	u.APIBase = srv.URL
	st := u.Check(context.Background())
	if st.Available || st.Error == nil || !strings.Contains(*st.Error, "no releases") || st.CanInstall {
		t.Fatalf("%+v", st)
	}
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
