//go:build !darwin

package update

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

type panicTransport struct{}

func (panicTransport) RoundTrip(*http.Request) (*http.Response, error) {
	panic("unsupported installer attempted HTTP")
}

type panicContext struct{}

func (panicContext) Deadline() (time.Time, bool) { panic("installer inspected context") }
func (panicContext) Done() <-chan struct{}       { panic("installer inspected context") }
func (panicContext) Err() error                  { panic("installer inspected context") }
func (panicContext) Value(any) any               { panic("installer inspected context") }

func refusingUpdater(bundle string) *Updater {
	u := New("0.1.0", bundle)
	u.Client = &http.Client{Transport: panicTransport{}}
	u.Relaunch = func(string) { panic("unsupported installer relaunched") }
	u.BeforeInstall = func(context.Context) error { panic("unsupported installer made a backup") }
	u.OnChange = func(Status) { panic("unsupported installer published status") }
	u.LoadAutoCheck = func() bool { panic("unsupported installer read settings via Status") }
	u.SaveAutoCheck = func(bool) error { panic("unsupported installer wrote settings") }
	u.latest = &Release{
		Version: "0.2.0", Notes: "private release metadata",
		asset:     asset{"Pi-Local-0.2.0-macos-arm64.zip", "https://example.invalid/private-archive", 1},
		signature: asset{"Pi-Local-0.2.0-macos-arm64.zip.sig", "https://example.invalid/private-signature", 1},
	}
	u.checkedAt = time.Unix(123, 0)
	u.lastErr, u.stage = "previous error", "previous stage"
	return u
}

type fileState struct {
	Mode    fs.FileMode
	ModTime time.Time
	Data    string
}

func treeState(t *testing.T, root string) map[string]fileState {
	t.Helper()
	out := map[string]fileState{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		state := fileState{Mode: info.Mode(), ModTime: info.ModTime()}
		if !entry.IsDir() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			state.Data = string(data)
		}
		out[path] = state
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func unsupportedFixture(t *testing.T) (root, bundle string) {
	t.Helper()
	root = t.TempDir()
	bundle = filepath.Join(root, "private-installed.app")
	if err := os.Mkdir(bundle, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"old-app", "update.zip", "update.zip.sig", "backup"} {
		if err := os.WriteFile(filepath.Join(bundle, name), []byte("unchanged "+name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, key := range []string{"HOME", "TMPDIR", "TMP", "TEMP"} {
		t.Setenv(key, root)
	}
	// A probe that creates and then removes a file still changes this timestamp.
	old := time.Unix(946684800, 0)
	for _, dir := range []string{root, bundle} {
		if err := os.Chtimes(dir, old, old); err != nil {
			t.Fatal(err)
		}
	}
	return root, bundle
}

func assertUnsupported(t *testing.T, err error) {
	t.Helper()
	var unavailable *UnavailableError
	if !errors.Is(err, ErrUnsupported) || !errors.As(err, &unavailable) {
		t.Fatalf("expected typed unsupported installation error, got %v", err)
	}
	capability := InstallationCapability()
	if unavailable.Platform != runtime.GOOS || unavailable.Reason != capability.Reason {
		t.Fatalf("wrong build information: %+v", unavailable)
	}
	want := "update installation on " + runtime.GOOS + ": " + capability.Reason + ": " + ErrUnsupported.Error()
	if err.Error() != want {
		t.Fatalf("error must contain only build information: %q", err)
	}
}

func TestUnsupportedInstallationCapabilityAndBundleLookup(t *testing.T) {
	root, bundle := unsupportedFixture(t)
	before := treeState(t, root)
	capability := InstallationCapability()
	if capability.Available || !strings.Contains(capability.Reason, "only implemented for macOS") {
		t.Fatalf("unsupported build advertised installation: %+v", capability)
	}
	capability.Available, capability.Reason = true, "forged"
	if got := InstallationCapability(); got.Available || got.Reason == "forged" {
		t.Fatalf("caller changed build capability: %+v", got)
	}
	for _, exe := range []string{"", filepath.Join(bundle, "Contents", "MacOS", "pi-local"), "bad\x00path", `\\server\private\Pi Local.app\Contents\MacOS\pi-local`} {
		if got := BundleOf(exe); got != "" {
			t.Fatalf("unsupported BundleOf(%q) = %q", exe, got)
		}
	}
	if got := CurrentBundle(); got != "" {
		t.Fatalf("unsupported CurrentBundle = %q", got)
	}
	_ = New("private-version", bundle)
	if after := treeState(t, root); !reflect.DeepEqual(before, after) {
		t.Fatalf("capability, bundle lookup or construction changed files: before=%+v after=%+v", before, after)
	}
}

func TestUnsupportedStatusCannotBeForgedAndDoesNotProbe(t *testing.T) {
	root, bundle := unsupportedFixture(t)
	before := treeState(t, root)
	for _, b := range []string{"", bundle, filepath.Join(root, "missing", "Pi Local.app"), "bad\x00path"} {
		u := refusingUpdater(b)
		loads := 0
		u.LoadAutoCheck = func() bool { loads++; return false }
		st := u.Status()
		if st.CanInstall || st.InstallBlocked == nil || *st.InstallBlocked != InstallationCapability().Reason {
			t.Fatalf("forged bundle/relaunch enabled installation: %+v", st)
		}
		if loads != 1 || st.AutoCheck || !st.Available || st.Latest != u.latest || st.Current != u.Current || st.CheckedAt == nil || *st.CheckedAt != u.checkedAt.UnixMilli() || st.Error == nil || *st.Error != u.lastErr || st.Stage == nil || *st.Stage != u.stage {
			t.Fatalf("read-only status lost existing fields or settings: %+v, loads=%d", st, loads)
		}
	}
	if after := treeState(t, root); !reflect.DeepEqual(before, after) {
		t.Fatalf("unsupported Status created a write probe or changed files: before=%+v after=%+v", before, after)
	}
}

func TestUnsupportedInstallRefusesBeforeStatusAndAllIO(t *testing.T) {
	root, bundle := unsupportedFixture(t)
	before := treeState(t, root)
	for _, stage := range []string{"", "downloading", "failed"} {
		u := refusingUpdater(bundle)
		u.stage = stage
		latest, checkedAt, lastErr := u.latest, u.checkedAt, u.lastErr
		assertUnsupported(t, u.Install(panicContext{}))
		assertUnsupported(t, u.install(panicContext{}, u.latest))
		assertUnsupported(t, u.install(panicContext{}, nil))
		if u.stage != stage || u.lastErr != lastErr || u.latest != latest || !u.checkedAt.Equal(checkedAt) {
			t.Fatalf("refused installation mutated state: %+v", u)
		}
	}
	// Refusal is a build boundary, even before receiver/release/context access.
	var absent *Updater
	assertUnsupported(t, absent.Install(panicContext{}))
	assertUnsupported(t, absent.install(panicContext{}, nil))
	if after := treeState(t, root); !reflect.DeepEqual(before, after) {
		t.Fatalf("refused installation changed files: before=%+v after=%+v", before, after)
	}
}

func TestUnsupportedAdaptersRefuseWithoutInspectingInputs(t *testing.T) {
	root, bundle := unsupportedFixture(t)
	before := treeState(t, root)
	for _, path := range []string{"", bundle, filepath.Join(bundle, "update.zip"), "bad\x00private-path"} {
		got, err := unpack(panicContext{}, path, path, "private-version")
		assertUnsupported(t, err)
		if got != "" {
			t.Fatalf("unsupported unpack returned a path: %q", got)
		}
		assertUnsupported(t, swap(path, path))
	}
	if after := treeState(t, root); !reflect.DeepEqual(before, after) {
		t.Fatalf("unsupported adapters changed files: before=%+v after=%+v", before, after)
	}
}
