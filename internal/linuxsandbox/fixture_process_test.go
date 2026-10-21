package linuxsandbox

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Below the five-second ownership cleanup budget. Descendants may retain the
// hidden stderr pipe created by exec.Cmd for an io.Writer, even after root exit.
const fixtureWaitDelay = 250 * time.Millisecond

type fixtureReadiness struct {
	pid int
	err error
}

// Own immediately after Start, before any assertion. Wait has exactly one caller;
// closing stdout also releases the reader if an escaped child holds the writer.
// Only this owned command and explicitly retained handles may be killed.
type fixtureCommand struct {
	cmd                  *exec.Cmd
	stdout               io.ReadCloser
	ready                chan fixtureReadiness
	readerDone, waitDone chan struct{}
	retained             []func()
}

func ownFixtureCommand(cmd *exec.Cmd, stdout io.ReadCloser) *fixtureCommand {
	f := &fixtureCommand{cmd: cmd, stdout: stdout, ready: make(chan fixtureReadiness, 1), readerDone: make(chan struct{}), waitDone: make(chan struct{})}
	go func() {
		defer close(f.waitDone)
		// StdoutPipe requires reads to finish before Wait closes its FDs.
		<-f.readerDone
		_ = cmd.Wait()
	}()
	go func() {
		defer close(f.readerDone)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) == 2 && fields[0] == "escaped-ready" {
				pid, err := strconv.Atoi(fields[1])
				f.ready <- fixtureReadiness{pid, err}
				_, _ = io.Copy(io.Discard, stdout)
				return
			}
		}
		f.ready <- fixtureReadiness{err: fmt.Errorf("no readiness marker")}
	}()
	return f
}

func (f *fixtureCommand) killAndWait() error {
	_ = f.cmd.Process.Kill()
	_ = f.stdout.Close() // escaped writers cannot hold the Wait/reader join open
	select {
	case <-f.waitDone:
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("owned fixture root was not reaped")
	}
}

func (f *fixtureCommand) close() error {
	_ = f.cmd.Process.Kill()
	for _, release := range f.retained {
		release()
	}
	f.retained = nil
	_ = f.stdout.Close()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for _, done := range []chan struct{}{f.waitDone, f.readerDone} {
		select {
		case <-done:
		case <-deadline.C:
			return fmt.Errorf("fixture cleanup failed to join root/reader")
		}
	}
	return nil
}

func TestFixtureCleanupChild(t *testing.T) {
	if os.Getenv("PI_LOCAL_SANDBOX_CLEANUP_CHILD") != "1" {
		t.Skip("single owned cleanup fixture")
	}
	fmt.Println("escaped-ready 2")
	// No grandchildren, process groups, namespaces, or personal data are involved.
	time.Sleep(time.Minute)
}

func startCleanupFixture(t *testing.T) *fixtureCommand {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestFixtureCleanupChild$")
	cmd.Env = []string{"PI_LOCAL_SANDBOX_CLEANUP_CHILD=1"}
	cmd.WaitDelay = fixtureWaitDelay
	// Keep a writer in this parent to model an escaped writer without spawning
	// any extra descendants. Killing the root alone cannot release this reader.
	pipe, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = writer.Close() })
	cmd.Stdout = writer
	if err := cmd.Start(); err != nil {
		_ = pipe.Close()
		t.Fatal(err)
	}
	owned := ownFixtureCommand(cmd, pipe)
	t.Cleanup(func() {
		if err := owned.close(); err != nil {
			t.Error(err)
		}
	})
	return owned
}

func assertFixtureClosed(t *testing.T, f *fixtureCommand) {
	t.Helper()
	if f.cmd.ProcessState == nil {
		t.Fatal("root was not waited")
	}
	select {
	case <-f.waitDone:
	default:
		t.Fatal("root wait still running")
	}
	select {
	case <-f.readerDone:
	default:
		t.Fatal("stdout reader still running")
	}
	if _, err := f.stdout.Read(make([]byte, 1)); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("stdout not closed: %v", err)
	}
}

func TestFixtureCleanupAfterEarlyAssertionFailure(t *testing.T) {
	f := startCleanupFixture(t)
	injected := errors.New("injected namespace/session assertion before pidfd collection")
	err := func() error {
		defer func() {
			if err := f.close(); err != nil {
				t.Error(err)
			}
		}()
		select {
		case r := <-f.ready:
			if r.err != nil {
				return r.err
			}
		case <-time.After(5 * time.Second):
			return fmt.Errorf("fixture readiness timeout")
		}
		return injected
	}()
	if !errors.Is(err, injected) {
		t.Fatal(err)
	}
	assertFixtureClosed(t, f)
}

// A nonblocking io.Writer, NOT a blocked user callback: the copier blocks on
// reading exec's hidden pipe. ReadFrom records that copier's lifetime without
// relying on process-global goroutine counts or stack snapshots.
type fixtureStderrCapture struct {
	mu            sync.Mutex
	buffer        bytes.Buffer
	started, done chan struct{}
}

func (s *fixtureStderrCapture) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buffer.Write(p)
}

func (s *fixtureStderrCapture) ReadFrom(r io.Reader) (int64, error) {
	close(s.started)
	defer close(s.done)
	// Hide optional copy interfaces to avoid recursing into ReadFrom.
	return io.Copy(struct{ io.Writer }{s}, struct{ io.Reader }{r})
}

func (s *fixtureStderrCapture) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buffer.String()
}

// The root spawns exactly one owned descendant. Only that descendant retains
// stderr; its stdout is /dev/null. A fixture-only release file closes stderr,
// and an independent lifetime bound handles even an interrupted test driver.
func TestFixtureRetainedStderrChild(t *testing.T) {
	mode := os.Getenv("PI_LOCAL_SANDBOX_STDERR_CHILD")
	if mode == "" {
		t.Skip("owned retained-stderr helper")
	}
	dir := os.Getenv("PI_LOCAL_SANDBOX_STDERR_DIR")
	if !filepath.IsAbs(dir) {
		t.Fatal("missing fixture directory")
	}
	if mode == "holder" {
		if _, err := fmt.Fprintln(os.Stderr, "fixture-stderr-held"); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "ready"), nil, 0600); err != nil {
			t.Fatal(err)
		}
		// No PID lookup, personal process scan, or namespace operations.
		_ = waitFixtureFile(filepath.Join(dir, "release"), 20*time.Second)
		if err := os.Stderr.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "closed"), nil, 0600); err != nil {
			t.Fatal(err)
		}
		return
	}
	if mode != "root" {
		t.Fatal("unknown stderr fixture mode")
	}
	holder := exec.Command(os.Args[0], "-test.run=^TestFixtureRetainedStderrChild$")
	holder.Env = []string{"PI_LOCAL_SANDBOX_STDERR_CHILD=holder", "PI_LOCAL_SANDBOX_STDERR_DIR=" + dir}
	holder.Stderr = os.Stderr
	holder.WaitDelay = fixtureWaitDelay
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Process.Kill(); _ = holder.Wait() }()
	if err := waitFixtureFile(filepath.Join(dir, "ready"), 5*time.Second); err != nil {
		t.Fatal(err)
	}
	fmt.Println("escaped-ready 2")
	// The test kills this root BEFORE collecting any descendant pidfd. The
	// descendant is still explicitly owned via its release/closed protocol.
	time.Sleep(25 * time.Second)
}

func waitFixtureFile(path string, budget time.Duration) error {
	deadline := time.NewTimer(budget)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return nil
		} else if !os.IsNotExist(err) {
			return err
		}
		select {
		case <-tick.C:
		case <-deadline.C:
			return fmt.Errorf("fixture file handshake timed out")
		}
	}
}

func startRetainedStderrFixture(t *testing.T, zeroDelay bool) (*fixtureCommand, *fixtureStderrCapture, string) {
	t.Helper()
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestFixtureRetainedStderrChild$")
	cmd.Env = []string{"PI_LOCAL_SANDBOX_STDERR_CHILD=root", "PI_LOCAL_SANDBOX_STDERR_DIR=" + dir}
	cmd.WaitDelay = fixtureWaitDelay
	if zeroDelay {
		// Deliberate, safely released negative control only.
		cmd.WaitDelay = 0
	}
	stderr := &fixtureStderrCapture{started: make(chan struct{}), done: make(chan struct{})}
	cmd.Stderr = stderr // Forces a real hidden exec pipe/copier, like the native fixture.
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		_ = pipe.Close()
		t.Fatal(err)
	}
	owned := ownFixtureCommand(cmd, pipe)
	t.Cleanup(func() {
		// Release FIRST, so even the zero-delay control (or a failing assertion)
		// cannot strand the root waiter or stderr copier after this test.
		if err := os.WriteFile(filepath.Join(dir, "release"), nil, 0600); err != nil {
			t.Error(err)
		}
		if err := owned.close(); err != nil {
			t.Error(err)
		}
		if err := waitFixtureFile(filepath.Join(dir, "closed"), 5*time.Second); err != nil {
			t.Error(err)
		}
		select {
		case <-stderr.done:
		default:
			t.Error("exec stderr copier still running after cleanup")
		}
	})
	select {
	case r := <-owned.ready:
		if r.err != nil {
			t.Fatal(r.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stderr holder readiness timeout")
	}
	select {
	case <-stderr.started:
	case <-time.After(time.Second):
		t.Fatal("exec stderr copier did not start")
	}
	return owned, stderr, dir
}

func TestFixtureCleanupJoinsRetainedStderrCopier(t *testing.T) {
	for _, method := range []string{"close", "killAndWait"} {
		t.Run(method, func(t *testing.T) {
			owned, stderr, dir := startRetainedStderrFixture(t, false)
			if len(owned.retained) != 0 {
				t.Fatal("regression must kill before pidfd collection")
			}
			start := time.Now()
			var err error
			if method == "close" {
				err = owned.close()
			} else {
				err = owned.killAndWait()
			}
			if err != nil {
				t.Fatal(err)
			}
			if time.Since(start) >= 4*time.Second {
				t.Fatal("stderr join exceeded bounded cleanup budget")
			}
			// The writer is STILL OPEN: only WaitDelay, not holder exit or release,
			// could have allowed exec's copier and Wait to complete.
			if _, err := os.Stat(filepath.Join(dir, "closed")); !os.IsNotExist(err) {
				t.Fatal("stderr holder closed prematurely")
			}
			select {
			case <-stderr.done:
			default:
				t.Fatal("exec stderr copier leaked")
			}
			if !strings.Contains(stderr.String(), "fixture-stderr-held") {
				t.Fatal("retained stderr was not captured")
			}
			assertFixtureClosed(t, owned)
		})
	}
}

func TestFixtureZeroWaitDelayBlocksUntilStderrHolderReleased(t *testing.T) {
	owned, stderr, dir := startRetainedStderrFixture(t, true)
	_ = owned.cmd.Process.Kill()
	_ = owned.stdout.Close()
	select {
	case <-owned.readerDone:
	case <-time.After(time.Second):
		t.Fatal("stdout reader did not join")
	}
	select {
	case <-owned.waitDone:
		t.Fatal("zero WaitDelay unexpectedly joined while stderr writer remained open")
	case <-time.After(150 * time.Millisecond):
	}
	select {
	case <-stderr.done:
		t.Fatal("stderr copier exited before release")
	default:
	}
	// Unlike a leaking negative control, release then join every goroutine.
	if err := os.WriteFile(filepath.Join(dir, "release"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := owned.close(); err != nil {
		t.Fatal(err)
	}
	if err := waitFixtureFile(filepath.Join(dir, "closed"), time.Second); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stderr.done:
	default:
		t.Fatal("stderr copier did not join after release")
	}
	assertFixtureClosed(t, owned)
}
