package host

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

type invocation struct {
	name string
	args []string
}
type fakeRunner struct {
	calls []invocation
	err   error
}

func (r *fakeRunner) Run(ctx context.Context, name string, args ...string) error {
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > helperTimeout {
		panic("opener command must have a bounded context")
	}
	r.calls = append(r.calls, invocation{name, append([]string(nil), args...)})
	return r.err
}

func TestConstructionAndCapabilitiesAreSideEffectFree(t *testing.T) {
	_ = New() // Must not probe commands, the desktop, or the filesystem.
	for _, platform := range []string{"darwin", "linux", "windows", "freebsd", ""} {
		r := &fakeRunner{}
		h := NewWithRunner(platform, r)
		for _, capability := range []Capability{OpenURL, OpenPath, RevealFile, "notifications", "login-startup", "restart", "unknown"} {
			a := h.Capability(capability)
			want := (platform == "darwin" || platform == "linux") &&
				(capability == OpenURL || capability == OpenPath || capability == RevealFile)
			if a.Available != want || a.Reason == "" {
				t.Fatalf("%s %s: %+v", platform, capability, a)
			}
		}
		if len(r.calls) != 0 {
			t.Fatal("construction/capabilities ran a helper")
		}
	}
}

func TestAdapterArgv(t *testing.T) {
	for _, platform := range []string{"darwin", "linux"} {
		t.Run(platform, func(t *testing.T) {
			// On Windows these POSIX adapter path tests still use the native host's
			// absolute path representation. Native target lanes exercise actual paths.
			for _, path := range []string{filepath.Join(t.TempDir(), "résumé 空 白.txt"), "-leading dash.txt", "https:local notes", "$(touch not-a-command);'\".txt"} {
				absolute, err := filepath.Abs(path)
				if err != nil {
					t.Fatal(err)
				}
				for _, reveal := range []bool{false, true} {
					r := &fakeRunner{}
					h := NewWithRunner(platform, r)
					if reveal {
						err = h.RevealFile(path)
					} else {
						err = h.OpenPath(path)
					}
					if err != nil {
						t.Fatal(err)
					}
					want := invocation{"/usr/bin/open", []string{"--", absolute}}
					if platform == "darwin" && reveal {
						want.args = []string{"-R", "--", absolute}
					}
					if platform == "linux" {
						target := absolute
						if reveal {
							target = filepath.Dir(absolute)
						}
						want = invocation{"xdg-open", []string{target}}
					}
					if !reflect.DeepEqual(r.calls, []invocation{want}) {
						t.Fatalf("got %+v, want %+v", r.calls, want)
					}
				}
			}
			for _, raw := range []string{"https://example.test/sign-in?q=空%20白&state=a%26b", "http://127.0.0.1:5342/callback", "https://example.test/-x?y=$(not-shell)"} {
				r := &fakeRunner{}
				h := NewWithRunner(platform, r)
				if err := h.OpenURL(raw); err != nil {
					t.Fatal(err)
				}
				want := invocation{"/usr/bin/open", []string{"--", raw}}
				if platform == "linux" {
					want = invocation{"xdg-open", []string{raw}}
				}
				if !reflect.DeepEqual(r.calls, []invocation{want}) {
					t.Fatalf("got %+v, want %+v", r.calls, want)
				}
			}
		})
	}
}

func TestURLValidationBeforeCommand(t *testing.T) {
	invalid := []string{"", "https:", "https:///missing-host", "http://:80/", "http://host:bad/", "https://example.test/%zz", "https://example.test/\x00", "https://example.test/\r\n", "https://example.test/%00", "https://example.test/?x=%0d%0a", "https://example.test/\u0085", "javascript:alert(1)", "file:///tmp/file", "mailto:person@example.test", "ftp://example.test/", "wails://local/", "/tmp/file", "-a", "//example.test/", "https://example.test/" + strings.Repeat("x", 8192)}
	for _, platform := range []string{"darwin", "linux"} {
		for _, raw := range invalid {
			r := &fakeRunner{}
			if err := NewWithRunner(platform, r).OpenURL(raw); err == nil || len(r.calls) != 0 {
				t.Errorf("%s accepted %q or ran helper: %v %+v", platform, raw, err, r.calls)
			}
		}
	}
}

func TestLocalPathValidationAndProtocolSeparation(t *testing.T) {
	for _, platform := range []string{"darwin", "linux"} {
		for _, path := range []string{"", "bad\x00path"} {
			r := &fakeRunner{}
			h := NewWithRunner(platform, r)
			if h.OpenPath(path) == nil || h.RevealFile(path) == nil || len(r.calls) != 0 {
				t.Fatal("invalid path reached helper")
			}
		}
		// Explicit OpenPath never turns a filename containing a colon into an URL.
		r := &fakeRunner{}
		if err := NewWithRunner(platform, r).OpenPath("https://example.test/local"); err != nil {
			t.Fatal(err)
		}
		if len(r.calls) != 1 || !filepath.IsAbs(r.calls[0].args[len(r.calls[0].args)-1]) {
			t.Fatal("path was not local and absolute")
		}
	}
}

func TestUnsupportedBeforeCommand(t *testing.T) {
	for _, platform := range []string{"windows", "freebsd", "", "plan9"} {
		r := &fakeRunner{}
		h := NewWithRunner(platform, r)
		for operation, run := range map[Capability]func(string) error{OpenURL: h.OpenURL, OpenPath: h.OpenPath, RevealFile: h.RevealFile} {
			for _, input := range []string{"", "https://example.test/", "-bad\x00"} {
				err := run(input)
				var unavailable *UnavailableError
				if !errors.Is(err, ErrUnsupported) || !errors.As(err, &unavailable) || unavailable.Platform != platform || unavailable.Operation != operation || unavailable.Reason == "" {
					t.Fatalf("wrong unavailable error: %v", err)
				}
			}
		}
		if len(r.calls) != 0 {
			t.Fatal("unsupported platform executed command")
		}
	}
}

func TestHelperFailureIsNotSuccess(t *testing.T) {
	want := errors.New("fake utility unavailable")
	r := &fakeRunner{err: want}
	h := NewWithRunner("darwin", r)
	for _, run := range []func() error{func() error { return h.OpenURL("https://example.test/") }, func() error { return h.OpenPath("notes") }, func() error { return h.RevealFile("notes") }} {
		if err := run(); !errors.Is(err, want) {
			t.Fatalf("lost helper error: %v", err)
		}
	}
}

func TestDefaultAdapterMatchesRuntimeOnly(t *testing.T) {
	h := New()
	if h.platform != runtime.GOOS {
		t.Fatal("default host did not select runtime OS")
	}
}
