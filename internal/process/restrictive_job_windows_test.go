//go:build windows

package process

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

type restrictiveJobResult struct {
	Classification string `json:"classification"`
	Stage          string `json:"stage"`
	Win32          uint32 `json:"win32,omitempty"`
	Error          string `json:"error,omitempty"`
	ExactMember    bool   `json:"exactMember"`
	ActiveLimit    uint32 `json:"activeLimit"`
	BeforeResume   bool   `json:"beforeResume"`
}

func TestWindowsRestrictiveJobHelper(t *testing.T) {
	if os.Getenv("PL_RESTRICTIVE_JOB_HELPER") != "1" {
		return
	}
	result := restrictiveJobResult{}
	exit := func(classification, stage string, err error, code uint32) {
		result.Classification, result.Stage = classification, stage
		if err != nil {
			result.Error = err.Error()
			var errno syscall.Errno
			if errors.As(err, &errno) {
				result.Win32 = uint32(errno)
			}
		}
		_ = json.NewEncoder(os.Stdout).Encode(result)
		// Once SELF is in a KILL_ON_JOB_CLOSE job, explicitly closing its last
		// handle would terminate us before the report is delivered. Exit normally;
		// the kernel closes the handle at process death. No defer/GC owns that handle.
		windows.ExitProcess(code)
	}
	dir := os.Getenv("PL_RESTRICTIVE_JOB_DIR")
	// Prove the executable/environment and this backend work BEFORE restricting
	// this disposable helper. A generic setup/lookup failure must not pass.
	control, err := Start(context.Background(), windowsHelperCommand(dir, "null"))
	if err != nil {
		exit("fixture-setup-error", "control-start", err, 70)
		return
	}
	if err := control.Wait(); err != nil {
		_ = control.Close()
		exit("fixture-setup-error", "control-wait", err, 70)
		return
	}
	if err := control.Close(); err != nil {
		exit("fixture-setup-error", "control-close", err, 70)
		return
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		exit("fixture-setup-error", "create-enclosing-job", err, 70)
		return
	}
	// Until successful assignment it is safe to close the unoccupied job.
	setupFailure := func(stage string, err error) {
		_ = windows.CloseHandle(job)
		exit("fixture-setup-error", stage, err, 70)
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
	limits.BasicLimitInformation.ActiveProcessLimit = 1
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		setupFailure("set-enclosing-limits", err)
		return
	}
	// Assign ONLY this helper, using its own process handle. The test parent is
	// never assigned to a job and no numeric PID is opened/signalled here.
	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		_ = windows.CloseHandle(job)
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.ERROR_NOT_SUPPORTED) {
			exit("unsupported-runner-enclosing-policy", "assign-helper-self", err, 71)
		} else {
			exit("fixture-setup-error", "assign-helper-self", err, 70)
		}
		return
	}
	member, err := inExactJob(windows.CurrentProcess(), job)
	if err != nil || !member {
		exit("fixture-setup-error", "verify-helper-membership", fmt.Errorf("member=%v error=%v", member, err), 70)
		return
	}
	result.ExactMember = true
	var actual windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&actual)), uint32(unsafe.Sizeof(actual)), nil); err != nil {
		exit("fixture-setup-error", "read-enclosing-limits", err, 70)
		return
	}
	result.ActiveLimit = actual.BasicLimitInformation.ActiveProcessLimit
	if result.ActiveLimit != 1 || actual.BasicLimitInformation.LimitFlags != limits.BasicLimitInformation.LimitFlags {
		exit("fixture-setup-error", "verify-enclosing-limits", errors.New("restrictive limits not installed"), 70)
		return
	}
	cmd := windowsHelperCommand(dir, "restricted-target")
	tr, err := startWindows(context.Background(), cmd, windowsLaunchHooks{beforeResume: func(windows.ProcessInformation, windows.Handle) error {
		result.BeforeResume = true
		return errors.New("restrictive enclosing job unexpectedly allowed CreateProcessW")
	}})
	if tr != nil {
		_ = tr.Close()
		exit("containment-failure", "target-start-returned-tree", errors.New("restricted target launched"), 72)
		return
	}
	if _, markerErr := os.Stat(filepath.Join(dir, "restricted-target.started")); !os.IsNotExist(markerErr) {
		exit("containment-failure", "target-marker", fmt.Errorf("target marker exists or unreadable: %v", markerErr), 72)
		return
	}
	// JOB_LIST + inherited active-process quota must fail atomically in
	// CreateProcessW, not by an arbitrary callback/context/descriptor refusal.
	// AssignProcessToJobObject documents termination on an active-process-limit
	// violation; Windows surfaces admission denial/quota failure to creation.
	if err == nil || result.BeforeResume || !strings.Contains(err.Error(), "atomic job CreateProcessW") ||
		!(errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.ERROR_NOT_ENOUGH_QUOTA)) {
		exit("unexpected-target-error", "atomic-create", fmt.Errorf("wanted access/quota denial before callback, got %v", err), 72)
		return
	}
	exit("expected-restrictive-job-denial", "atomic-create", err, 0)
}

func TestWindowsRestrictiveEnclosingJobFailsBeforeExecution(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	cmd := exec.Command(exe, "-test.run=^TestWindowsRestrictiveJobHelper$")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PL_RESTRICTIVE_JOB_HELPER=1", "PL_RESTRICTIVE_JOB_DIR="+dir, "GORACE=atexit_sleep_ms=0")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	// The outer Tree owns only a disposable helper. It does NOT impose the active
	// process limit: that is installed by the helper on itself, never this parent.
	tr, err := Start(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	waitErr := waitNativeTree(t, tr)
	if err := tr.Close(); err != nil {
		t.Fatal(err)
	}
	var result restrictiveJobResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("restrictive helper report: %v; stdout=%q stderr=%q wait=%v", err, stdout.String(), stderr.String(), waitErr)
	}
	t.Logf("restrictive enclosing-job result: %+v", result)
	// Unsupported runner policy is explicit FAILURE with a structured reason,
	// never a generic accepted error, unchecked skip, or proof of containment.
	if waitErr != nil || tr.ExitCode() != 0 || result.Classification != "expected-restrictive-job-denial" || !result.ExactMember || result.ActiveLimit != 1 || result.BeforeResume ||
		(result.Win32 != uint32(windows.ERROR_ACCESS_DENIED) && result.Win32 != uint32(windows.ERROR_NOT_ENOUGH_QUOTA)) {
		t.Fatalf("restrictive job gate did not execute as required: report=%+v exit=%d wait=%v stderr=%q", result, tr.ExitCode(), waitErr, stderr.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "restricted-target.started")); !os.IsNotExist(err) {
		t.Fatalf("restricted child executed: %v", err)
	}
}
