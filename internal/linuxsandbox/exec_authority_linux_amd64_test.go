//go:build linux && amd64

package linuxsandbox

import (
	"bytes"
	"context"
	"debug/elf"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// buildExecAuthorityProbe checks the static executable contract independently
// of bwrap admission, so fixture-only detector controls can run on native Linux.
func buildExecAuthorityProbe(t *testing.T, payload string, fdDiagnostics bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	args := []string{"-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
		"-ffreestanding", "-fno-builtin", "-fno-stack-protector", "-fno-pie", "-no-pie",
		"-nostdlib", "-static", "-Wl,-e,_start", "-Wl,--build-id=none",
		"-o", payload, "testdata/exec_authority_probe.c"}
	if fdDiagnostics {
		args = append(args, "-DEXEC_AUTHORITY_FD_DIAGNOSTICS=1")
	}
	cc := exec.CommandContext(ctx, "cc", args...)
	if _, err := cc.CombinedOutput(); err != nil {
		t.Fatal("runtime-free native fixture build failed (cc is required)")
	}
	image, err := elf.Open(payload)
	if err != nil {
		t.Fatal("native fixture is not ELF")
	}
	defer image.Close()
	if image.Machine != elf.EM_X86_64 || image.Type != elf.ET_EXEC || image.Class != elf.ELFCLASS64 {
		t.Fatal("wrong native fixture executable ABI")
	}
	for _, p := range image.Progs {
		if p.Type == elf.PT_INTERP || p.Type == elf.PT_DYNAMIC {
			t.Fatal("native fixture unexpectedly has loader/runtime startup")
		}
	}
	symbols, err := image.Symbols()
	if err != nil {
		t.Fatal("native fixture entry symbols unavailable")
	}
	entryFound := false
	for _, s := range symbols {
		if s.Name == "_start" && s.Value == image.Entry {
			entryFound = true
		}
	}
	if !entryFound {
		t.Fatal("native fixture does not enter at its raw-syscall _start")
	}
}

// These standalone controls never inspect PID 1. Only own synthetic descriptors
// are inspected. All native PID-1 memory probes retain namespace preconditions.
func TestExecAuthorityDetectorControls(t *testing.T) {
	if os.Getenv("PI_LOCAL_SANDBOX_NATIVE_TESTS") != "1" {
		t.Skip("native raw-syscall detector controls not opted in")
	}
	payload := filepath.Join(t.TempDir(), "exec-authority-probe")
	buildExecAuthorityProbe(t, payload, true)
	for _, control := range []struct {
		name, arg string
		inherited bool
		want      int
	}{
		{"no-inherited-fd", "", false, 14},
		{"low-inherited-fd", "", true, 12},
		{"high-fd-above-both-lowered-limits", "--high-fd-control", false, 12},
		{"known-stdio-only", "--self-stdio-control", false, 0},
		{"each-stdio-role-required", "--self-missing-stdio-control", false, 54},
		{"extra-synthetic-pipe", "--self-pipe-control", false, 49},
		{"extra-synthetic-eventfd", "--self-eventfd-control", false, 49},
	} {
		t.Run(control.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var args []string
			if control.arg != "" {
				args = append(args, control.arg)
			}
			cmd := exec.CommandContext(ctx, payload, args...)
			// Explicit supplied authority: null stdin/stderr, one stdout pipe.
			var stdout bytes.Buffer
			cmd.Stdout = &stdout
			if control.inherited {
				file, err := os.Open(os.DevNull)
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
				cmd.ExtraFiles = []*os.File{file}
			}
			err := cmd.Run()
			code := 0
			if err != nil {
				exit, ok := err.(*exec.ExitError)
				if !ok {
					t.Fatalf("control execution failed: %v", err)
				}
				code = exit.ExitCode()
			}
			diagnostic, diagnosticErr := decodeExecAuthorityFDDiagnostic(stdout.Bytes())
			if code != control.want {
				// Never dump arbitrary subprocess output, even on decode failure.
				t.Fatalf("same detector: got assertion %d (%s), want %d; %s",
					code, execAuthorityAssertion(code), control.want, diagnostic.summary(diagnosticErr))
			}
			if code == 12 {
				if diagnosticErr != nil {
					t.Fatal("inherited-FD rejection lacks valid bounded diagnostic")
				}
				stage, fd := uint64(1), uint64(3)
				if control.arg == "--high-fd-control" {
					stage, fd = 2, 100
				}
				if diagnostic.stage != stage || diagnostic.fd != fd || diagnostic.flags != 0 ||
					diagnostic.fileType != 0020000 || diagnostic.statResult != 0 {
					t.Fatalf("negative control did not reach its intended detector path: %s", diagnostic.summary(nil))
				}
			} else if stdout.Len() != 0 {
				t.Fatal("standalone control produced unexpected output")
			}
		})
	}
}

// A shell/Go target cannot establish the exec-entry FD invariant: startup may
// open its own FDs or silently close inherited ones before the test gets control.
func TestNativeExecEntryAuthority(t *testing.T) {
	f := nativeSetup(t)
	payload := filepath.Join(f.p.Workspace, "exec-authority-probe")
	buildExecAuthorityProbe(t, payload, false)

	// Seed unrelated non-CLOEXEC input descriptors in the outer driver. These
	// belong ONLY to this disposable fixture. Inode identities, never secret
	// contents, are passed to the probe; diagnostics never print either.
	marker := filepath.Join(f.p.Home, ".ssh", "exec-entry-marker")
	if err := os.WriteFile(marker, []byte("fixture-only-exec-entry-secret"), 0600); err != nil {
		t.Fatal("fixture marker creation failed")
	}
	file, err := os.Open(marker)
	if err != nil {
		t.Fatal("fixture marker open failed")
	}
	defer file.Close()
	dir, err := os.Open(f.p.Home)
	if err != nil {
		t.Fatal("fixture original directory open failed")
	}
	defer dir.Close()
	fd, err := sealed("fixture-only-exec-entry-secret", []byte("fixture-only-sealed-secret"))
	if err != nil {
		t.Fatal("fixture secret memfd creation failed")
	}
	mem := os.NewFile(uintptr(fd), "fixture-only-memfd")
	defer mem.Close()
	files := []*os.File{file, dir, mem}
	// Negative control: the exact entry probe MUST notice a deliberately
	// inherited fixture FD. No argv is supplied, so even a broken FD scan must
	// fail its argument precondition before inspecting proc/PID 1 on the host.
	controlCtx, controlCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer controlCancel()
	control := exec.CommandContext(controlCtx, payload)
	control.ExtraFiles = files
	controlErr := control.Run()
	if exit, ok := controlErr.(*exec.ExitError); !ok || exit.ExitCode() != 12 {
		t.Fatal("exec-entry FD negative control did not reject an inherited fixture descriptor")
	}
	argv := []string{payload}
	for _, file := range files {
		var st unix.Stat_t
		if err := unix.Fstat(int(file.Fd()), &st); err != nil {
			t.Fatal("fixture marker identity unavailable")
		}
		argv = append(argv, strconv.FormatUint(uint64(st.Dev), 10), strconv.FormatUint(st.Ino, 10))
	}
	var hostPIDNamespace unix.Stat_t
	if err := unix.Stat("/proc/self/ns/pid", &hostPIDNamespace); err != nil {
		t.Fatal("fixture host PID namespace identity unavailable")
	}
	argv = append(argv, strconv.FormatUint(uint64(hostPIDNamespace.Dev), 10), strconv.FormatUint(hostPIDNamespace.Ino, 10))
	runCtx, runCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer runCancel()
	cmd := f.command(runCtx, argv...)
	cmd.ExtraFiles = files
	var success bytes.Buffer
	cmd.Stdout = &success
	// Deliberately discard all subprocess diagnostics. Fixed assertion codes
	// below are sufficient; even a broken candidate must not dump secret data.
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			t.Fatalf("exec-entry authority gate: assertion %d (%s)", exit.ExitCode(), execAuthorityAssertion(exit.ExitCode()))
		}
		t.Fatal("exec-entry authority fixture did not complete")
	}
	if success.String() != "exec-authority-ok\n" {
		t.Fatal("exec-entry authority fixture did not provide its success marker")
	}
}

func execAuthorityAssertion(code int) string {
	return map[int]string{
		10: "getrlimit unavailable", 11: "FD limit outside bounded initial scan",
		12: "inherited FD at exec entry", 13: "unexpected F_GETFD result",
		14: "invalid fixture arguments", 15: "invalid fixture identity", 16: "fixture path bound",
		17: "PID namespace identity unavailable", 18: "proc does not name the fixture PID namespace",
		19: "target is not a direct child of fixture PID 1",
		20: "PID 1 memory writable", 21: "PID 1 memory read/write open succeeded",
		22: "memory denial was not an authority denial",
		30: "PID 1 task listing unavailable", 31: "PID 1 task listing bound or read failure",
		32: "invalid proc dirent", 33: "invalid task name", 34: "no PID 1 tasks inspected",
		35: "PID 1 task memory writable", 36: "PID 1 task memory read/write open succeeded",
		40: "PID 1 descriptors unavailable", 41: "PID 1 FD listing bound or read failure",
		42: "invalid descriptor name", 43: "PID 1 FD link unavailable",
		44: "fixture secret file retained by PID 1", 45: "fixture original directory retained by PID 1",
		46: "fixture secret memfd retained by PID 1", 47: "handoff memfd retained by PID 1",
		48: "directory authority retained by PID 1", 49: "unrecognized authority retained by PID 1",
		50: "PID 1 FD identity unavailable", 51: "invalid pipe identity",
		53: "invalid null device identity",
		54: "PID 1 stdio not inspected", 55: "success marker write failed",
		56: "self FD enumeration unavailable", 57: "self FD enumeration bound or read failure",
		58: "supplied stdio unavailable", 59: "PID 1 stdio differs from supplied fixture authority",
		60: "high-FD lowered-limit control setup failed", 61: "synthetic endpoint control setup failed",
		125: "candidate setup refused",
	}[code]
}
