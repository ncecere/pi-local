package linuxsandbox

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

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
