//go:build windows

package process

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The existing +8 budget is NOT increased. After identical-path warmup it
// allows one late Go M (thread, two events, two timers, wait-completion packet)
// plus one IOCP initialization and one handle of observation jitter. It is a TOTAL budget,
// not per launch/batch: a single leaked handle per launch exceeds it within ten
// launches. Process/Job/File counts additionally have no growth allowance.
const windowsHandleGrowthBudget = 8

// Test diagnostics query only this synthetic test process, never system-wide
// handle tables or object names/paths. No handles are duplicated or closed by
// the sampler. NT queries are bounded and optional diagnostics, not a reason to
// skip the GetProcessHandleCount gate if runner policy disallows introspection.
// Layout: PROCESS_HANDLE_TABLE_ENTRY_INFO / PROCESS_HANDLE_SNAPSHOT_INFORMATION,
// https://github.com/winsiderss/phnt/blob/master/ntpsapi.h (diagnostics only).
type handleSnapshotEntry struct {
	Handle, HandleCount, PointerCount       uintptr
	Access, TypeIndex, Attributes, Reserved uint32
}

var queryObjectTypeProc = windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryObject")

func selfHandleTypes() (map[string]int, error) {
	const maxBytes = 1 << 20
	word := int(unsafe.Sizeof(uintptr(0)))
	size := 16 << 10
	for attempt := 0; attempt < 3; attempt++ {
		buffer := make([]uintptr, (size+word-1)/word)
		var needed uint32
		err := windows.NtQueryInformationProcess(windows.CurrentProcess(), windows.ProcessHandleInformation, unsafe.Pointer(&buffer[0]), uint32(len(buffer)*word), &needed)
		if err != nil {
			if (errors.Is(err, windows.STATUS_INFO_LENGTH_MISMATCH) || errors.Is(err, windows.STATUS_BUFFER_TOO_SMALL)) && needed <= maxBytes {
				size = max(size*2, int(needed))
				if size > maxBytes {
					break
				}
				continue
			}
			return nil, fmt.Errorf("self ProcessHandleInformation: %w", err)
		}
		count := buffer[0]
		entrySize := unsafe.Sizeof(handleSnapshotEntry{})
		available := uintptr(len(buffer)*word - 2*word)
		if count > available/entrySize {
			return nil, errors.New("self handle snapshot exceeds bounded buffer")
		}
		entries := unsafe.Slice((*handleSnapshotEntry)(unsafe.Pointer(&buffer[2])), int(count))
		names := map[uint32]string{}
		// Query type only (ObjectTypeInformation=2), never ObjectNameInformation:
		// object-name queries can block on arbitrary files. Limit type queries too.
		queries := 0
		for _, entry := range entries {
			if _, ok := names[entry.TypeIndex]; ok {
				continue
			}
			if queries >= 128 {
				break
			}
			queries++
			name, err := selfObjectType(windows.Handle(entry.Handle))
			if err == nil {
				names[entry.TypeIndex] = name
			}
		}
		types := map[string]int{}
		complete := true
		for _, entry := range entries {
			name := names[entry.TypeIndex]
			if name == "" {
				complete = false
				name = fmt.Sprintf("unresolved-type-%d", entry.TypeIndex)
			}
			types[name]++
		}
		runtime.KeepAlive(buffer)
		if !complete {
			// Do not confuse a newly resolved type with actual handle growth.
			// Retain partial counts in diagnostics; use the mandatory count gate.
			return nil, fmt.Errorf("self object types incomplete (policy/racing handles): %v", types)
		}
		return types, nil
	}
	return nil, errors.New("self handle snapshot did not fit bounded retries")
}

func selfObjectType(handle windows.Handle) (string, error) {
	if err := queryObjectTypeProc.Find(); err != nil {
		return "", err
	}
	buffer := make([]uintptr, 128) // aligned, <= 1 KiB on reviewed 64-bit targets
	var needed uint32
	status, _, _ := queryObjectTypeProc.Call(uintptr(handle), 2, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer))*unsafe.Sizeof(buffer[0]), uintptr(unsafe.Pointer(&needed)))
	if uint32(status) != 0 {
		return "", windows.NTStatus(uint32(status))
	}
	name := (*windows.NTUnicodeString)(unsafe.Pointer(&buffer[0]))
	start := uintptr(unsafe.Pointer(&buffer[0]))
	end := start + uintptr(len(buffer))*unsafe.Sizeof(buffer[0])
	p := uintptr(unsafe.Pointer(name.Buffer))
	if name.Length == 0 || name.Length%2 != 0 || p < start || p > end || uintptr(name.Length) > end-p {
		return "", errors.New("invalid bounded type name")
	}
	result := windows.UTF16ToString(unsafe.Slice(name.Buffer, int(name.Length)/2))
	runtime.KeepAlive(buffer)
	return result, nil
}

type nativeResourceSample struct {
	Handles               int
	Types                 map[string]int
	GoThreads, Goroutines int
	GC                    uint32
}

func sampleNativeResources(t *testing.T, label string) nativeResourceSample {
	t.Helper()
	types, err := selfHandleTypes()
	if err != nil {
		t.Logf("%s: handle-type diagnostics unavailable (count gate still enforced): %v", label, err)
	}
	threads, _ := runtime.ThreadCreateProfile(nil)
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem) // Observe automatic GC; NEVER force GC/finalizers.
	sample := nativeResourceSample{int(nativeHandleCount(t)), types, threads, runtime.NumGoroutine(), mem.NumGC}
	t.Logf("%s: handles=%d GoThreads=%d goroutines=%d automaticGC=%d types=%v", label, sample.Handles, sample.GoThreads, sample.Goroutines, sample.GC, sample.Types)
	return sample
}
func handleGrowthError(base nativeResourceSample, samples []nativeResourceSample) error {
	for i, s := range samples {
		if s.Handles-base.Handles > windowsHandleGrowthBudget {
			return fmt.Errorf("sample %d total handle growth %d exceeds unchanged budget %d", i+1, s.Handles-base.Handles, windowsHandleGrowthBudget)
		}
		if s.GC != base.GC {
			return fmt.Errorf("sample %d GC count changed %d -> %d: finalizer repair cannot be ruled out", i+1, base.GC, s.GC)
		}
		if base.Types != nil && s.Types != nil {
			for _, kind := range []string{"Process", "Job", "File"} {
				if s.Types[kind] > base.Types[kind] {
					return fmt.Errorf("sample %d %s handle growth %d (no allowance)", i+1, kind, s.Types[kind]-base.Types[kind])
				}
			}
		}
	}
	return nil
}

func handleCleanupLaunch(t *testing.T, dir string, fail bool) {
	t.Helper()
	mode := "null"
	if fail {
		mode = "never"
	}
	cmd := windowsHelperCommand(dir, mode)
	// EXACT same pipe/IOCP preparation for warmup, success, failure, mixed phases.
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	hooks := windowsLaunchHooks{}
	injected := errors.New("injected suspended launch failure")
	if fail {
		hooks.beforeResume = func(windows.ProcessInformation, windows.Handle) error { return injected }
	}
	tr, err := startWindows(context.Background(), cmd, hooks)
	if fail {
		if tr != nil {
			_ = tr.Close()
			t.Fatal("failure injection returned a tree")
		}
		if !errors.Is(err, injected) {
			t.Fatalf("failure did not reach suspended gate: %v", err)
		}
		if _, err := os.Stat(filepath.Join(dir, "never.started")); !os.IsNotExist(err) {
			t.Fatal("failure helper executed")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	// Ensure cleanup still runs on an assertion failure; successful Close below
	// must explicitly release resources, never rely on a Go finalizer.
	defer tr.Close()
	if err := waitNativeTree(t, tr); err != nil {
		t.Fatal(err)
	}
	if err := tr.Close(); err != nil {
		t.Fatal(err)
	}
	native := tr.(*windowsTree)
	for _, file := range append(append([]*os.File{}, native.streams.ownedChild...), native.streams.parent...) {
		if file.Fd() != ^uintptr(0) {
			t.Fatal("explicit native cleanup retained an owned stdio endpoint")
		}
	}
}

func TestWindowsHandleCleanup(t *testing.T) {
	// Prevent finalizers from concealing lost os.File ownership. This is a bounded,
	// non-parallel test; restore GC configuration afterward, NEVER force a GC.
	oldGC := debug.SetGCPercent(-1)
	defer debug.SetGCPercent(oldGC)
	dir := t.TempDir()
	sampleNativeResources(t, "cold")
	for batch := 0; batch < 3; batch++ {
		for i := 0; i < 10; i++ {
			handleCleanupLaunch(t, dir, false)
			handleCleanupLaunch(t, dir, true)
		}
		sampleNativeResources(t, fmt.Sprintf("same-path warmup %d/30 success + failure", (batch+1)*10))
	}
	baseline := sampleNativeResources(t, "fully warmed baseline")
	all := []nativeResourceSample{}
	for _, phase := range []string{"success", "failure", "mixed"} {
		phaseBase := sampleNativeResources(t, phase+" baseline")
		phaseSamples := []nativeResourceSample{}
		for batch := 0; batch < 3; batch++ {
			for i := 0; i < 10; i++ {
				if phase != "failure" {
					handleCleanupLaunch(t, dir, false)
				}
				if phase != "success" {
					handleCleanupLaunch(t, dir, true)
				}
			}
			s := sampleNativeResources(t, fmt.Sprintf("%s batch %d/3 (10 launches per path)", phase, batch+1))
			phaseSamples = append(phaseSamples, s)
			all = append(all, s)
		}
		// Every phase logs its full batch slope before evaluating the gate.
		if err := handleGrowthError(phaseBase, phaseSamples); err != nil {
			t.Errorf("%s: %v; baseline=%+v samples=%+v", phase, err, phaseBase, phaseSamples)
		}
	}
	if err := handleGrowthError(baseline, all); err != nil {
		t.Errorf("combined post-warmup growth: %v; baseline=%+v samples=%+v", err, baseline, all)
	}
}

func TestWindowsHandleGrowthDetectorNegativeControl(t *testing.T) {
	oldGC := debug.SetGCPercent(-1)
	defer debug.SetGCPercent(oldGC)
	// Retain real, NON-INHERITABLE events deliberately, then explicitly close all
	// of them. Proves that the actual counter + SAME detector rejects a one-handle
	// per-launch slope; no synthetic 'pass' or GC/finalizer repair is involved.
	events := []windows.Handle{}
	defer func() {
		for _, h := range events {
			if err := windows.CloseHandle(h); err != nil {
				t.Error(err)
			}
		}
	}()
	sampleNativeResources(t, "negative-control warmup")
	base := sampleNativeResources(t, "negative-control baseline")
	samples := []nativeResourceSample{}
	for batch := 0; batch < 3; batch++ {
		for i := 0; i < 10; i++ {
			h, err := windows.CreateEvent(nil, 1, 0, nil)
			if err != nil {
				t.Fatal(err)
			}
			events = append(events, h)
		}
		samples = append(samples, sampleNativeResources(t, fmt.Sprintf("deliberately retained events %d", len(events))))
	}
	if samples[len(samples)-1].Handles-base.Handles < 30 {
		t.Fatalf("negative control did not observe 30 retained handles: %+v -> %+v", base, samples[len(samples)-1])
	}
	if err := handleGrowthError(base, samples); err == nil {
		t.Fatal("growth detector accepted a deliberate per-launch native leak")
	} else {
		t.Logf("negative control correctly rejected: %v", err)
	}
}
