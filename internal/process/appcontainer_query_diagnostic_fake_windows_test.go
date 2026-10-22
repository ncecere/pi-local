//go:build windows

package process

import (
	"errors"
	"runtime"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Formatting this unknown error would expose backend text in a real diagnostic.
// Panic here proves that the observer does not request error strings.
type candidateQueryOpaqueError struct{}

func (*candidateQueryOpaqueError) Error() string { panic("diagnostic formatted backend error") }

type candidateQueryWrappedError struct{ err error }

func (*candidateQueryWrappedError) Error() string   { panic("diagnostic formatted wrapped error") }
func (e *candidateQueryWrappedError) Unwrap() error { return e.err }

func TestWindowsLPACQueryDiagnosticSequenceAndForwarding(t *testing.T) {
	unknown := &candidateQueryOpaqueError{}
	wrapped87 := &candidateQueryWrappedError{err: windows.ERROR_INVALID_PARAMETER}
	for _, tc := range []struct {
		name        string
		diagnostics [3]error
		original    error
		want        [3]candidateLPACQueryObservation
	}{
		{"mixed-original-87", [3]error{nil, wrapped87, unknown}, windows.ERROR_INVALID_PARAMETER,
			[3]candidateLPACQueryObservation{{1, true, false, 0, ^uint32(0)}, {4, false, true, 87, ^uint32(0) - 1}, {8, false, false, 0, ^uint32(0) - 2}}},
		{"all-success-original-unknown", [3]error{}, unknown,
			[3]candidateLPACQueryObservation{{1, true, false, 0, ^uint32(0)}, {4, true, false, 0, ^uint32(0) - 1}, {8, true, false, 0, ^uint32(0) - 2}}},
		{"all-error-original-success", [3]error{windows.ERROR_ACCESS_DENIED, windows.ERROR_INVALID_PARAMETER, unknown}, nil,
			[3]candidateLPACQueryObservation{{1, false, true, 5, ^uint32(0)}, {4, false, true, 87, ^uint32(0) - 1}, {8, false, false, 0, ^uint32(0) - 2}}},
		{"errno-zero-original-wrapped", [3]error{syscall.Errno(0), nil, wrapped87}, wrapped87,
			[3]candidateLPACQueryObservation{{1, false, true, 0, ^uint32(0)}, {4, true, false, 0, ^uint32(0) - 1}, {8, false, true, 87, ^uint32(0) - 2}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const borrowed windows.Token = 123 // opaque fake, never opened or closed
			var original [1]uint32
			out := (*byte)(unsafe.Pointer(&original[0]))
			used := uint32(17)
			calls, reports := 0, 0
			var seen [4]uint32
			var got [3]candidateLPACQueryObservation
			var diagnosticPointers [3]*byte
			query := func(token windows.Token, class uint32, buffer *byte, size uint32, returned *uint32) error {
				if calls >= len(seen) {
					t.Fatal("unexpected extra query")
				}
				seen[calls] = size
				if token != borrowed || class != tokenIsLessPrivilegedAppContainer {
					t.Fatal("changed borrowed token or class")
				}
				i := calls
				calls++
				if i == 3 {
					if reports != 1 || buffer != out || size != 4 || returned != &used || used != 17 || original[0] != 0 {
						t.Fatal("original argument identity, contents or observation order changed")
					}
					copy(unsafe.Slice(buffer, 4), []byte{0xa1, 0xb2, 0xc3, 0xd4})
					*returned = 29
					return tc.original
				}
				if buffer == nil || buffer == out || returned == nil || returned == &used || *returned != 0 || uintptr(unsafe.Pointer(buffer))%unsafe.Alignof(uint64(0)) != 0 {
					t.Fatal("diagnostic storage is not independently aligned and initialized")
				}
				diagnosticPointers[i] = buffer
				// The FAKE alone examines/fills the full owned capacity, even when
				// the request is one byte. The helper must never read these values.
				data := unsafe.Slice(buffer, 8)
				for _, b := range data {
					if b != 0 {
						t.Fatal("diagnostic storage was not freshly zeroed")
					}
				}
				for j := range data {
					data[j] = 0xff // hostile values must not be parsed as data/pointers
				}
				// Never let this hostile length drive allocation, slicing or reads.
				*returned = ^uint32(0) - uint32(i)
				return tc.diagnostics[i]
			}
			wrapped := candidateLPACQueryDiagnostic(query, func(observations [3]candidateLPACQueryObservation) {
				reports++
				if calls != 3 || used != 17 || original[0] != 0 {
					t.Fatal("observation did not precede untouched original query")
				}
				got = observations
			})
			if err := wrapped(borrowed, tokenIsLessPrivilegedAppContainer, out, 4, &used); err != tc.original {
				t.Fatal("original error identity changed")
			}
			if calls != 4 || reports != 1 || seen != [4]uint32{1, 4, 8, 4} || got != tc.want {
				t.Fatal("query sequence or numeric observations changed")
			}
			if used != 29 || original[0] != 0xd4c3b2a1 {
				t.Fatal("original output bytes or returned length not forwarded")
			}
			runtime.KeepAlive(diagnosticPointers)
		})
	}
}

func TestWindowsLPACQueryDiagnosticOtherClassesPassThrough(t *testing.T) {
	unknown := &candidateQueryOpaqueError{}
	classes := []uint32{^uint32(0)}
	for class := uint32(0); class < 64; class++ {
		if class != tokenIsLessPrivilegedAppContainer {
			classes = append(classes, class)
		}
	}
	for _, class := range classes {
		for _, size := range []uint32{0, 1, 4, 8} {
			var storage [1]uint64
			var out *byte
			if size != 0 {
				out = (*byte)(unsafe.Pointer(&storage[0]))
			}
			used := uint32(33)
			calls := 0
			wrapped := candidateLPACQueryDiagnostic(func(token windows.Token, c uint32, p *byte, n uint32, returned *uint32) error {
				calls++
				if token != 321 || c != class || p != out || n != size || returned != &used || *returned != 33 {
					t.Fatal("non-LPAC original arguments changed")
				}
				if p != nil {
					*p = 0xa5
				}
				*returned = 99
				return unknown
			}, func([3]candidateLPACQueryObservation) { t.Fatal("probed another class") })
			if err := wrapped(321, class, out, size, &used); err != unknown || calls != 1 || used != 99 {
				t.Fatal("non-LPAC passthrough changed")
			}
			if out != nil && *out != 0xa5 {
				t.Fatal("non-LPAC original bytes not forwarded")
			}
			runtime.KeepAlive(&storage)
		}
	}
}

func TestWindowsLPACQueryDiagnosticDoesNotAuthorize(t *testing.T) {
	for _, tc := range []struct {
		name          string
		diagnosticErr error
		originalErr   error
		originalValue uint32
		wantSuccess   bool
	}{
		{"all-probes-succeed-original-87", nil, windows.ERROR_INVALID_PARAMETER, 1, false},
		{"all-probes-succeed-original-zero", nil, nil, 0, false},
		{"all-probes-fail-original-valid", windows.ERROR_INVALID_PARAMETER, nil, 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := goodCandidateToken(t)
			fixture.lpac = tc.originalValue
			calls, reports := 0, 0
			wrapped := candidateLPACQueryDiagnostic(func(token windows.Token, class uint32, out *byte, size uint32, returned *uint32) error {
				if class != tokenIsLessPrivilegedAppContainer {
					return fixture.query(token, class, out, size, returned)
				}
				calls++
				if calls <= 3 {
					data := unsafe.Slice(out, 8)
					for i := range data {
						data[i] = 0xff
					}
					*returned = ^uint32(0)
					return tc.diagnosticErr
				}
				if calls != 4 || size != 4 {
					t.Fatal("original DWORD contract changed")
				}
				if tc.originalErr != nil {
					return tc.originalErr
				}
				return fixture.query(token, class, out, size, returned)
			}, func([3]candidateLPACQueryObservation) { reports++ })
			err := verifyWindowsAppContainerToken(123, candidatePolicy(t, true), wrapped)
			if (err == nil) != tc.wantSuccess || calls != 4 || reports != 1 {
				t.Fatal("diagnostics changed verification authority or final query reachability")
			}
			if tc.originalErr != nil && !errors.Is(err, tc.originalErr) {
				t.Fatal("original refusal error lost")
			}
		})
	}
}
