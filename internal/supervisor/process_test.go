//go:build darwin || linux

package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/process"
)

func TestRuntimeProcessHelper(t *testing.T) {
	if os.Getenv("SUPERVISOR_HELPER") != "1" {
		return
	}
	mode := os.Args[len(os.Args)-1]
	if mode == "stdout-holder" {
		os.WriteFile("holder-ready", []byte("yes"), 0600)
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat("release-holder"); err == nil {
				break
			}
			time.Sleep(time.Millisecond)
		}
		os.WriteFile("holder-done", []byte("yes"), 0600)
		os.Exit(0)
	}
	if mode == "retained" || mode == "unready-retained" {
		child := exec.Command(os.Args[0], "-test.run=^TestRuntimeProcessHelper$", "--", "stdout-holder")
		child.Env, child.Stdout = os.Environ(), os.Stdout
		child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if child.Start() != nil {
			os.Exit(9)
		}
		for {
			if _, err := os.Stat("holder-ready"); err == nil {
				break
			}
			time.Sleep(time.Millisecond)
		}
	}
	if mode == "stdout-burst" {
		fmt.Println("fixture-gate")
		for {
			if _, err := os.Stat("release"); err == nil {
				break
			}
			time.Sleep(time.Millisecond)
		}
		for i := 0; i < 200; i++ {
			fmt.Println("fixture-progress " + strings.Repeat("x", 1024))
		}
		fmt.Println(strings.Repeat("z", 512<<10) + "FINAL_STDOUT_SURVIVED")
		os.Exit(2)
	}
	if mode == "early" {
		fmt.Println("fixture misconfigured")
		os.Exit(2)
	}
	if mode == "ignore" || mode == "unready" || mode == "unready-retained" {
		signal.Ignore(syscall.SIGTERM)
	}
	term := make(chan os.Signal, 1)
	if mode == "graceful" {
		signal.Notify(term, syscall.SIGTERM)
	}
	if mode != "unready" && mode != "unready-retained" {
		fmt.Println(`PI_RUNTIME_READY {"port":9}`)
	}
	if mode == "graceful" {
		<-term
		os.WriteFile("graceful", []byte("yes"), 0600)
		os.Exit(0)
	}
	for {
		if mode == "late" {
			if _, err := os.Stat("exit"); err == nil {
				os.Exit(2)
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type countedTree struct {
	process.Tree
	waits, closes atomic.Int32
}

func (c *countedTree) Wait() error  { c.waits.Add(1); return c.Tree.Wait() }
func (c *countedTree) Close() error { c.closes.Add(1); return c.Tree.Close() }

func fixtureSupervisor(t *testing.T, mode string) (*Supervisor, string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	s := New(Options{
		Runtime: Runtime{Node: exe, Args: []string{"-test.run=^TestRuntimeProcessHelper$", "--"}, Script: mode, Dir: dir},
		BaseEnv: map[string]string{"SUPERVISOR_HELPER": "1", "GORACE": "atexit_sleep_ms=0"},
		Resolve: func(context.Context, string) (Spec, error) {
			return Spec{AgentID: "fixture", LogDir: filepath.Join(dir, "logs"), Env: map[string]string{}}, nil
		},
		StartTimeout: 300 * time.Millisecond, StopGrace: 40 * time.Millisecond, ReapInterval: time.Hour,
	})
	t.Cleanup(s.Close)
	return s, dir
}

func noKeys(t *testing.T, s *Supervisor) {
	t.Helper()
	s.keysMu.Lock()
	defer s.keysMu.Unlock()
	if len(s.keys) != 0 {
		t.Fatalf("leaked gateway keys: %d", len(s.keys))
	}
}

func TestProcessStartupFailures(t *testing.T) {
	for _, mode := range []string{"missing", "cancel", "early", "unready"} {
		t.Run(mode, func(t *testing.T) {
			s, dir := fixtureSupervisor(t, mode)
			if mode == "missing" {
				s.opts.Runtime.Node = filepath.Join(dir, "missing")
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancel" {
				cancel()
			}
			var started *countedTree
			s.startProcess = func(ctx context.Context, cmd *exec.Cmd) (process.Tree, error) {
				s.keysMu.Lock()
				n := len(s.keys["fixture"])
				s.keysMu.Unlock()
				if n != 1 {
					t.Error("key not registered before Start")
				}
				tr, err := process.Start(ctx, cmd)
				if err != nil {
					return nil, err
				}
				started = &countedTree{Tree: tr}
				return started, nil
			}
			if err := s.Wake(ctx, "fixture"); err == nil {
				t.Fatal("wanted startup failure")
			}
			noKeys(t, s)
			if started != nil && (started.waits.Load() != 1 || started.closes.Load() != 1) {
				t.Fatalf("Wait/Close = %d/%d", started.waits.Load(), started.closes.Load())
			}
		})
	}
}

func TestPrestartRefusalClosesPipesAndLogs(t *testing.T) {
	s, _ := fixtureSupervisor(t, "unready")
	var stdin, stdout *os.File
	var logs *logFile
	s.startProcess = func(_ context.Context, cmd *exec.Cmd) (process.Tree, error) {
		stdin = cmd.Stdin.(*os.File)
		stdout = cmd.Stdout.(*os.File)
		logs = cmd.Stderr.(*logFile)
		return nil, process.ErrUnsupported
	}
	if err := s.Wake(context.Background(), "fixture"); err == nil {
		t.Fatal("expected refusal")
	}
	noKeys(t, s)
	for _, f := range []*os.File{stdin, stdout} {
		if _, err := f.Stat(); !errors.Is(err, os.ErrClosed) {
			t.Fatalf("child pipe left open: %v", err)
		}
	}
	if logs.f != nil {
		t.Fatal("log file left open")
	}
}

func TestSupervisorDrainsStdout(t *testing.T) {
	s, dir := fixtureSupervisor(t, "stdout-burst")
	s.opts.StartTimeout = 5 * time.Second
	s.opts.RedactLog = func(map[string]string) func(string) string {
		return func(line string) string {
			if line == "fixture-gate" {
				os.WriteFile(filepath.Join(dir, "release"), []byte("yes"), 0600)
				time.Sleep(100 * time.Millisecond)
			}
			if strings.HasPrefix(line, "fixture-progress ") {
				time.Sleep(time.Millisecond)
			}
			return line
		}
	}
	err := s.Wake(context.Background(), "fixture")
	var se *StartError
	if !errors.As(err, &se) || se.Code != 2 {
		t.Fatalf("unexpected runtime exit: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "logs", "runtime.log"))
	if err != nil || !strings.Contains(string(b), strings.Repeat("z", 512<<10)+"FINAL_STDOUT_SURVIVED") {
		t.Fatalf("truncated final stdout log: %v", err)
	}
	noKeys(t, s)
}

func TestSupervisorEscapedStdout(t *testing.T) {
	for _, mode := range []string{"retained", "unready-retained"} {
		t.Run(mode, func(t *testing.T) {
			s, dir := fixtureSupervisor(t, mode)
			t.Cleanup(func() {
				os.WriteFile(filepath.Join(dir, "release-holder"), []byte("yes"), 0600)
				deadline := time.Now().Add(2 * time.Second)
				for {
					if _, err := os.Stat(filepath.Join(dir, "holder-done")); err == nil {
						break
					}
					if time.Now().After(deadline) {
						t.Error("escaped fixture did not finish cooperatively")
						break
					}
					time.Sleep(time.Millisecond)
				}
			})
			start := time.Now()
			err := s.Wake(context.Background(), "fixture")
			if mode == "retained" {
				if err != nil {
					t.Fatal(err)
				}
				s.Stop("fixture")
			} else if err == nil {
				t.Fatal("unready fixture unexpectedly started")
			}
			s.Close()
			noKeys(t, s)
			if time.Since(start) > 8*time.Second {
				t.Fatal("retained stdout blocked stop/deadline cleanup")
			}
			if _, err := os.Stat(filepath.Join(dir, "holder-done")); err == nil {
				t.Fatal("fixture ended before escaped retention was tested")
			}
		})
	}
}

func TestProcessStopAndLateExit(t *testing.T) {
	for _, mode := range []string{"graceful", "ignore", "late"} {
		t.Run(mode, func(t *testing.T) {
			s, dir := fixtureSupervisor(t, mode)
			var tr *countedTree
			s.startProcess = func(ctx context.Context, cmd *exec.Cmd) (process.Tree, error) {
				tree, err := process.Start(ctx, cmd)
				if err != nil {
					return nil, err
				}
				tr = &countedTree{Tree: tree}
				return tr, nil
			}
			if err := s.Wake(context.Background(), "fixture"); err != nil {
				t.Fatal(err)
			}
			if mode == "late" {
				os.WriteFile(filepath.Join(dir, "exit"), []byte("yes"), 0600)
				select {
				case <-tr.Done():
				case <-time.After(5 * time.Second):
					t.Fatal("late exit not reaped")
				}
			}
			s.Stop("fixture")
			s.Close() // also joins monitor cleanup on unexpected exit
			noKeys(t, s)
			if tr.waits.Load() != 1 || tr.closes.Load() != 1 {
				t.Fatalf("Wait/Close = %d/%d", tr.waits.Load(), tr.closes.Load())
			}
			if mode == "graceful" {
				if _, err := os.ReadFile(filepath.Join(dir, "graceful")); err != nil {
					t.Fatal("graceful TERM not observed")
				}
			}
		})
	}
}
