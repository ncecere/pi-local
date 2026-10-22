//go:build windows

package process

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
)

func candidateLogAccessReport(t *testing.T, r candidateAccessReport, err error) {
	t.Helper()
	var code syscall.Errno
	present := errors.As(err, &code)
	t.Logf("semantic diagnostic: complete=%v error=%v numericCodePresent=%v code=%d (observation only; no authorization)", r.complete, err != nil, present, uint64(code))
	for i, o := range r.checks {
		t.Logf("semantic control=%d API=%v valid=%v allow=%v granted=%d numericCodePresent=%v code=%d", i, o.apiSuccess, o.valid, o.allowed, o.granted, o.numericCodePresent, o.code)
	}
}

// Independently selectable: -run '^TestWindowsAppContainerAccessCheckPairedControl$'.
// Ordinary AC is ONLY this disposable suspended comparison, never a fallback.
// LPAC must complete the fixed metadata+semantic contract and reach the OFF
// stop; no historical selector46/87 recognition is accepted by this contract.
func TestWindowsAppContainerAccessCheckPairedControl(t *testing.T) {
	dependencies, err := newNativeAppContainerVerification()
	if err != nil {
		t.Fatal(err)
	}
	profileAPI, err := candidateNativeProfileAPI(t)
	if err != nil {
		t.Fatal(err)
	}
	primaryAPI, err := candidatePrimaryNativeAPI(t)
	if err != nil {
		t.Fatal(err)
	}
	accessAPI, err := candidateAccessNativeAPI()
	if err != nil {
		t.Fatal("semantic diagnostic API unavailable")
	}
	shapeAPI := candidateShapeNativeAPI(t)
	primary, err := candidateAcquirePrimary(primaryAPI)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := primary.close(); err != nil {
			t.Error(err)
		}
	})
	environmentAPI, err := candidateEnvironmentNativeAPI(t)
	if err != nil {
		t.Fatal(err)
	}
	environment, _, err := candidatePrepareEnvironment(primary.derived.token, environmentAPI)
	if err != nil {
		t.Fatal(err)
	}
	var reports [2]candidateAccessReport
	for i, lpac := range []bool{true, false} {
		name := "LPAC-reference"
		if !lpac {
			name = "ordinary-AC-reference"
		}
		if !t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			env, err := environment.target(dir)
			if err != nil {
				t.Fatal(err)
			}
			probe := candidateCopyProbe(t, dir)
			name, err := candidateNewProfileName()
			if err != nil {
				t.Fatal(err)
			}
			profile, createErr := candidateCreateProfile(name, profileAPI)
			var cleanup candidateProfileCleanup
			t.Cleanup(func() {
				if err := cleanup.closeProfile(profile); err != nil {
					t.Error(err)
				}
			})
			t.Cleanup(func() {
				if err := cleanup.closeObserved(); err != nil {
					t.Error("cleanup witness close failed")
				}
			})
			t.Logf("owned profile name=%s creation HRESULT=0x%08x created=%v", profile.name, profile.result, profile.created)
			if createErr != nil {
				t.Fatal(createErr)
			}
			checked, resumed := 0, 0
			var attributes []uintptr
			var diagnosticErr error
			var shapeReport candidateShapeReport
			var shapeErr error
			cmd := windowsHelperCommand(dir, "hold")
			cmd.Path, cmd.Args[0], cmd.Env = probe, probe, env
			cleanup.launchAttempted = true
			tr, startErr := startWindowsOwned(context.Background(), cmd, windowsLaunchHooks{
				primaryToken:    primary.derived.token,
				beforeAttribute: func(a uintptr) error { attributes = append(attributes, a); return nil },
				verify: candidateAccessVerify(inExactJob, func(process windows.Handle) error {
					return windows.DuplicateHandle(windows.CurrentProcess(), process, windows.CurrentProcess(), &cleanup.observed, windows.SYNCHRONIZE, false, 0)
				}, func(process windows.Handle) error {
					reports[i], diagnosticErr = candidateDiagnoseAccess(process, profile.sid, accessAPI)
					if diagnosticErr == nil && !reports[i].matches(lpac) {
						diagnosticErr = errors.New("reference semantic control mismatch")
					}
					shapeReport, shapeErr = candidateDiagnoseShape(primary.derived.token, process, shapeAPI)
					return errors.Join(diagnosticErr, shapeErr)
				}, &cleanup.cleanupErr),
				verification: dependencies,
				beforeResume: func(pi windows.ProcessInformation, job windows.Handle) error {
					checked++
					member, e := inExactJob(pi.Process, job)
					if e != nil {
						return e
					}
					if !member {
						return errors.New("reference exact membership refused")
					}
					event, e := windows.WaitForSingleObject(pi.Process, 0)
					if e != nil {
						return e
					}
					if event != uint32(windows.WAIT_TIMEOUT) {
						return errors.New("reference child not suspended/live")
					}
					return nil // production's TWO independent unconditional OFF stops remain
				},
				resume: func(windows.Handle) (uint32, error) { resumed++; return 0, errors.New("forbidden reference resume") },
			}, &windowsAppContainerPolicy{profileSID: profile.sid, lpac: lpac})
			if tr != nil {
				cleanup.cleanupErr = errors.Join(cleanup.cleanupErr, tr.Close())
			}
			if cleanup.observed != 0 {
				event, e := windows.WaitForSingleObject(cleanup.observed, 0)
				if e != nil || event != windows.WAIT_OBJECT_0 {
					cleanup.cleanupErr = errors.Join(cleanup.cleanupErr, errors.New("reference reap uncertain"), e)
				} else {
					cleanup.signaled = true
				}
				if e := cleanup.closeObserved(); e != nil {
					t.Error("reference cleanup witness close failed")
				}
			}
			candidateLogAccessReport(t, reports[i], diagnosticErr)
			candidateLogShapeReport(t, shapeReport, shapeErr)
			if cleanup.cleanupErr != nil || !cleanup.signaled || !cleanup.observedClosed || !reports[i].matches(lpac) || !shapeReport.complete || shapeErr != nil {
				t.Error("reference diagnostic/cleanup witness failed")
			}
			after, e := candidateInspectPrimary(primary.derived.token, primaryAPI.query)
			if e != nil {
				t.Fatal(e)
			}
			if e = candidateQualifyPrimary(after, primary.original, primary.ordinary); e != nil {
				t.Fatal(e)
			}
			if e = primary.witness(); e != nil {
				t.Fatal(e)
			}
			wantAttributes := []uintptr{procThreadAttributeSecurityCapabilities}
			if lpac {
				wantAttributes = append(wantAttributes, procThreadAttributeAllPackagesPolicy)
			}
			wantAttributes = append(wantAttributes, procThreadAttributeJobList, windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST)
			if len(attributes) != len(wantAttributes) {
				t.Fatal("reference attribute count refused")
			}
			for j, a := range attributes {
				if a != wantAttributes[j] {
					t.Fatal("reference attribute composition refused")
				}
			}
			if tr != nil || resumed != 0 || checked != 1 || startErr != errWindowsAppContainerExecutionDisabled {
				t.Fatalf("reference incomplete OFF gate: checked=%d resumed=%d err=%v", checked, resumed, startErr)
			}
			if _, e := os.Stat(filepath.Join(dir, "hold.started")); !os.IsNotExist(e) {
				t.Error("reference unexpectedly made a marker")
			}
		}) {
			return
		}
	}
	if !reports[0].matches(true) || !reports[1].matches(false) || reports[0].checks[1].allowed == reports[1].checks[1].allowed {
		t.Fatal("paired semantic differential absent (no verification authority)")
	}
}
