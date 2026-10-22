//go:build windows

package process

import (
	"errors"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Observations only: no result bytes, token identity, handles or error strings.
// In particular, a failed query's returnedLength is not authoritative.
type candidateLPACQueryObservation struct {
	requestedSize      uint32
	success            bool
	numericCodePresent bool
	code               uint64
	returnedLength     uint32
}

// candidateLPACQueryDiagnostic borrows the verifier's already-open QUERY token
// synchronously. It neither owns a handle nor changes verification authority.
// The native fixture must supply windows.GetTokenInformation itself as query.
func candidateLPACQueryDiagnostic(query windowsTokenInformation, observe func([3]candidateLPACQueryObservation)) windowsTokenInformation {
	return func(token windows.Token, class uint32, out *byte, size uint32, returned *uint32) error {
		if class == tokenIsLessPrivilegedAppContainer {
			var observations [3]candidateLPACQueryObservation
			for i, requested := range [3]uint32{1, 4, 8} {
				// Fresh, zeroed, aligned owned storage of exactly eight bytes for
				// each call. Never inspect its contents or size it from API output.
				var storage [1]uint64
				var used uint32
				err := query(token, class, (*byte)(unsafe.Pointer(&storage[0])), requested, &used)
				runtime.KeepAlive(&storage)
				var errno syscall.Errno
				present := errors.As(err, &errno) // classify the immediate returned error only
				observations[i] = candidateLPACQueryObservation{
					requestedSize: requested, success: err == nil,
					numericCodePresent: present, code: uint64(errno), returnedLength: used,
				}
			}
			if observe != nil {
				observe(observations)
			}
		}
		// ORIGINAL query, including the original DWORD extent, pointer identities,
		// output writes and exact error identity. Diagnostics never supply a value,
		// waive an error, retry this call or participate in the verifier's decision.
		return query(token, class, out, size, returned)
	}
}
