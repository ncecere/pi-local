//go:build windows

package process

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func setWindowsStdio(cmd *exec.Cmd, index int, file *os.File) {
	switch index {
	case 0:
		cmd.Stdin = file
	case 1:
		cmd.Stdout = file
	case 2:
		cmd.Stderr = file
	default:
		panic("invalid synthetic stdio index")
	}
}

// The duplication spy never calls DuplicateHandle: even if validation regresses,
// this test cannot accidentally promote -1 into an inheritable process handle.
func assertWindowsStdioRefused(t *testing.T, dir string, index int, file *os.File, fileType func(windows.Handle) (uint32, error)) {
	t.Helper()
	cmd := windowsHelperCommand(dir, "must-not-run")
	setWindowsStdio(cmd, index, file)
	duplicates, resumed := 0, false
	tr, err := startWindows(context.Background(), cmd, windowsLaunchHooks{
		fileType: fileType,
		duplicateStdio: func(windows.Handle) (windows.Handle, error) {
			duplicates++
			return 0, errors.New("unexpected stdio duplication")
		},
		beforeResume: func(windows.ProcessInformation, windows.Handle) error {
			resumed = true
			return errors.New("invalid stdio reached suspended child")
		},
	})
	if tr != nil {
		_ = tr.Close()
		t.Fatal("invalid stdio created a tree")
	}
	if err == nil || duplicates != 0 || resumed {
		t.Fatalf("stdio validation did not precede ALL duplication: err=%v duplicates=%d resumed=%v", err, duplicates, resumed)
	}
	if cmd.Process != nil || cmd.ProcessState != nil {
		t.Fatal("failed descriptor acquired exec process state")
	}
	if _, err := os.Stat(filepath.Join(dir, "must-not-run.started")); !os.IsNotExist(err) {
		t.Fatalf("invalid stdio executed synthetic helper: %v", err)
	}
}

func TestWindowsClosedStdioNeverDuplicatedOrExecuted(t *testing.T) {
	for index, name := range []string{"stdin", "stdout", "stderr"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			file, err := os.CreateTemp(dir, "closed-stdio-")
			if err != nil {
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
			if file.Fd() != ^uintptr(0) {
				t.Fatal("closed File does not expose invalid sentinel")
			}
			// Warm up attribute/job machinery before measuring repeat failures.
			assertWindowsStdioRefused(t, dir, index, file, nil)
			before := nativeHandleCount(t)
			for i := 0; i < 25; i++ {
				assertWindowsStdioRefused(t, dir, index, file, nil)
			}
			if after := nativeHandleCount(t); after > before+4 {
				t.Fatalf("closed stdio failure leaked handles: before=%d after=%d", before, after)
			}
		})
	}
}

func TestWindowsPseudoStdioHandlesNeverQueriedOrOwned(t *testing.T) {
	// Do NOT wrap pseudo-handles with os.NewFile: that would install an owning
	// finalizer. Scalar validation exercises the production guard without ever
	// owning, duplicating, closing or signalling a process/thread/token handle.
	for _, h := range []windows.Handle{0, windows.Handle(^uintptr(0)), windows.Handle(^uintptr(0) - 1), windows.Handle(^uintptr(0) - 2), windows.Handle(^uintptr(0) - 3), windows.Handle(^uintptr(0) - 4), windows.Handle(^uintptr(0) - 5)} {
		called := false
		err := validateWindowsStdioHandle(h, func(windows.Handle) (uint32, error) {
			called = true
			return windows.FILE_TYPE_DISK, nil
		})
		if err == nil || called {
			t.Fatalf("invalid/pseudo handle %#x reached GetFileType or was accepted: %v", h, err)
		}
	}
}

func TestWindowsStdioFileTypeFailuresNeverDuplicatedOrExecuted(t *testing.T) {
	for _, result := range []struct {
		name string
		kind uint32
		err  error
	}{
		{"unknown-success", windows.FILE_TYPE_UNKNOWN, nil},
		{"unknown-error", windows.FILE_TYPE_UNKNOWN, windows.ERROR_INVALID_HANDLE},
		{"known-with-error", windows.FILE_TYPE_DISK, windows.ERROR_ACCESS_DENIED},
		{"unsupported-flags", windows.FILE_TYPE_PIPE | 0x8000, nil},
	} {
		for index, name := range []string{"stdin", "stdout", "stderr"} {
			t.Run(result.name+"/"+name, func(t *testing.T) {
				dir := t.TempDir()
				file, err := os.CreateTemp(dir, "valid-file-")
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
				handle := windows.Handle(file.Fd())
				fileType := func(h windows.Handle) (uint32, error) {
					if h == handle {
						return result.kind, result.err
					}
					return windows.GetFileType(h)
				}
				assertWindowsStdioRefused(t, dir, index, file, fileType)
				before := nativeHandleCount(t)
				for i := 0; i < 10; i++ {
					assertWindowsStdioRefused(t, dir, index, file, fileType)
				}
				if after := nativeHandleCount(t); after > before+4 {
					t.Fatalf("type-query failure leaked handles: %d -> %d", before, after)
				}
				var flags uint32
				if err := nativeGetHandleInformation(handle, &flags); err != nil {
					t.Fatalf("launcher closed caller's file: %v", err)
				}
			})
		}
	}
}

func ownedWindowsNonFileHandle(t *testing.T, kind string) windows.Handle {
	t.Helper()
	var handle windows.Handle
	var err error
	switch kind {
	case "process", "thread":
		// These are real NON-INHERITABLE owned references, not os.NewFile on a
		// pseudo-handle. Closing the reference cannot terminate the process/thread.
		source := windows.CurrentProcess()
		if kind == "thread" {
			source = windows.CurrentThread()
		}
		err = windows.DuplicateHandle(windows.CurrentProcess(), source, windows.CurrentProcess(), &handle, 0, false, windows.DUPLICATE_SAME_ACCESS)
	case "token":
		var token windows.Token
		err = windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token)
		handle = windows.Handle(token)
	case "job":
		handle, err = windows.CreateJobObject(nil, nil)
	case "event":
		handle, err = windows.CreateEvent(nil, 1, 0, nil)
	default:
		t.Fatal("unknown owned synthetic handle kind")
	}
	if err != nil {
		t.Fatal(err)
	}
	return handle
}

func TestWindowsNonFileStdioNeverDuplicatedOrExecuted(t *testing.T) {
	for _, kind := range []string{"process", "thread", "token", "job", "event"} {
		for index, name := range []string{"stdin", "stdout", "stderr"} {
			t.Run(kind+"/"+name, func(t *testing.T) {
				dir := t.TempDir()
				handle := ownedWindowsNonFileHandle(t, kind)
				file := os.NewFile(uintptr(handle), "owned-non-file-"+kind)
				if file == nil {
					_ = windows.CloseHandle(handle)
					t.Fatal("cannot wrap real owned handle")
				}
				defer file.Close() // File owns exactly this real, non-inheritable reference.
				assertWindowsStdioRefused(t, dir, index, file, nil)
				before := nativeHandleCount(t)
				for i := 0; i < 10; i++ {
					assertWindowsStdioRefused(t, dir, index, file, nil)
				}
				if after := nativeHandleCount(t); after > before+4 {
					t.Fatalf("non-file failure leaked handles: %d -> %d", before, after)
				}
				var flags uint32
				if err := nativeGetHandleInformation(handle, &flags); err != nil {
					t.Fatalf("launcher closed caller's non-file handle: %v", err)
				}
			})
		}
	}
}

func TestWindowsReviewedStdioFileKinds(t *testing.T) {
	dir := t.TempDir()
	disk, err := os.CreateTemp(dir, "disk-")
	if err != nil {
		t.Fatal(err)
	}
	defer disk.Close()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	char, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer char.Close()
	for _, fixture := range []struct {
		file *os.File
		kind uint32
	}{{disk, windows.FILE_TYPE_DISK}, {reader, windows.FILE_TYPE_PIPE}, {char, windows.FILE_TYPE_CHAR}} {
		handle := windows.Handle(fixture.file.Fd())
		kind, err := windows.GetFileType(handle)
		if err != nil || kind != fixture.kind {
			t.Fatalf("wrong native fixture type: %#x/%v", kind, err)
		}
		if err := validateWindowsStdioHandle(handle, windows.GetFileType); err != nil {
			t.Fatalf("reviewed file rejected: %v", err)
		}
	}
}

func TestWindowsDiskStdioDescriptors(t *testing.T) {
	dir := t.TempDir()
	cmd := windowsHelperCommand(dir, "small")
	files := make([]*os.File, 3)
	for i := range files {
		file, err := os.CreateTemp(dir, fmt.Sprintf("stdio-%d-", i))
		if err != nil {
			t.Fatal(err)
		}
		files[i] = file
		defer file.Close()
		setWindowsStdio(cmd, i, file)
	}
	tr, err := Start(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	if err := waitNativeTree(t, tr); err != nil {
		t.Fatal(err)
	}
	if err := tr.Close(); err != nil {
		t.Fatal(err)
	}
	output, err := os.ReadFile(files[1].Name())
	if err != nil || strings.TrimSpace(string(output)) != "final-output" {
		t.Fatalf("disk stdout: %q/%v", output, err)
	}
	for _, file := range files {
		if file.Fd() == ^uintptr(0) {
			t.Fatal("native lifecycle closed caller-owned disk file")
		}
	}
}
