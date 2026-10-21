//go:build windows

package process

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Every process used here is a synthetic copy of this test executable, and
// every marker/PID is under t.TempDir. No installed runtimes/providers/store.
func TestWindowsJobHelper(t *testing.T) {
	if os.Getenv("PL_WINDOWS_JOB_HELPER") != "1" {
		return
	}
	mode := os.Getenv("PL_WINDOWS_JOB_MODE")
	dir := os.Getenv("PL_WINDOWS_JOB_DIR")
	marker := func(name string) {
		path := filepath.Join(dir, name)
		if os.WriteFile(path+".tmp", []byte(strconv.Itoa(os.Getpid())), 0600) != nil {
			os.Exit(90)
		}
		if os.Rename(path+".tmp", path) != nil {
			os.Exit(90)
		}
	}
	// This is the earliest helper statement that touches the filesystem.
	marker(mode + ".started")
	switch mode {
	case "exit":
		os.Exit(17)
	case "unsigned-exit":
		windows.ExitProcess(0xc0000005)
	case "echo":
		var input map[string]any
		if json.NewDecoder(os.Stdin).Decode(&input) != nil {
			os.Exit(91)
		}
		cwd, _ := os.Getwd()
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"cwd": cwd, "args": os.Args[3:], "env": os.Getenv("JOB_CASE"), "input": input})
		os.Exit(0)
	case "null":
		b, err := io.ReadAll(os.Stdin)
		if err != nil || len(b) != 0 {
			os.Exit(92)
		}
		os.Exit(0)
	case "small":
		fmt.Fprintln(os.Stdout, "final-output")
		os.Exit(0)
	case "inherit":
		h, _ := strconv.ParseUint(os.Getenv("PL_WINDOWS_EXTRA_HANDLE"), 10, 64)
		_ = windows.SetEvent(windows.Handle(h))
		os.Exit(0)
	case "burst":
		_, _ = io.WriteString(os.Stdout, strings.Repeat("z", 2<<20)+"FINAL_STDOUT_SURVIVED")
		os.Exit(0)
	case "dual":
		var wg sync.WaitGroup
		for _, f := range []*os.File{os.Stdout, os.Stderr} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; i < 100; i++ {
					fmt.Fprintln(f, "shared-consumer")
				}
			}()
		}
		wg.Wait()
		os.Exit(0)
	case "eof":
		_, _ = io.Copy(io.Discard, os.Stdin)
		marker("eof-observed")
		os.Exit(0)
	case "breakaway":
		c := windowsHelperCommand(dir, "escape")
		c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_BREAKAWAY_FROM_JOB}
		err := c.Start()
		if err == nil {
			_ = c.Process.Kill()
			_ = c.Wait()
			os.Exit(93)
		}
		if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			os.Exit(94)
		}
		marker("breakaway-denied")
		os.Exit(0)
	case "tree", "crash":
		c := windowsHelperCommand(dir, "child")
		c.Stdout, c.Stderr = os.Stdout, os.Stderr
		if c.Start() != nil {
			os.Exit(94)
		}
		if !helperWaitFile(dir, "grandchild.started") {
			os.Exit(95)
		}
		marker("tree-ready")
		if mode == "crash" {
			if os.Getenv("PL_WINDOWS_CRASH_GATE") == "1" && !helperWaitFile(dir, "crash-release") {
				os.Exit(99)
			}
			os.Exit(23)
		}
	case "child":
		c := windowsHelperCommand(dir, "grandchild")
		c.Stdout, c.Stderr = os.Stdout, os.Stderr
		if c.Start() != nil {
			os.Exit(96)
		}
	case "owner":
		c := windowsHelperCommand(dir, "tree")
		tr, err := Start(context.Background(), c)
		if err != nil {
			os.Exit(97)
		}
		defer tr.Close() // deliberately bypassed by abrupt owner termination
		if !helperWaitFile(dir, "tree-ready") {
			os.Exit(98)
		}
		marker("owner-ready")
	}
	for {
		time.Sleep(time.Hour)
	}
}

func windowsHelperCommand(dir, mode string, args ...string) *exec.Cmd {
	exe, _ := os.Executable()
	cmd := exec.Command(exe, append([]string{"-test.run=^TestWindowsJobHelper$", "--"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PL_WINDOWS_JOB_HELPER=1", "PL_WINDOWS_JOB_MODE="+mode, "PL_WINDOWS_JOB_DIR="+dir, "GORACE=atexit_sleep_ms=0")
	return cmd
}
func helperWaitFile(dir, name string) bool {
	until := time.Now().Add(8 * time.Second)
	for time.Now().Before(until) {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}
func waitFile(t *testing.T, dir, name string) {
	t.Helper()
	if !helperWaitFile(dir, name) {
		t.Fatalf("missing synthetic marker %s", name)
	}
}
func waitNativeTree(t *testing.T, tr Tree) error {
	t.Helper()
	select {
	case <-tr.Done():
		return tr.Wait()
	case <-time.After(10 * time.Second):
		_ = tr.KillTree()
		t.Fatal("native tree wait timed out")
		return nil
	}
}
func openFixtureHandle(t *testing.T, dir, name string) windows.Handle {
	t.Helper()
	waitFile(t, dir, name)
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.ParseUint(string(b), 10, 32)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.CloseHandle(h) })
	return h
}
func assertFixtureExited(t *testing.T, h windows.Handle) {
	t.Helper()
	event, err := windows.WaitForSingleObject(h, 5000)
	if err != nil || event != windows.WAIT_OBJECT_0 {
		t.Fatalf("synthetic child survived cleanup: event=%d err=%v", event, err)
	}
}

func TestWindowsAtomicSuspendedLaunch(t *testing.T) {
	dir := t.TempDir()
	cmd := windowsHelperCommand(dir, "hold")
	checked := false
	tr, err := startWindows(context.Background(), cmd, windowsLaunchHooks{beforeResume: func(pi windows.ProcessInformation, job windows.Handle) error {
		for _, h := range []windows.Handle{job, pi.Process, pi.Thread} {
			var flags uint32
			if e := nativeGetHandleInformation(h, &flags); e != nil || flags&windows.HANDLE_FLAG_INHERIT != 0 {
				return fmt.Errorf("owned handle is inheritable or unqueryable: %d/%v", flags, e)
			}
		}
		member, e := inExactJob(pi.Process, job)
		if e != nil || !member {
			return fmt.Errorf("exact job membership: %v/%v", member, e)
		}
		if _, e := os.Stat(filepath.Join(dir, "hold.started")); !os.IsNotExist(e) {
			return fmt.Errorf("helper executed before ResumeThread: %v", e)
		}
		// Querying the exact retained process handle must show it is still alive.
		event, e := windows.WaitForSingleObject(pi.Process, 0)
		if e != nil || event != uint32(windows.WAIT_TIMEOUT) {
			return fmt.Errorf("suspended wait: %d/%v", event, e)
		}
		checked = true
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	if !checked || tr.PID() <= 0 || tr.ExitCode() != -1 {
		t.Fatal("missing suspended membership proof/lifetime status")
	}
	if cmd.Process != nil || cmd.ProcessState != nil {
		t.Fatal("native launch fabricated exec state")
	}
	waitFile(t, dir, "hold.started")
	if err := tr.KillTree(); err != nil {
		t.Fatal(err)
	}
	_ = waitNativeTree(t, tr)
	if tr.ExitCode() != 1 {
		t.Fatalf("actual kill code = %d", tr.ExitCode())
	}
}

func TestWindowsFailuresNeverExecute(t *testing.T) {
	for _, mode := range []string{"verify", "verify-error", "callback", "cancel", "resume", "missing", "cwd", "lookup", "sysproc", "extra", "nul-env", "cancel-before"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			cmd := windowsHelperCommand(dir, "must-not-run")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			hooks := windowsLaunchHooks{}
			switch mode {
			case "verify":
				hooks.verify = func(windows.Handle, windows.Handle) (bool, error) { return false, nil }
			case "verify-error":
				hooks.verify = func(windows.Handle, windows.Handle) (bool, error) { return false, windows.ERROR_ACCESS_DENIED }
			case "callback":
				hooks.beforeResume = func(windows.ProcessInformation, windows.Handle) error {
					return errors.New("injected before-resume failure")
				}
			case "cancel":
				hooks.beforeResume = func(windows.ProcessInformation, windows.Handle) error { cancel(); return nil }
			case "resume":
				hooks.resume = func(windows.Handle) (uint32, error) { return 0, windows.ERROR_ACCESS_DENIED }
			case "missing":
				cmd.Path = filepath.Join(dir, "missing.exe")
			case "cwd":
				cmd.Dir = filepath.Join(dir, "missing-directory")
			case "lookup":
				cmd.Err = exec.ErrNotFound
			case "sysproc":
				cmd.SysProcAttr = &syscall.SysProcAttr{}
			case "extra":
				cmd.ExtraFiles = []*os.File{os.Stderr}
			case "nul-env":
				cmd.Env = append(cmd.Env, "INVALID=x\x00y")
			case "cancel-before":
				cancel()
			}
			if tr, err := startWindows(ctx, cmd, hooks); err == nil {
				tr.Close()
				t.Fatal("wanted fail-closed error")
			}
			if _, err := os.Stat(filepath.Join(dir, "must-not-run.started")); !os.IsNotExist(err) {
				t.Fatal("failed launch ran helper")
			}
			if cmd.Process != nil || cmd.ProcessState != nil {
				t.Fatal("descriptor mutated")
			}
		})
	}
}

func TestWindowsRealExitAndConcurrentClose(t *testing.T) {
	tr, err := Start(context.Background(), windowsHelperCommand(t.TempDir(), "exit"))
	if err != nil {
		t.Fatal(err)
	}
	pid := tr.PID()
	err = waitNativeTree(t, tr)
	var status *ExitStatusError
	if !errors.As(err, &status) || status.Code != 17 || tr.ExitCode() != 17 {
		t.Fatalf("status=%d err=%v", tr.ExitCode(), err)
	}
	var fake *exec.ExitError
	if errors.As(err, &fake) {
		t.Fatal("fabricated exec.ExitError")
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := tr.Close(); err != nil {
				t.Error(err)
			}
			_ = tr.KillTree()
			_ = tr.Term()
			_ = tr.Wait()
		}()
	}
	wg.Wait()
	if tr.PID() != pid || tr.ExitCode() != 17 {
		t.Fatal("status lifetime changed on Close")
	}
}

func TestWindowsNativeUnsignedExitCode(t *testing.T) {
	tr, err := Start(context.Background(), windowsHelperCommand(t.TempDir(), "unsigned-exit"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	err = waitNativeTree(t, tr)
	var status *ExitStatusError
	want := uint32(0xc0000005)
	if !errors.As(err, &status) || status.Code != want || tr.ExitCode() != int(want) {
		t.Fatalf("native 32-bit status truncated/fabricated: %d %v", tr.ExitCode(), err)
	}
}

func TestWindowsConcurrentCloseRunningTree(t *testing.T) {
	dir := t.TempDir()
	tr, err := Start(context.Background(), windowsHelperCommand(dir, "tree"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	waitFile(t, dir, "tree-ready")
	child := openFixtureHandle(t, dir, "child.started")
	grandchild := openFixtureHandle(t, dir, "grandchild.started")
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = tr.Term()
			if err := tr.Close(); err != nil {
				t.Error(err)
			}
			_ = tr.KillTree()
			_ = tr.Wait()
		}()
	}
	wg.Wait()
	assertFixtureExited(t, child)
	assertFixtureExited(t, grandchild)
}

func TestWindowsDescendantLifecycle(t *testing.T) {
	for _, mode := range []string{"tree", "crash"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			cmd := windowsHelperCommand(dir, mode)
			// Gate synthetic leader exit so descendant handles are pinned before exit;
			// no test ever signals an unowned/recycled numeric process identity.
			if mode == "crash" {
				cmd.Env = append(cmd.Env, "PL_WINDOWS_CRASH_GATE=1")
			}
			tr, err := Start(context.Background(), cmd)
			if err != nil {
				t.Fatal(err)
			}
			defer tr.Close()
			waitFile(t, dir, "tree-ready")
			child := openFixtureHandle(t, dir, "child.started")
			grandchild := openFixtureHandle(t, dir, "grandchild.started")
			if mode == "tree" {
				if err := tr.KillTree(); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.WriteFile(filepath.Join(dir, "crash-release"), nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			_ = waitNativeTree(t, tr)
			if mode == "crash" && tr.ExitCode() != 23 {
				t.Fatalf("leader crash code %d", tr.ExitCode())
			}
			assertFixtureExited(t, child)
			assertFixtureExited(t, grandchild)
		})
	}
}

func TestWindowsParentDeathKillsJob(t *testing.T) {
	dir := t.TempDir()
	owner := windowsHelperCommand(dir, "owner")
	// This synthetic outer app intentionally uses exec: it must NOT be in an outer
	// test-owned job, which could mask a broken inner kill-on-last-handle policy.
	if err := owner.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = owner.Process.Kill(); _ = owner.Wait() }()
	waitFile(t, dir, "owner-ready")
	leader := openFixtureHandle(t, dir, "tree.started")
	child := openFixtureHandle(t, dir, "child.started")
	grandchild := openFixtureHandle(t, dir, "grandchild.started")
	if err := owner.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = owner.Wait()
	assertFixtureExited(t, leader)
	assertFixtureExited(t, child)
	assertFixtureExited(t, grandchild)
}

func TestWindowsNoBreakaway(t *testing.T) {
	dir := t.TempDir()
	tr, err := Start(context.Background(), windowsHelperCommand(dir, "breakaway"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	if err := waitNativeTree(t, tr); err != nil {
		t.Fatal(err)
	}
	waitFile(t, dir, "breakaway-denied")
	if _, err := os.Stat(filepath.Join(dir, "escape.started")); !os.IsNotExist(err) {
		t.Fatal("breakaway executed")
	}
}

func TestWindowsUnicodeJSONAndOwnedOutput(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "spaces 日本語")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	args := []string{"α space", `quote"slash\`, "", `trailing space\`}
	cmd := windowsHelperCommand(dir, "echo", args...)
	// Exercise an explicit Unicode/spaces application path, not just cwd/args.
	exe, err := os.Open(cmd.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer exe.Close()
	app := filepath.Join(dir, "日本語 helper.exe")
	copied, err := os.Create(app)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(copied, exe)
	closeErr := copied.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		t.Fatal(err)
	}
	cmd.Path, cmd.Args[0] = app, app
	cmd.Env = append(cmd.Env, "Job_Case=discard", "JOB_CASE=雪 value")
	cmd.Stdin = strings.NewReader(`{"hello":"世界"}`)
	p, err := NewOutputPipe(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	tr, err := Start(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	p.Started(tr.Done(), nil, OutputDrainGrace)
	b, err := io.ReadAll(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := waitNativeTree(t, tr); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Cwd   string
		Args  []string
		Env   string
		Input map[string]string
	}
	if err := json.Unmarshal(b, &result); err != nil {
		t.Fatalf("%s: %v", b, err)
	}
	if !strings.EqualFold(result.Cwd, dir) || result.Env != "雪 value" || result.Input["hello"] != "世界" || strings.Join(result.Args, "|") != strings.Join(args, "|") {
		t.Fatalf("round trip: %+v", result)
	}
}

func TestWindowsLargeFinalStdout(t *testing.T) {
	cmd := windowsHelperCommand(t.TempDir(), "burst")
	p, err := NewOutputPipe(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	tr, err := Start(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	p.Started(tr.Done(), nil, OutputDrainGrace)
	// Concurrent consumption, then deliberately drain buffered final bytes after
	// Wait: Tree must never close caller-owned reader at leader exit.
	b, err := io.ReadAll(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := waitNativeTree(t, tr); err != nil {
		t.Fatal(err)
	}
	want := (2 << 20) + len("FINAL_STDOUT_SURVIVED")
	if len(b) != want || !bytes.HasSuffix(b, []byte("FINAL_STDOUT_SURVIVED")) {
		t.Fatalf("lost stdout: %d/%d", len(b), want)
	}
}

type detectingWriter struct {
	mu         sync.Mutex
	active     bool
	concurrent bool
	b          bytes.Buffer
}

func (w *detectingWriter) Write(b []byte) (int, error) {
	w.mu.Lock()
	if w.active {
		w.concurrent = true
	}
	w.active = true
	w.mu.Unlock()
	time.Sleep(time.Microsecond)
	w.mu.Lock()
	defer w.mu.Unlock()
	n, e := w.b.Write(b)
	w.active = false
	return n, e
}
func TestWindowsSerializedSharedConsumer(t *testing.T) {
	cmd := windowsHelperCommand(t.TempDir(), "dual")
	dst := &detectingWriter{}
	cmd.Stdout, cmd.Stderr = dst, dst
	tr, err := Start(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	if err := waitNativeTree(t, tr); err != nil {
		t.Fatal(err)
	}
	if dst.concurrent || bytes.Count(dst.b.Bytes(), []byte("shared-consumer")) != 200 {
		t.Fatal("shared writer was concurrent or lost output")
	}
}

func TestWindowsRuntimeEOFAndCancellation(t *testing.T) {
	t.Run("runtime EOF", func(t *testing.T) {
		dir := t.TempDir()
		cmd := windowsHelperCommand(dir, "eof")
		input, err := NewInputPipe(cmd)
		if err != nil {
			t.Fatal(err)
		}
		defer input.Close()
		tr, err := Start(context.Background(), cmd)
		if err != nil {
			t.Fatal(err)
		}
		defer tr.Close()
		input.Started()
		waitFile(t, dir, "eof.started")
		_ = input.Close()
		if err := tr.GracefulStop(3 * time.Second); err != nil {
			t.Fatal(err)
		}
		if tr.ExitCode() != 0 {
			t.Fatalf("EOF status %d", tr.ExitCode())
		}
		waitFile(t, dir, "eof-observed")
	})
	t.Run("null login", func(t *testing.T) {
		tr, err := Start(context.Background(), windowsHelperCommand(t.TempDir(), "null"))
		if err != nil {
			t.Fatal(err)
		}
		defer tr.Close()
		if err := waitNativeTree(t, tr); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("watch cancellation", func(t *testing.T) {
		dir := t.TempDir()
		tr, err := Start(context.Background(), windowsHelperCommand(dir, "hold"))
		if err != nil {
			t.Fatal(err)
		}
		defer tr.Close()
		waitFile(t, dir, "hold.started")
		ctx, cancel := context.WithCancel(context.Background())
		Watch(ctx, tr, 10*time.Millisecond)
		cancel()
		_ = waitNativeTree(t, tr)
		if tr.ExitCode() != 1 {
			t.Fatalf("cancel status %d", tr.ExitCode())
		}
	})
}

func TestWindowsOnlyStdioInherited(t *testing.T) {
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), InheritHandle: 1}
	event, err := windows.CreateEvent(&sa, 1, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(event)
	cmd := windowsHelperCommand(t.TempDir(), "inherit")
	cmd.Env = append(cmd.Env, fmt.Sprintf("PL_WINDOWS_EXTRA_HANDLE=%d", event))
	tr, err := Start(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	if err := waitNativeTree(t, tr); err != nil {
		t.Fatal(err)
	}
	state, err := windows.WaitForSingleObject(event, 0)
	if err != nil || state != uint32(windows.WAIT_TIMEOUT) {
		t.Fatalf("unlisted inheritable event leaked to child: %d/%v", state, err)
	}
}

type gatedWindowsWriter struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (w *gatedWindowsWriter) Write(b []byte) (int, error) {
	w.once.Do(func() { close(w.entered) })
	<-w.release
	return len(b), nil
}
func TestWindowsBoundedCopierCleanup(t *testing.T) {
	cmd := windowsHelperCommand(t.TempDir(), "small")
	writer := &gatedWindowsWriter{entered: make(chan struct{}), release: make(chan struct{})}
	cmd.Stdout, cmd.WaitDelay = writer, 50*time.Millisecond
	tr, err := Start(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	defer close(writer.release) // callbacks are caller-owned and must eventually return
	select {
	case <-writer.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("copier never reached callback")
	}
	if err := waitNativeTree(t, tr); !errors.Is(err, exec.ErrWaitDelay) {
		t.Fatalf("missing bounded I/O error: %v", err)
	}
	if tr.ExitCode() != 0 {
		t.Fatalf("copier timeout fabricated process status: %d", tr.ExitCode())
	}
	if err := tr.Close(); err != nil {
		t.Fatal(err)
	}
}

func nativeGetHandleInformation(h windows.Handle, flags *uint32) error {
	proc := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetHandleInformation")
	r, _, err := proc.Call(uintptr(h), uintptr(unsafe.Pointer(flags)))
	if r == 0 {
		return err
	}
	return nil
}

func nativeHandleCount(t *testing.T) uint32 {
	t.Helper()
	var n uint32
	proc := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetProcessHandleCount")
	r, _, err := proc.Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&n)))
	if r == 0 {
		t.Fatal(err)
	}
	return n
}
