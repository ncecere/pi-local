//go:build darwin || linux

package process

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Every helper is a fresh test binary with a minimal environment and temp cwd.
func TestProcessHelper(t *testing.T) {
	if os.Getenv("PROCESS_HELPER") != "1" {
		return
	}
	mode := os.Args[len(os.Args)-1]
	switch mode {
	case "early":
		os.Exit(0)
	case "heartbeat":
		signal.Ignore(syscall.SIGTERM)
		for i := 0; ; i++ {
			os.WriteFile("heartbeat", []byte(fmt.Sprint(i)), 0600)
			time.Sleep(5 * time.Millisecond)
		}
	case "descendants", "orphan":
		cmd := exec.Command(os.Args[0], "-test.run=^TestProcessHelper$", "--", "heartbeat")
		cmd.Env, cmd.Dir = os.Environ(), "."
		if err := cmd.Start(); err != nil {
			os.Exit(8)
		}
		signal.Ignore(syscall.SIGTERM)
	case "ignore":
		signal.Ignore(syscall.SIGTERM)
	case "graceful":
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGTERM)
		fmt.Println("ready")
		<-ch
		os.WriteFile("graceful", []byte("yes"), 0600)
		os.Exit(0)
	case "stdin":
		fmt.Println("ready")
		io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	default:
		os.Exit(9)
	}
	fmt.Println("ready")
	for {
		if mode == "orphan" {
			if _, err := os.Stat("exit"); err == nil {
				os.Exit(0)
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func helper(t *testing.T, mode string) (*exec.Cmd, io.ReadCloser) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestProcessHelper$", "--", mode)
	cmd.Env = []string{"PROCESS_HELPER=1", "GORACE=atexit_sleep_ms=0"}
	cmd.Dir = t.TempDir()
	cmd.WaitDelay = time.Second
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { out.Close() })
	return cmd, out
}

func ready(t *testing.T, out io.Reader) {
	t.Helper()
	ch := make(chan bool, 1)
	go func() { s := bufio.NewScanner(out); ch <- s.Scan() && s.Text() == "ready" }()
	select {
	case ok := <-ch:
		if !ok {
			t.Fatal("helper not ready")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("helper readiness timed out")
	}
}

func finished(t *testing.T, tr Tree) {
	t.Helper()
	select {
	case <-tr.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("reap timed out")
	}
}

func TestGracefulAndEscalation(t *testing.T) {
	for _, mode := range []string{"graceful", "ignore", "descendants", "orphan", "stdin", "early"} {
		t.Run(mode, func(t *testing.T) {
			cmd, out := helper(t, mode)
			var stdin io.WriteCloser
			if mode == "stdin" {
				stdin, _ = cmd.StdinPipe()
			}
			tr, err := Start(context.Background(), cmd)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { tr.Close() })
			if mode != "early" {
				ready(t, out)
			}
			if mode == "descendants" || mode == "orphan" {
				deadline := time.Now().Add(5 * time.Second)
				for {
					if _, err := os.ReadFile(filepath.Join(cmd.Dir, "heartbeat")); err == nil {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("descendant not ready")
					}
					time.Sleep(5 * time.Millisecond)
				}
			}
			if mode == "stdin" {
				stdin.Close()
			} else if mode == "orphan" {
				if err := os.WriteFile(filepath.Join(cmd.Dir, "exit"), []byte("yes"), 0600); err != nil {
					t.Fatal(err)
				}
			} else if mode != "early" {
				if err := tr.GracefulStop(80 * time.Millisecond); err != nil {
					t.Fatal(err)
				}
			}
			finished(t, tr)
			tr.Wait()
			if mode == "graceful" || mode == "stdin" || mode == "early" || mode == "orphan" {
				if code := cmd.ProcessState.ExitCode(); code != 0 {
					t.Fatalf("graceful exit code = %d", code)
				}
			}
			if mode == "graceful" {
				if _, err := os.ReadFile(filepath.Join(cmd.Dir, "graceful")); err != nil {
					t.Fatal("TERM did not complete gracefully")
				}
			}
			if mode == "descendants" || mode == "orphan" {
				a, _ := os.ReadFile(filepath.Join(cmd.Dir, "heartbeat"))
				time.Sleep(80 * time.Millisecond)
				b, _ := os.ReadFile(filepath.Join(cmd.Dir, "heartbeat"))
				if string(a) != string(b) {
					t.Fatal("descendant survived tree escalation")
				}
			}
			// Late/concurrent stop and close must never signal an old numeric PID.
			var wg sync.WaitGroup
			for i := 0; i < 8; i++ {
				wg.Add(1)
				go func() { defer wg.Done(); tr.Term(); tr.KillTree(); tr.Close(); tr.Wait() }()
			}
			wg.Wait()
		})
	}
}

type trackedOwner struct {
	containment
	signals, closes int
}

func (o *trackedOwner) signal(cmd *exec.Cmd, kill bool) error {
	o.signals++
	return o.containment.signal(cmd, kill)
}
func (o *trackedOwner) close() error { o.closes++; return o.containment.close() }

func TestRetiresIdentityBeforeReap(t *testing.T) {
	cmd, out := helper(t, "graceful")
	o := &trackedOwner{containment: platformContainment()}
	tr, err := start(context.Background(), cmd, o)
	if err != nil {
		t.Fatal(err)
	}
	ready(t, out)
	tr.GracefulStop(time.Second)
	tr.Wait()
	n := o.signals
	for i := 0; i < 10; i++ {
		tr.Term()
		tr.KillTree()
		tr.Close()
	}
	if o.signals != n || o.closes != 1 {
		t.Fatalf("late signals / resource closes = %d / %d", o.signals-n, o.closes)
	}
}

type brokenObserver struct {
	*trackedOwner
	lost bool
}

func (o *brokenObserver) exited(cmd *exec.Cmd) error {
	if o.lost {
		if err := o.containment.exited(cmd); err != nil {
			return err
		}
		return errIdentityLost
	}
	return errors.New("injected observation failure")
}

func TestObservationFailureAndOwnershipLoss(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(fmt.Sprint(lost), func(t *testing.T) {
			mode := "ignore"
			if lost {
				mode = "early"
			}
			cmd, _ := helper(t, mode)
			o := &brokenObserver{trackedOwner: &trackedOwner{containment: platformContainment()}, lost: lost}
			tr, err := start(context.Background(), cmd, o)
			if err != nil {
				t.Fatal(err)
			}
			defer tr.Close()
			finished(t, tr)
			tr.Term()
			tr.KillTree()
			tr.Close()
			want := 1
			if lost {
				want = 0
			}
			if o.signals != want || o.closes != 1 {
				t.Fatalf("signals/closes = %d/%d", o.signals, o.closes)
			}
		})
	}
}

func TestLifetimeDeadline(t *testing.T) {
	cmd, out := helper(t, "ignore")
	tr, err := Start(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	ready(t, out)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	Watch(ctx, tr, 20*time.Millisecond)
	finished(t, tr)
}
