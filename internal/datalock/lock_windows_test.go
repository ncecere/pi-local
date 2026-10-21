//go:build windows

package datalock

import (
	"errors"
	"fmt"
	"testing"

	"golang.org/x/sys/windows"
)

func TestContentionErrnos(t *testing.T) {
	for _, tt := range []struct {
		err  error
		want bool
	}{
		{windows.ERROR_LOCK_VIOLATION, true},
		{windows.ERROR_ACCESS_DENIED, false},
		{windows.ERROR_SHARING_VIOLATION, false},
		{windows.ERROR_IO_PENDING, false},
		{windows.ERROR_INVALID_HANDLE, false},
		{windows.ERROR_DISK_FULL, false},
		{windows.ERROR_NOT_SUPPORTED, false},
		{errors.New("other failure"), false},
		{nil, false},
	} {
		if got := isContention(tt.err); got != tt.want {
			t.Errorf("isContention(%v) = %v, want %v", tt.err, got, tt.want)
		}
		if tt.err != nil && isContention(fmt.Errorf("wrapped: %w", tt.err)) != tt.want {
			t.Errorf("wrapped error classification: %v", tt.err)
		}
	}
}
