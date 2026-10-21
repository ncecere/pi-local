package secrets

import (
	"errors"
	"runtime"

	"github.com/zalando/go-keyring"
)

// WindowsDirectMaxValueBytes is the pinned go-keyring v0.2.8 password limit.
// It counts string bytes (UTF-8 for UTF-8 input), not runes or UTF-16 units.
const WindowsDirectMaxValueBytes = 2560

// Keychain is the direct OS vault store. Its zero value delegates to go-keyring
// under Service only when Get, Set, or Delete is called. Construction and Info
// do not probe availability. It never falls back to another store.
// The current backend has no context/deadline or reliable prompt cancellation.
type Keychain struct {
	deps *keychainDeps
}

// keychainBackend deliberately exposes only the three Store operations, with
// the fixed service supplied by Keychain rather than by a caller.
type keychainBackend interface {
	Get(service, name string) (string, error)
	Set(service, name, value string) error
	Delete(service, name string) error
}

type keychainDeps struct {
	backend keychainBackend
	goos    string
}

// newKeychain never fills missing test dependencies with a real vault backend.
func newKeychain(backend keychainBackend, goos string) Keychain {
	return Keychain{deps: &keychainDeps{backend: backend, goos: goos}}
}

func (k Keychain) dependencies() keychainDeps {
	if k.deps != nil {
		return *k.deps
	}
	return keychainDeps{backend: systemKeyring{}, goos: runtime.GOOS}
}

// systemKeyring is the only adapter allowed to invoke the real OS vault.
type systemKeyring struct{}

func (systemKeyring) Get(service, name string) (string, error) { return keyring.Get(service, name) }
func (systemKeyring) Set(service, name, value string) error {
	return keyring.Set(service, name, value)
}
func (systemKeyring) Delete(service, name string) error { return keyring.Delete(service, name) }

func (k Keychain) Get(name string) (string, error) {
	d := k.dependencies()
	if d.backend == nil {
		return "", &Error{Op: "get", kind: ErrUnavailable}
	}
	v, err := d.backend.Get(Service, name)
	if err != nil {
		// Never return a partial value with a failed read.
		return "", safeError("get", err)
	}
	return v, nil
}

func (k Keychain) Set(name, value string) error {
	d := k.dependencies()
	if d.goos == "windows" && len(value) > WindowsDirectMaxValueBytes {
		return &Error{Op: "set", kind: ErrTooLarge, MaxValueBytes: WindowsDirectMaxValueBytes}
	}
	if d.backend == nil {
		return &Error{Op: "set", kind: ErrUnavailable}
	}
	return safeError("set", d.backend.Set(Service, name, value))
}

func (k Keychain) Delete(name string) error {
	d := k.dependencies()
	if d.backend == nil {
		return &Error{Op: "delete", kind: ErrUnavailable}
	}
	err := safeError("delete", d.backend.Delete(Service, name))
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

func safeError(op string, err error) error {
	if err == nil {
		return nil
	}
	kind := ErrBackend
	switch {
	case errors.Is(err, keyring.ErrNotFound), errors.Is(err, ErrNotFound):
		kind = ErrNotFound
	case errors.Is(err, keyring.ErrUnsupportedPlatform), errors.Is(err, ErrUnsupported):
		kind = ErrUnsupported
	case errors.Is(err, keyring.ErrSetDataTooBig), errors.Is(err, ErrTooLarge):
		kind = ErrTooLarge
	case errors.Is(err, ErrUnavailable):
		kind = ErrUnavailable
	case errors.Is(err, ErrDenied):
		kind = ErrDenied
	case errors.Is(err, ErrLocked):
		kind = ErrLocked
	}
	return &Error{Op: op, kind: kind}
}
