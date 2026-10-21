//go:build windows

package supervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/process"
)

func TestWindowsRuntimeHelper(t *testing.T) {
	if os.Getenv("PL_WIN_SUP_HELPER") != "1" {
		return
	}
	mode := os.Args[len(os.Args)-1]
	if mode == "burst" {
		for i := 0; i < 200; i++ {
			fmt.Println("fixture-progress " + strings.Repeat("x", 1024))
		}
		fmt.Println(strings.Repeat("z", 512<<10) + "FINAL_STDOUT_SURVIVED")
		os.Exit(2)
	}
	if mode == "early" {
		fmt.Println("fixture failed")
		os.Exit(7)
	}
	if mode != "unready" {
		fmt.Println(`PI_RUNTIME_READY {"port":9}`)
	}
	if mode == "eof" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		_ = os.WriteFile("runtime-eof-observed", nil, 0600)
		os.Exit(0)
	}
	for {
		time.Sleep(time.Hour)
	}
}
func windowsSupervisor(t *testing.T, mode string) (*Supervisor, string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	s := New(Options{
		Runtime: Runtime{Node: exe, Args: []string{"-test.run=^TestWindowsRuntimeHelper$", "--"}, Script: mode, Dir: dir},
		BaseEnv: map[string]string{"PL_WIN_SUP_HELPER": "1", "GORACE": "atexit_sleep_ms=0"},
		Resolve: func(context.Context, string) (Spec, error) {
			return Spec{AgentID: "fixture", LogDir: filepath.Join(dir, "logs"), Env: map[string]string{}}, nil
		},
		StartTimeout: 3 * time.Second, StopGrace: time.Second, ReapInterval: time.Hour,
	})
	t.Cleanup(s.Close)
	return s, dir
}
func assertWindowsNoKeys(t *testing.T, s *Supervisor) {
	t.Helper()
	s.keysMu.Lock()
	defer s.keysMu.Unlock()
	if len(s.keys) != 0 {
		t.Fatalf("gateway key leak: %d", len(s.keys))
	}
}
func TestWindowsSupervisorLaunchAndCleanup(t *testing.T) {
	for _, mode := range []string{"missing", "early", "unready", "cancelled", "eof", "hold"} {
		t.Run(mode, func(t *testing.T) {
			s, dir := windowsSupervisor(t, mode)
			if mode == "missing" {
				s.opts.Runtime.Node = filepath.Join(dir, "missing.exe")
			}
			if mode == "unready" {
				s.opts.StartTimeout = 200 * time.Millisecond
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			s.startProcess = func(ctx context.Context, cmd *exec.Cmd) (process.Tree, error) {
				s.keysMu.Lock()
				n := len(s.keys["fixture"])
				s.keysMu.Unlock()
				if n != 1 {
					t.Error("gateway key not registered before native Start")
				}
				return process.Start(ctx, cmd)
			}
			err := s.Wake(ctx, "fixture")
			if mode == "hold" || mode == "eof" {
				if err != nil {
					t.Fatal(err)
				}
				if s.PID("fixture") <= 0 {
					t.Fatal("missing native Tree PID")
				}
				s.Stop("fixture")
				if mode == "eof" {
					if _, err := os.Stat(filepath.Join(dir, "runtime-eof-observed")); err != nil {
						t.Fatal("runtime did not receive EOF grace")
					}
				}
			} else if err == nil {
				t.Fatal("invalid startup accepted")
			}
			s.Close()
			assertWindowsNoKeys(t, s)
		})
	}
}
func TestWindowsSupervisorZeroLossFinalStdout(t *testing.T) {
	s, dir := windowsSupervisor(t, "burst")
	s.opts.StartTimeout = 10 * time.Second
	s.opts.RedactLog = func(map[string]string) func(string) string {
		return func(line string) string {
			if strings.HasPrefix(line, "fixture-progress ") {
				time.Sleep(time.Millisecond)
			}
			return line
		}
	}
	err := s.Wake(context.Background(), "fixture")
	var exit *StartError
	if !errors.As(err, &exit) || exit.Code != 2 {
		t.Fatalf("native status: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "logs", "runtime.log"))
	if err != nil || !strings.Contains(string(b), strings.Repeat("z", 512<<10)+"FINAL_STDOUT_SURVIVED") {
		t.Fatalf("lost final stdout: %v", err)
	}
	assertWindowsNoKeys(t, s)
}
