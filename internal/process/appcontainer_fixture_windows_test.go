//go:build windows

package process

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Test-only, never a runtime profile manager. No lookup, reuse, scan, recovery,
// ACL changes, loopback exemptions, or execution of the suspended target.
const candidateProfilePrefix = "pi-local-ci-v05-"
const candidateProfileAlreadyExists uint32 = 0x800700b7 // HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)

type candidateProfileAPI struct {
	create func(*uint16, **windows.SID) uint32
	delete func(*uint16) uint32
	free   func(*windows.SID) error
}

func candidateNativeProfileAPI(t *testing.T) (candidateProfileAPI, error) {
	t.Helper()
	candidateRequireEphemeralWindowsCI(t)
	// SystemDLL prevents PATH/current-directory DLL resolution. Call results are
	// HRESULTs (low 32 bits), NOT BOOLs or syscall's unrelated GetLastError.
	dll := windows.NewLazySystemDLL("userenv.dll")
	create := dll.NewProc("CreateAppContainerProfile")
	remove := dll.NewProc("DeleteAppContainerProfile")
	if err := create.Find(); err != nil {
		return candidateProfileAPI{}, err
	}
	if err := remove.Find(); err != nil {
		return candidateProfileAPI{}, err
	}
	return candidateProfileAPI{
		create: func(name *uint16, sid **windows.SID) uint32 {
			r, _, _ := create.Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(name)), 0, 0, uintptr(unsafe.Pointer(sid)))
			runtime.KeepAlive(name)
			runtime.KeepAlive(sid)
			return uint32(r)
		},
		delete: func(name *uint16) uint32 {
			r, _, _ := remove.Call(uintptr(unsafe.Pointer(name)))
			runtime.KeepAlive(name)
			return uint32(r)
		},
		free: windows.FreeSid,
	}, nil
}

type candidateOwnedProfile struct {
	name    string
	result  uint32
	created bool // ONLY S_OK establishes deletion authority
	deleted bool
	sid     *windows.SID // independent Go storage, never FreeSid this copy
	api     candidateProfileAPI
}

func candidateNewProfileName() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	id[6], id[8] = id[6]&0x0f|0x40, id[8]&0x3f|0x80 // random UUID v4
	return fmt.Sprintf("%s%x-%x-%x-%x-%x", candidateProfilePrefix, id[:4], id[4:6], id[6:8], id[8:10], id[10:]), nil
}

func candidateCreateProfile(name string, api candidateProfileAPI) (*candidateOwnedProfile, error) {
	f := &candidateOwnedProfile{name: name, api: api}
	// Only our exact GUID-shaped namespace, not a caller's existing profile.
	suffix := strings.TrimPrefix(name, candidateProfilePrefix)
	if suffix == name || len(suffix) != 36 {
		return f, errors.New("invalid candidate profile name")
	}
	for i, c := range suffix {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return f, errors.New("invalid candidate profile GUID")
			}
		} else if !strings.ContainsRune("0123456789abcdef", c) {
			return f, errors.New("invalid candidate profile GUID")
		}
	}
	wide, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return f, err
	}
	var returned *windows.SID
	f.result = api.create(wide, &returned)
	f.created = f.result == 0 // S_OK, not merely SUCCEEDED(hr)
	if f.created {
		if returned == nil {
			err = errors.New("S_OK with nil profile SID")
		} else {
			f.sid, err = returned.Copy() // copy BEFORE FreeSid
		}
	} else if f.result == candidateProfileAlreadyExists {
		err = fmt.Errorf("refused existing profile %s: HRESULT 0x%08x; no deletion authority", name, f.result)
	} else {
		// Even a failure may have partially provisioned storage. Do not guess
		// ownership or delete a possibly foreign profile; surface uncertainty.
		err = fmt.Errorf("profile %s creation HRESULT 0x%08x: ownership/partial creation uncertain; no deletion attempted", name, f.result)
	}
	if returned != nil {
		err = errors.Join(err, api.free(returned))
	}
	return f, err // preserve exact name/outcome even on failure
}

func (f *candidateOwnedProfile) close() error {
	if !f.created || f.deleted {
		return nil
	}
	wide, err := windows.UTF16PtrFromString(f.name)
	if err != nil {
		return err
	}
	if hr := f.api.delete(wide); hr != 0 {
		return fmt.Errorf("delete owned profile %s: HRESULT 0x%08x (created HRESULT 0x%08x)", f.name, hr, f.result)
	}
	f.deleted = true
	return nil
}

// A synchronous launch error is not evidence that native failure cleanup worked.
// After any attempt, deletion needs our own signaled-and-closed handle witness.
type candidateProfileCleanup struct {
	launchAttempted bool
	observed        windows.Handle
	signaled        bool
	observedClosed  bool
	cleanupErr      error // sticky: a later successful close cannot erase uncertainty
}

func (c *candidateProfileCleanup) closeObserved() error {
	if c.observed == 0 {
		return nil // lack of a handle is NOT a close or reap witness
	}
	if err := windows.CloseHandle(c.observed); err != nil {
		c.cleanupErr = errors.Join(c.cleanupErr, err)
		return err
	}
	c.observed, c.observedClosed = 0, true
	return nil
}

func (c *candidateProfileCleanup) closeProfile(f *candidateOwnedProfile) error {
	if !f.created || f.deleted {
		return nil // never acquire authority over an existing/uncertain profile
	}
	if c.launchAttempted && (!c.signaled || !c.observedClosed || c.observed != 0 || c.cleanupErr != nil) {
		return fmt.Errorf("owned profile %s NOT deleted: child reap/duplicate close uncertain (signaled=%v closed=%v): %w", f.name, c.signaled, c.observedClosed, errors.Join(errors.New("launch cleanup uncertainty"), c.cleanupErr))
	}
	return f.close()
}

func TestWindowsAppContainerProfileCleanupGuard(t *testing.T) {
	cleanupErr := errors.New("injected cleanup failure")
	for _, tc := range []struct {
		name       string
		guard      candidateProfileCleanup
		hr         uint32
		wantError  bool
		wantDelete bool
	}{
		{name: "token-failure-no-handle", guard: candidateProfileCleanup{launchAttempted: true}, wantError: true},
		{name: "duplicate-failure-no-handle", guard: candidateProfileCleanup{launchAttempted: true}, wantError: true},
		{name: "closed-without-wait", guard: candidateProfileCleanup{launchAttempted: true, observedClosed: true}, wantError: true},
		{name: "signaled-but-unclosed", guard: candidateProfileCleanup{launchAttempted: true, observed: 123, signaled: true}, wantError: true},
		{name: "witness-and-closed", guard: candidateProfileCleanup{launchAttempted: true, signaled: true, observedClosed: true}, wantDelete: true},
		{name: "earlier-cleanup-failure-stays-uncertain", guard: candidateProfileCleanup{launchAttempted: true, signaled: true, observedClosed: true, cleanupErr: cleanupErr}, wantError: true},
		{name: "no-attempt-created", wantDelete: true},
		{name: "existing", hr: candidateProfileAlreadyExists},
		{name: "uncertain-creation", hr: 0x80070005},
		{name: "ambiguous-success", hr: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			name := candidateProfilePrefix + "00000000-0000-4000-8000-000000000001"
			deletes := 0
			f, _ := candidateCreateProfile(name, candidateProfileAPI{
				create: func(*uint16, **windows.SID) uint32 { return tc.hr }, // nil SID: provisioning failed before launch
				delete: func(n *uint16) uint32 {
					deletes++
					if windows.UTF16PtrToString(n) != name {
						t.Fatal("deleted a different profile")
					}
					return 0
				},
			})
			for repeat := 0; repeat < 2; repeat++ {
				if tc.guard.observed == 0 {
					// Exercise the actual emergency no-handle path: it must not
					// fabricate either witness or erase earlier cleanup errors.
					if err := tc.guard.closeObserved(); err != nil {
						t.Fatal(err)
					}
				}
				err := tc.guard.closeProfile(f)
				if (err != nil) != tc.wantError {
					t.Fatalf("cleanup error=%v wantError=%v", err, tc.wantError)
				}
				if tc.wantError && (!strings.Contains(err.Error(), name) || !strings.Contains(err.Error(), "uncertain")) {
					t.Fatalf("missing exact name/uncertainty: %v", err)
				}
				if tc.guard.cleanupErr != nil && !errors.Is(err, cleanupErr) {
					t.Fatalf("lost earlier cleanup failure: %v", err)
				}
			}
			wantDeletes := 0
			if tc.wantDelete {
				wantDeletes = 1
			}
			if deletes != wantDeletes {
				t.Fatalf("delete calls=%d want=%d", deletes, wantDeletes)
			}
		})
	}
}

func TestWindowsAppContainerProfileOwnership(t *testing.T) {
	for _, tc := range []struct {
		name                               string
		hr                                 uint32
		nilSID, freeFailure, deleteFailure bool
	}{
		{name: "created"},
		{name: "collision", hr: candidateProfileAlreadyExists},
		{name: "denied-uncertain", hr: 0x80070005},
		{name: "unexpected-success-uncertain", hr: 1},
		{name: "nil-sid", nilSID: true},
		{name: "free-failure", freeFailure: true},
		{name: "delete-failure", deleteFailure: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			name, err := candidateNewProfileName()
			if err != nil {
				t.Fatal(err)
			}
			original := candidatePolicy(t, true).profileSID
			creates, frees, deletes := 0, 0, 0
			freeErr := errors.New("injected FreeSid failure")
			api := candidateProfileAPI{
				create: func(n *uint16, out **windows.SID) uint32 {
					creates++
					if windows.UTF16PtrToString(n) != name || *out != nil {
						t.Fatal("wrong name or non-null initial SID")
					}
					if tc.hr == 0 && !tc.nilSID {
						*out = original
					}
					return tc.hr
				},
				free: func(sid *windows.SID) error {
					frees++
					if sid != original {
						t.Fatal("freed wrong allocation")
					}
					// Destroy fake returned storage; the retained SID must survive.
					clear(unsafe.Slice((*byte)(unsafe.Pointer(sid)), sid.Len()))
					if tc.freeFailure {
						return freeErr
					}
					return nil
				},
				delete: func(n *uint16) uint32 {
					deletes++
					if windows.UTF16PtrToString(n) != name {
						t.Fatal("deleted a different profile")
					}
					if tc.deleteFailure {
						return 0x80070005
					}
					return 0
				},
			}
			f, err := candidateCreateProfile(name, api)
			wantFailure := tc.hr != 0 || tc.nilSID || tc.freeFailure
			if (err != nil) != wantFailure || f.created != (tc.hr == 0) || f.name != name || f.result != tc.hr || creates != 1 {
				t.Fatalf("ownership/result: fixture=%+v err=%v", f, err)
			}
			if tc.hr != 0 && !strings.Contains(err.Error(), "no deletion") {
				t.Fatalf("missing uncertainty/refusal: %v", err)
			}
			if tc.freeFailure && !errors.Is(err, freeErr) {
				t.Fatal("lost FreeSid error")
			}
			wantFrees := 0
			if tc.hr == 0 && !tc.nilSID {
				wantFrees = 1
				if f.sid == original || f.sid.String() != candidateSyntheticSID {
					t.Fatal("SID copy did not survive FreeSid")
				}
			}
			if frees != wantFrees {
				t.Fatalf("FreeSid calls=%d want=%d", frees, wantFrees)
			}
			var cleanup candidateProfileCleanup // provisioning failures precede any launch
			if err := cleanup.closeProfile(f); (err != nil) != tc.deleteFailure {
				t.Fatalf("cleanup failure not surfaced: %v", err)
			}
			wantDeletes := 0
			if tc.hr == 0 {
				wantDeletes = 1
			}
			if deletes != wantDeletes {
				t.Fatalf("delete calls=%d want=%d", deletes, wantDeletes)
			}
			if !tc.deleteFailure {
				if err := cleanup.closeProfile(f); err != nil || deletes != wantDeletes {
					t.Fatal("cleanup was not idempotent")
				}
			}
		})
	}
}

func TestWindowsAppContainerProfileRejectsForeignNames(t *testing.T) {
	api := candidateProfileAPI{
		create: func(*uint16, **windows.SID) uint32 { t.Fatal("invalid name reached Create"); return 0 },
		delete: func(*uint16) uint32 { t.Fatal("invalid name reached Delete"); return 0 },
		free:   func(*windows.SID) error { t.Fatal("invalid name reached FreeSid"); return nil },
	}
	for _, name := range []string{"", "existing-user-profile", candidateProfilePrefix + "..", candidateProfilePrefix + "00000000-0000-0000-0000-00000000000z"} {
		f, err := candidateCreateProfile(name, api)
		if err == nil || f.created {
			t.Fatalf("accepted invalid/foreign name %q", name)
		}
		if err := f.close(); err != nil {
			t.Fatal(err)
		}
	}
}

// Never provision profiles on a developer machine. Native execution is limited
// to GitHub-hosted ephemeral Windows CI; this is not an elevation/Win11 proof.
func candidateRequireEphemeralWindowsCI(t *testing.T) {
	t.Helper()
	if os.Getenv("GITHUB_ACTIONS") != "true" || os.Getenv("RUNNER_ENVIRONMENT") != "github-hosted" || os.Getenv("RUNNER_OS") != "Windows" {
		t.Skip("owned-profile API fixture requires ephemeral GitHub-hosted Windows CI")
	}
}

func candidateCopyProbe(t *testing.T, dir string) string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("probe requires a fresh blank fixture: entries=%d err=%v", len(entries), err)
	}
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	in, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "owned-probe.exe")
	out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		_ = in.Close()
		t.Fatal(err)
	}
	_, copyErr := io.Copy(out, in)
	if err := errors.Join(copyErr, in.Close(), out.Close()); err != nil {
		t.Fatal(err)
	}
	// Inspect ONLY the fresh fixture, never grant ACLs on the original image or
	// its ancestors. No recursive permissions or executable runtime fallback.
	for _, item := range []string{dir, path} {
		wide, err := windows.UTF16PtrFromString(item)
		if err != nil {
			t.Fatal(err)
		}
		h, err := windows.CreateFile(wide, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if err != nil {
			t.Fatal(err)
		}
		var info windows.ByHandleFileInformation
		infoErr := windows.GetFileInformationByHandle(h, &info)
		var fs [32]uint16
		volumeErr := windows.GetVolumeInformationByHandle(h, nil, 0, nil, nil, nil, &fs[0], uint32(len(fs)))
		closeErr := windows.CloseHandle(h)
		if err := errors.Join(infoErr, volumeErr, closeErr); err != nil {
			t.Fatal(err)
		}
		if windows.UTF16ToString(fs[:]) != "NTFS" || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			t.Fatal("fixture must be NTFS and not a reparse point")
		}
		if item == path && (info.NumberOfLinks != 1 || info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) {
			t.Fatal("copied probe must be a single-link regular file")
		}
	}
	return path
}

func TestWindowsAppContainerOwnedLPACSuspended(t *testing.T) {
	api, err := candidateNativeProfileAPI(t)
	if err != nil {
		t.Fatal(err)
	}
	// Bounded repeated profile/create/refuse/reap/delete lifetime, not a full
	// restricted-launch handle-growth measurement (that remains a future gate).
	for iteration := 0; iteration < 3; iteration++ {
		for _, mode := range []string{"hard-stop", "cancel", "injected-failure"} {
			t.Run(fmt.Sprintf("%d/%s", iteration, mode), func(t *testing.T) {
				dir := t.TempDir() // blank, owned, no existing trees or user files
				probe := candidateCopyProbe(t, dir)
				name, err := candidateNewProfileName()
				if err != nil {
					t.Fatal(err)
				}
				profile, createErr := candidateCreateProfile(name, api)
				var cleanup candidateProfileCleanup // no attempt and no postlaunch witness yet
				// Registered BEFORE any process exists. An early launch failure can
				// leave no duplicate: preserve/report the profile, never infer reap.
				t.Cleanup(func() {
					if err := cleanup.closeProfile(profile); err != nil {
						t.Error(err)
					}
				})
				t.Logf("owned profile name=%s creation HRESULT=0x%08x created=%v", profile.name, profile.result, profile.created)
				if createErr != nil {
					t.Fatal(createErr)
				}
				t.Cleanup(func() {
					// LIFO emergency close never supplies a missing WAIT witness or
					// clears a previous cleanup error, even if this retry succeeds.
					if err := cleanup.closeObserved(); err != nil {
						t.Error(err)
					}
				})
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				checked, resumed := 0, 0
				injected := errors.New("injected failure after REAL token/job verification")
				forbiddenResume := errors.New("FATAL: candidate attempted ResumeThread")
				cmd := windowsHelperCommand(dir, "hold")
				cmd.Path, cmd.Args[0] = probe, probe
				cleanup.launchAttempted = true
				tr, startErr := startWindowsOwned(ctx, cmd, windowsLaunchHooks{
					// verify and tokenInformation deliberately nil: REAL APIs.
					beforeResume: func(pi windows.ProcessInformation, job windows.Handle) error {
						checked++ // reached ONLY after real exact-job + token gates
						member, err := inExactJob(pi.Process, job)
						if err != nil || !member {
							return fmt.Errorf("exact owned job: member=%v err=%v", member, err)
						}
						if event, err := windows.WaitForSingleObject(pi.Process, 0); err != nil || event != uint32(windows.WAIT_TIMEOUT) {
							return fmt.Errorf("suspended child not live: event=%d err=%v", event, err)
						}
						if err := windows.DuplicateHandle(windows.CurrentProcess(), pi.Process, windows.CurrentProcess(), &cleanup.observed, windows.SYNCHRONIZE, false, 0); err != nil {
							cleanup.cleanupErr = errors.Join(cleanup.cleanupErr, err)
							return err
						}
						switch mode {
						case "cancel":
							cancel()
						case "injected-failure":
							return injected
						}
						return nil
					},
					resume: func(windows.Handle) (uint32, error) {
						resumed++
						return 0, forbiddenResume // never actually resume, even on regression
					},
				}, &windowsAppContainerPolicy{profileSID: profile.sid, lpac: true})
				if tr != nil {
					if err := tr.Close(); err != nil {
						cleanup.cleanupErr = errors.Join(cleanup.cleanupErr, err)
						t.Error(err)
					}
				}
				// Check reap BEFORE asserting launch result, including failed cases.
				if cleanup.observed != 0 {
					if event, err := windows.WaitForSingleObject(cleanup.observed, 0); err != nil || event != windows.WAIT_OBJECT_0 {
						waitErr := fmt.Errorf("hard-stop/cancel/failure did not reap: event=%d err=%v", event, err)
						cleanup.cleanupErr = errors.Join(cleanup.cleanupErr, waitErr)
						t.Error(waitErr)
					} else {
						cleanup.signaled = true // only this retained-handle WAIT is evidence
					}
					if err := cleanup.closeObserved(); err != nil {
						t.Error(err)
					}
				}
				want := errWindowsAppContainerExecutionDisabled
				if mode == "cancel" {
					want = context.Canceled
				} else if mode == "injected-failure" {
					want = injected
				}
				if tr != nil || checked != 1 || resumed != 0 || startErr != want {
					t.Fatalf("REAL LPAC gate: tree=%v verified=%d resumed=%d err=%v want exact %v (creation/ACL/unsupported errors are NOT success)", tr, checked, resumed, startErr, want)
				}
				// Supplemental only: lack of write permission could also prevent a
				// marker. The counted gate + exact error + no resume + reap prove it.
				if _, err := os.Stat(filepath.Join(dir, "hold.started")); !os.IsNotExist(err) {
					t.Fatalf("unexpected helper marker: %v", err)
				}
			})
		}
	}
}
