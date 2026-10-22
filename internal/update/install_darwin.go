package update

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const installationAvailable = true

// CurrentBundle finds the running executable's macOS app bundle, or "" outside one.
func CurrentBundle() string {
	exe, _ := os.Executable()
	return BundleOf(exe)
}

// BundleID is the app's bundle identifier; an update must have the same.
const BundleID = "dev.bitop.pi-local"

// BundleOf is the app bundle an executable is in (…/Pi Local.app), or "" when it isn't in one.
func BundleOf(exe string) string {
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	macos := filepath.Dir(exe)
	contents := filepath.Dir(macos)
	bundle := filepath.Dir(contents)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" || !strings.HasSuffix(bundle, ".app") {
		return ""
	}
	return bundle
}

func plistValue(bundle, key string) string {
	out, err := exec.Command("/usr/libexec/PlistBuddy", "-c", "Print :"+key, filepath.Join(bundle, "Contents", "Info.plist")).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// unpack extracts an archive (ditto keeps the bundle's signature and attributes) and checks what it holds: one app,
// with Pi Local's bundle ID, of the version the release says, with an intact signature.
func unpack(ctx context.Context, archive, dir, version string) (string, error) {
	out := filepath.Join(dir, "unpacked")
	if b, err := exec.CommandContext(ctx, "/usr/bin/ditto", "-x", "-k", archive, out).CombinedOutput(); err != nil {
		return "", fmt.Errorf("unpacking the update: %v %s", err, b)
	}
	apps, _ := filepath.Glob(filepath.Join(out, "*.app"))
	if len(apps) != 1 {
		return "", fmt.Errorf("the update should hold one app, it holds %d", len(apps))
	}
	app := apps[0]
	if id := plistValue(app, "CFBundleIdentifier"); id != BundleID {
		return "", fmt.Errorf("the update isn't Pi Local (bundle %q)", id)
	}
	if v := plistValue(app, "CFBundleVersion"); v != version {
		return "", fmt.Errorf("the update says it is %q, the release %q", v, version)
	}
	if b, err := exec.CommandContext(ctx, "/usr/bin/codesign", "--verify", "--deep", "--strict", app).CombinedOutput(); err != nil {
		return "", fmt.Errorf("the update's code signature is broken: %s", strings.TrimSpace(string(b)))
	}
	return app, nil
}

// swap puts the new app where the old one is; the old one goes to the Trash (so it can be got back).
func swap(bundle, staged string) error {
	old := bundle + ".old-" + time.Now().Format("20060102150405")
	if err := os.Rename(bundle, old); err != nil {
		return fmt.Errorf("moving the current app aside: %w", err)
	}
	if err := os.Rename(staged, bundle); err != nil {
		os.Rename(old, bundle) // put it back
		return fmt.Errorf("putting the update in place: %w", err)
	}
	home, _ := os.UserHomeDir()
	trash := filepath.Join(home, ".Trash", filepath.Base(bundle)+" "+time.Now().Format("2006-01-02 15.04.05"))
	if err := os.Rename(old, trash); err != nil {
		os.RemoveAll(old)
	}
	return nil
}
