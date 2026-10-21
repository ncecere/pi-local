package runtimeenv

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestMergePathsForOS(t *testing.T) {
	for _, tt := range []struct{ name, goos, a, b, want string }{
		{"darwin precedence", "darwin", "/opt/node/bin:/usr/bin", "/usr/bin:/bin", "/opt/node/bin:/usr/bin:/bin"},
		{"unix excludes workspace", "linux", ":.:bin:../tools:/usr/bin:", "/bin", "/usr/bin:/bin"},
		{"unix case matters", "darwin", "/Node:/node", "", "/Node:/node"},
		{"unix spelling preserved", "darwin", "/link/../bin:/bin:/bin/", "", "/link/../bin:/bin:/bin/"},
		{"windows casing separators", "windows", `C:\Node;D:\Other`, `c:/node;C:\NODE\;D:\other;E:\工具 space`, `C:\Node;D:\Other;E:\工具 space`},
		{"windows cwd excluded", "windows", `;.;bin;C:bin;\tools;C:\safe;;`, "", `C:\safe`},
		{"windows UNC", "windows", `\\server\share\node;\\SERVER\SHARE\NODE;\\?\C:\bad;\\.\bad;\\server`, "", `\\server\share\node`},
		{"windows quoted semicolon", "windows", `"C:\Program Files\node;tools";C:\Windows`, `"c:\program files\NODE;tools"`, `"C:\Program Files\node;tools";C:\Windows`},
		{"empty", "windows", "", "", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := mergePathsForOS(tt.goos, tt.a, tt.b); got != tt.want {
				t.Fatalf("got %q want %q", got, tt.want)
			}
		})
	}
}

func TestNodeCandidates(t *testing.T) {
	for _, tt := range []struct {
		goos, explicit, bundled, path string
		want                          []string
	}{
		{"darwin", "./deliberate node", "/app/node", ":.:relative:/opt/工具 space:/usr/bin", []string{"./deliberate node", "/app/node", "/opt/工具 space/node", "/usr/bin/node"}},
		{"windows", `C:\explicit\node.exe`, `C:\app\node.exe`, `.;C:bin;\bin;C:\Node;c:/NODE;"D:\工具 space"`, []string{`C:\explicit\node.exe`, `C:\app\node.exe`, `C:\Node\node.exe`, `D:\工具 space\node.exe`}},
		{"windows", "", "", `C:\`, []string{`C:\node.exe`}},
	} {
		if got := nodeCandidates(tt.goos, tt.explicit, tt.bundled, tt.path); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("%s: got %q want %q", tt.goos, got, tt.want)
		}
	}
}

func TestNodeExecutableName(t *testing.T) {
	for _, tt := range []struct {
		goos, file string
		want       bool
	}{
		{"windows", `C:\Node\node.exe`, true}, {"windows", `C:\Node\NODE.EXE`, true},
		{"windows", `C:\Node\node`, false}, {"windows", `C:\Node\node.cmd`, false},
		{"windows", `C:\Node\node.exe.bat`, false}, {"windows", `C:\dir.exe\node`, false},
		{"darwin", "/explicit/node", true}, {"linux", "/explicit/custom-name", true},
	} {
		if got := nodeExecutableName(tt.goos, tt.file); got != tt.want {
			t.Errorf("%s %q: got %v want %v", tt.goos, tt.file, got, tt.want)
		}
	}
}

func TestNodeFileMode(t *testing.T) {
	for _, tt := range []struct {
		goos string
		mode os.FileMode
		want bool
	}{
		{"windows", 0o600, true}, {"windows", os.ModeDir | 0o755, false},
		{"linux", 0o644, false}, {"darwin", 0o700, true},
		{"linux", os.ModeNamedPipe | 0o755, false},
	} {
		if got := nodeFileMode(tt.goos, tt.mode); got != tt.want {
			t.Errorf("%s %v: got %v", tt.goos, tt.mode, got)
		}
	}
}

func TestStableNodeMinimum(t *testing.T) {
	for _, tt := range []struct {
		version string
		want    bool
	}{
		{"v22.19.0", true}, {"22.19.1", true}, {"v22.20.0", true},
		{"v23.0.0", true}, {"v24.1.2+build.4", true}, {"v22.18.99", false},
		{"v21.99.0", false}, {"22.19", false}, {"v22.19.0-rc.1", false},
		{"v24.0.0-nightly", false}, {"v22.19.0junk", false}, {"Node v22.19.0", false},
		{"v022.19.0", false}, {"v22.-19.0", false}, {"v22.19.0\nwarning", false},
		{"v99999999999999999999999999.0.0", false}, {"v22.19.9999999999999999999999999", false},
	} {
		if got := atLeast(tt.version, MinNodeMajor, MinNodeMinor); got != tt.want {
			t.Errorf("%q: got %v want %v", tt.version, got, tt.want)
		}
	}
}

func TestLoginPathInjected(t *testing.T) {
	for _, tt := range []struct{ name, goos, shell, wantShell string }{
		{"darwin default", "darwin", "", "/bin/zsh"},
		{"darwin configured", "darwin", "/fake/zsh", "/fake/zsh"},
		{"linux default", "linux", "", "/bin/sh"},
		{"linux configured", "linux", "/fake/bash", "/fake/bash"},
		{"relative shell not PATH resolved", "linux", "bash", "/bin/sh"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			run := func(ctx context.Context, shell string, args ...string) ([]byte, error) {
				if shell != tt.wantShell || !reflect.DeepEqual(args, []string{"-l", "-c", `printf '__PI_PATH__%s' "$PATH"`}) {
					t.Fatalf("unexpected shell/args: %q %q", shell, args)
				}
				if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 5*time.Second {
					t.Fatal("missing login-shell timeout")
				}
				return []byte("profile banner\n__PI_PATH__/fake/工具 space:/usr/bin:.:relative"), nil
			}
			if got := loginPathForOS(context.Background(), tt.goos, "/usr/bin:/bin", tt.shell, run); got != "/fake/工具 space:/usr/bin:/bin" {
				t.Fatalf("got %q", got)
			}
		})
	}
	t.Run("windows never runs shell", func(t *testing.T) {
		got := loginPathForOS(context.Background(), "windows", `C:\Node;c:\node;.;`, "/bin/zsh", func(context.Context, string, ...string) ([]byte, error) {
			t.Fatal("Windows attempted Unix login shell")
			return nil, nil
		})
		if got != `C:\Node` {
			t.Fatalf("got %q", got)
		}
	})
	for _, out := range []string{"no marker", "__PI_PATH__", "__PI_PATH__ \n"} {
		got := loginPathForOS(context.Background(), "linux", "/bin:.", "", func(context.Context, string, ...string) ([]byte, error) { return []byte(out), nil })
		if got != "/bin" {
			t.Fatalf("fallback for %q: %q", out, got)
		}
	}
	got := loginPathForOS(context.Background(), "darwin", "/bin", "", func(context.Context, string, ...string) ([]byte, error) { return nil, errors.New("fake shell failure") })
	if got != "/bin" {
		t.Fatalf("error fallback %q", got)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := loginPathForOS(ctx, "linux", "/bin", "", func(context.Context, string, ...string) ([]byte, error) {
		t.Fatal("ran canceled command")
		return nil, nil
	}); got != "/bin" {
		t.Fatal(got)
	}
}

func TestNodeVersionRunner(t *testing.T) {
	for _, timeout := range []time.Duration{time.Millisecond, time.Second} {
		ctx, cancel := context.WithCancel(context.Background())
		if timeout == time.Second {
			cancel()
		}
		_, err := nodeVersionWithRunner(ctx, "/fake/node", timeout, func(ctx context.Context, node string, args ...string) ([]byte, error) {
			if node != "/fake/node" || !reflect.DeepEqual(args, []string{"--version"}) {
				t.Fatal("unexpected probe")
			}
			<-ctx.Done()
			return nil, ctx.Err()
		})
		cancel()
		want := context.DeadlineExceeded
		if timeout == time.Second {
			want = context.Canceled
		}
		if !errors.Is(err, want) {
			t.Fatalf("got %v want %v", err, want)
		}
	}
	got, err := nodeVersionWithRunner(context.Background(), "/fake/node", time.Second, func(context.Context, string, ...string) ([]byte, error) { return []byte(" v22.19.0\n"), nil })
	if err != nil || got != "v22.19.0" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestBaseEnvPure(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		t.Run(goos, func(t *testing.T) {
			// Synthetic values only: no read of the developer's environment.
			environ := []string{"PATH=/usr/bin:/bin", "HOME=/fake/home", "USER=fake", "LOGNAME=fake", "LANG=C", "LC_ALL=C", "TZ=UTC", "TMPDIR=/fake/tmp", "SHELL=/fake/sh", "SystemRoot=C:\\Windows", "USERPROFILE=C:\\Users\\fake", "TEMP=C:\\Temp", "TMP=C:\\Tmp", "COMSPEC=C:\\Windows\\System32\\cmd.exe", "NODE_OPTIONS=--import=evil", "NODE_PATH=/evil", "NODE_COMPILE_CACHE=/evil", "OPENAI_API_KEY=secret", "ANTHROPIC_API_KEY=secret", "AWS_SESSION_TOKEN=secret", "GITHUB_TOKEN=secret", "PI_LOCAL_NODE=/override"}
			if goos == "windows" {
				environ = append(environ, `Path=C:\old`, `pAtH=C:\Node;c:\node;.;relative`, `systemroot=C:\FinalWindows`)
			}
			lookup := environmentLookup(goos, environ)
			env := baseEnvForOS("fake-data", goos, lookup)
			if env["NODE_COMPILE_CACHE"] != filepath.Join("fake-data", "cache", "node") {
				t.Fatal("inherited compile-cache override")
			}
			wantCount := 10
			if goos == "windows" {
				wantCount = 15
				if env["PATH"] != `C:\Node` || env["SystemRoot"] != `C:\FinalWindows` {
					t.Fatal("case-insensitive duplicate resolution failed")
				}
				if v, ok := lookup("path"); !ok || !strings.HasPrefix(v, `C:\Node`) {
					t.Fatal("case-insensitive lookup failed")
				}
			} else if _, ok := lookup("path"); ok {
				t.Fatal("Unix lookup should be case-sensitive")
			}
			if len(env) != wantCount {
				t.Fatalf("allowlist count %d want %d", len(env), wantCount)
			}
			for k, v := range env {
				if v == "secret" || k == "NODE_OPTIONS" || k == "NODE_PATH" || k == "PI_LOCAL_NODE" || k == "Path" || k == "pAtH" {
					t.Fatalf("unexpected inherited key %q", k)
				}
			}
		})
	}
	if got := baseEnvForOS("data", "windows", environmentLookup("windows", nil)); len(got) != 1 {
		t.Fatal("missing variables should stay absent")
	}
}

func TestWriteBundleContract(t *testing.T) {
	dir := t.TempDir()
	script := []byte("// synthetic runtime, never executed\n")
	rt, err := WriteBundle(dir, script, "explicit-node")
	if err != nil {
		t.Fatal(err)
	}
	if rt.Node != "explicit-node" || rt.Dir != filepath.Dir(rt.Script) || !reflect.DeepEqual(rt.Args, []string{"--disable-warning=ExperimentalWarning"}) {
		t.Fatalf("runtime contract changed: %#v", rt)
	}
	got, err := os.ReadFile(rt.Script)
	if err != nil || string(got) != string(script) {
		t.Fatalf("bundle contents: %q %v", got, err)
	}
	again, err := WriteBundle(dir, script, rt.Node)
	if err != nil || !reflect.DeepEqual(again, rt) {
		t.Fatal("idempotent bundle changed")
	}
	if err := os.WriteFile(rt.Script, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteBundle(dir, script, rt.Node); err != nil {
		t.Fatal(err)
	}
	got, err = os.ReadFile(rt.Script)
	if err != nil || string(got) != string(script) {
		t.Fatal("bundle not repaired")
	}
	changed, err := WriteBundle(dir, append(script, 'x'), rt.Node)
	if err != nil || changed.Dir == rt.Dir {
		t.Fatal("changed bundle should get a new directory")
	}
}
