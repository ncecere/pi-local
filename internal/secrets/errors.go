package secrets

import "errors"

var (
	ErrNotFound    = errors.New("secret not found")
	ErrUnsupported = errors.New("secret storage unsupported")
	ErrUnavailable = errors.New("secret storage unavailable")
	ErrDenied      = errors.New("secret storage access denied")
	ErrLocked      = errors.New("secret storage locked")
	ErrTooLarge    = errors.New("secret value too large")
	// ErrBackend is an unclassified backend failure. It does not imply that a
	// failed write had no effect, or that retrying it is safe.
	ErrBackend = errors.New("secret storage operation failed")
)

// Error is a sanitized Keychain operation failure. errors.Is matches the safe
// category; errors.As can retrieve *Error. Raw backend causes are deliberately
// not retained or unwrapped: even their Error methods may disclose secrets.
// Denied/locked require explicit typed evidence, never error-message matching.
type Error struct {
	Op string // get, set, or delete
	// MaxValueBytes is nonzero only for a known byte-limit preflight rejection.
	MaxValueBytes int
	kind          error
}

func (e *Error) Error() string {
	// Keep diagnostics safe even for a caller-constructed Error: do not format
	// exported fields, which callers could fill with sensitive text.
	return e.Unwrap().Error()
}

// Unwrap exposes only a safe category, not the backend error chain.
func (e *Error) Unwrap() error {
	if e.kind == nil {
		return ErrBackend
	}
	return e.kind
}
