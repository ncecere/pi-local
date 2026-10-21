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
	if mode == "early" {
		fmt.Println("fixture misconfigured")
		os.Exit(2)
	}
	if mode == "ignore" || mode == "unready" {
		signal.Ignore(syscall.SIGTERM)
	}
	term := make(chan os.Signal, 1)
	if mode == "graceful" {
		signal.Notify(term, syscall.SIGTERM)
	}
	if mode != "unready" {
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
