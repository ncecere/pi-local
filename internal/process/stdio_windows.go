//go:build windows

package process

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
)

// Only reviewed file kinds may enter HANDLE_LIST. Never pass NULL, a closed
// File's INVALID_HANDLE_VALUE (-1), or a reserved pseudo-handle to DuplicateHandle:
// it would convert pseudo process/thread authority into a real inheritable handle.
func validateWindowsStdioHandle(h windows.Handle, fileType func(windows.Handle) (uint32, error)) error {
	// Windows SDK pseudo-handles: current process/thread (-1/-2), reserved -3,
	// current process/thread/effective tokens (-4/-5/-6). They are never stdio.
	if h == 0 || uintptr(h) >= ^uintptr(0)-5 {
		return errors.New("invalid or pseudo stdio handle")
	}
	// x/sys GetFileType returns the type and the GetLastError captured by the
	// SAME syscall when the type is FILE_TYPE_UNKNOWN. Do not query last error
	// in a separate call (a Go goroutine can migrate OS threads). UNKNOWN is
	// rejected even with ERROR_SUCCESS/nil; successful known types ignore stale
	// last error, as required by GetFileType's Windows contract.
	kind, err := fileType(h)
	if err != nil {
		return fmt.Errorf("GetFileType: %w", err)
	}
	switch kind {
	case windows.FILE_TYPE_DISK, windows.FILE_TYPE_PIPE, windows.FILE_TYPE_CHAR:
		return nil
	default:
		// Includes UNKNOWN, unsupported flag combinations and all non-file
		// process/thread/token/job/event handles. Never relax to 'not invalid'.
		return fmt.Errorf("unsupported stdio file type %#x", kind)
	}
}

func duplicateWindowsStdio(source windows.Handle) (windows.Handle, error) {
	var handle windows.Handle
	err := windows.DuplicateHandle(windows.CurrentProcess(), source, windows.CurrentProcess(), &handle, 0, true, windows.DUPLICATE_SAME_ACCESS)
	return handle, err
}
