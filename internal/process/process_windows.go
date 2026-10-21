//go:build windows

package process

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// PROC_THREAD_ATTRIBUTE_JOB_LIST = ProcThreadAttributeValue(13, FALSE, TRUE,
// FALSE), i.e. 0x0002000d, from the Windows SDK WinBase.h. x/sys
// v0.49.0 supplies the attribute API but not this constant. Windows 10+ is
// required. An unsupported attribute/nested-job policy fails closed.
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
const procThreadAttributeJobList = 0x0002000d

var isProcessInJobProc = windows.NewLazySystemDLL("kernel32.dll").NewProc("IsProcessInJob")

func inExactJob(process, job windows.Handle) (bool, error) {
	var inJob int32
	r, _, err := isProcessInJobProc.Call(uintptr(process), uintptr(job), uintptr(unsafe.Pointer(&inJob)))
	if r == 0 {
		return false, err
	}
	return inJob != 0, nil
}

// Hooks are package-private and only used by native synthetic tests. Production
// never exposes a suspended process or its handles to a caller.
type windowsLaunchHooks struct {
	fileType       func(windows.Handle) (uint32, error)
	duplicateStdio func(windows.Handle) (windows.Handle, error)
	verify         func(windows.Handle, windows.Handle) (bool, error)
	beforeResume   func(windows.ProcessInformation, windows.Handle) error
	resume         func(windows.Handle) (uint32, error)
}

func platformStart(ctx context.Context, cmd *exec.Cmd) (Tree, error) {
	return startWindows(ctx, cmd, windowsLaunchHooks{})
}

func startWindows(ctx context.Context, cmd *exec.Cmd, hooks windowsLaunchHooks) (Tree, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	descriptor, err := windowsDescriptor(cmd)
	if err != nil {
		return nil, err
	}
	// These APIs are required, not optional capabilities with unsafe fallbacks.
	if err := isProcessInJobProc.Find(); err != nil {
		return nil, err
	}
	attrs, err := windows.NewProcThreadAttributeList(2)
	if err != nil {
		return nil, fmt.Errorf("process: required startup attributes: %w", err)
	}
	defer attrs.Delete()
	job, err := windows.CreateJobObject(nil, nil) // unnamed, non-inheritable
	if err != nil {
		return nil, err
	}
	var pi windows.ProcessInformation
	launched := false
	var streams *windowsStreams
	defer func() {
		if launched {
			return
		}
		// On every post-create failure the leader is still suspended. Terminate both
		// the job and the owned process handle, then reap before releasing resources.
		_ = windows.TerminateJobObject(job, 1)
		if pi.Process != 0 {
			_ = windows.TerminateProcess(pi.Process, 1)
			_, _ = windows.WaitForSingleObject(pi.Process, windows.INFINITE)
			_ = windows.CloseHandle(pi.Process)
		}
		if pi.Thread != 0 {
			_ = windows.CloseHandle(pi.Thread)
		}
		if streams != nil {
			streams.closeAll()
		}
		_ = windows.CloseHandle(job)
	}()
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	// No BREAKAWAY_OK or SILENT_BREAKAWAY_OK. Last-handle app death kills children.
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, err
	}
	if err := attrs.Update(procThreadAttributeJobList, unsafe.Pointer(&job), unsafe.Sizeof(job)); err != nil {
		return nil, fmt.Errorf("process: atomic job assignment unavailable: %w", err)
	}
	streams, err = prepareWindowsStreams(cmd)
	if err != nil {
		return nil, err
	}
	defer streams.closeChild()
	fileType := windows.GetFileType
	if hooks.fileType != nil {
		fileType = hooks.fileType
	}
	// Validate the entire batch BEFORE creating even one inheritable duplicate.
	// In particular Fd on a closed File is -1, also CURRENT_PROCESS when passed
	// to DuplicateHandle. Never turn that sentinel into inherited authority.
	var sources [3]windows.Handle
	for i, f := range streams.child {
		if f == nil {
			return nil, fmt.Errorf("process: stdio %d: nil file", i)
		}
		sources[i] = windows.Handle(f.Fd())
		if err := validateWindowsStdioHandle(sources[i], fileType); err != nil {
			return nil, fmt.Errorf("process: stdio %d: %w", i, err)
		}
	}
	// Only fresh inheritable duplicates of the three stdio handles are passed.
	// The job and process/thread handles are never inheritable.
	var handles [3]windows.Handle
	defer func() {
		for _, h := range handles {
			if h != 0 {
				_ = windows.CloseHandle(h)
			}
		}
	}()
	duplicate := duplicateWindowsStdio
	if hooks.duplicateStdio != nil {
		duplicate = hooks.duplicateStdio
	}
	for i, source := range sources {
		handles[i], err = duplicate(source)
		if err != nil {
			return nil, err
		}
	}
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&handles[0]), unsafe.Sizeof(handles)); err != nil {
		return nil, err
	}
	si := windows.StartupInfoEx{StartupInfo: windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{})), Flags: windows.STARTF_USESTDHANDLES, StdInput: handles[0], StdOutput: handles[1], StdErr: handles[2]}, ProcThreadAttributeList: attrs.List()}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_SUSPENDED)
	err = windows.CreateProcess(descriptor.app, descriptor.argv, nil, nil, true, flags, &descriptor.env[0], descriptor.dir, &si.StartupInfo, &pi)
	runtime.KeepAlive(descriptor)
	runtime.KeepAlive(handles)
	if err != nil {
		return nil, fmt.Errorf("process: atomic job CreateProcessW: %w", err)
	}
	verify := inExactJob
	if hooks.verify != nil {
		verify = hooks.verify
	}
	member, err := verify(pi.Process, job)
	if err != nil {
		return nil, err
	}
	if !member {
		return nil, errors.New("process: suspended child not in owned job")
	}
	if hooks.beforeResume != nil {
		if err := hooks.beforeResume(pi, job); err != nil {
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	resume := windows.ResumeThread
	if hooks.resume != nil {
		resume = hooks.resume
	}
	previous, err := resume(pi.Thread)
	if err != nil {
		return nil, fmt.Errorf("process: ResumeThread: %w", err)
	}
	if previous != 1 {
		return nil, fmt.Errorf("process: unexpected suspend count %d", previous)
	}
	_ = windows.CloseHandle(pi.Thread)
	pi.Thread = 0
	t := &windowsTree{process: pi.Process, job: job, pid: int(pi.ProcessId), done: make(chan struct{}), streams: streams, delay: cmd.WaitDelay, code: -1}
	launched = true
	// Cmd remains a launch descriptor. In particular Cmd.Process/ProcessState stay
	// nil, and no private exec I/O bookkeeping or context watcher is installed.
	streams.start()
	go t.reap()
	return t, nil
}

type windowsTree struct {
	mu           sync.Mutex
	process, job windows.Handle
	pid          int
	retired      bool
	streams      *windowsStreams
	delay        time.Duration
	done         chan struct{}
	code         int
	err          error
	closeOnce    sync.Once
	closeErr     error
}

func (t *windowsTree) PID() int              { return t.pid }
func (t *windowsTree) Done() <-chan struct{} { return t.done }
func (t *windowsTree) Wait() error           { <-t.done; return t.err }
func (t *windowsTree) ExitCode() int {
	select {
	case <-t.done:
		return t.code
	default:
		return -1
	}
}
func (t *windowsTree) reap() {
	event, err := windows.WaitForSingleObject(t.process, windows.INFINITE)
	if err == nil && event != windows.WAIT_OBJECT_0 {
		err = fmt.Errorf("process: unexpected wait event %d", event)
	}
	t.mu.Lock()
	// Retire all signalling before publishing completion. Leader exit must not
	// leave grandchildren alive; do not wait for them to voluntarily close pipes.
	killErr := windows.TerminateJobObject(t.job, 1)
	observedExit := err == nil
	if !observedExit {
		_ = windows.TerminateProcess(t.process, 1)
		retryEvent, retryErr := windows.WaitForSingleObject(t.process, windows.INFINITE)
		observedExit = retryErr == nil && retryEvent == windows.WAIT_OBJECT_0
		err = errors.Join(err, retryErr)
	}
	t.retired = true
	t.mu.Unlock()
	var code uint32
	var statusErr error
	if observedExit {
		statusErr = windows.GetExitCodeProcess(t.process, &code)
		if statusErr == nil {
			t.code = int(code)
		}
	}
	t.err = errors.Join(err, statusErr, killErr)
	if observedExit && statusErr == nil && code != 0 {
		t.err = errors.Join(t.err, &ExitStatusError{Code: code})
	}
	t.err = errors.Join(t.err, t.streams.finish(t.delay))
	close(t.done)
}
func (t *windowsTree) KillTree() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.retired {
		return nil
	}
	return windows.TerminateJobObject(t.job, 1)
}

// Term does not pretend Windows has Unix SIGTERM. Runtime stdin EOF is opt-in
// at the supervisor; other commands simply receive a bounded grace period.
func (t *windowsTree) Term() error { return nil }
func (t *windowsTree) GracefulStop(grace time.Duration) error {
	timer := time.NewTimer(max(grace, 0))
	defer timer.Stop()
	select {
	case <-t.done:
		return nil
	case <-timer.C:
	}
	err := t.KillTree()
	<-t.done
	return err
}
func (t *windowsTree) Close() error {
	t.closeOnce.Do(func() {
		t.closeErr = t.KillTree()
		<-t.done
		// The last job handle is held until process wait and bounded copier cleanup.
		t.closeErr = errors.Join(t.closeErr, windows.CloseHandle(t.process), windows.CloseHandle(t.job))
	})
	return t.closeErr
}
