package secrets

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/zalando/go-keyring"
)

type backendCall struct{ op, service, name, value string }

type spyBackend struct {
	mu    sync.Mutex
	calls []backendCall
	items map[string]string
	err   error
}

func (b *spyBackend) Get(service, name string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls = append(b.calls, backendCall{"get", service, name, ""})
	if b.err != nil {
		return "POISON-PARTIAL-VALUE", b.err
	}
	v, ok := b.items[name]
	if !ok {
		return "", keyring.ErrNotFound
	}
	return v, nil
}

func (b *spyBackend) Set(service, name, value string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls = append(b.calls, backendCall{"set", service, name, value})
	if b.err != nil {
		return b.err
	}
	if b.items == nil {
		b.items = map[string]string{}
	}
	b.items[name] = value
	return nil
}

func (b *spyBackend) Delete(service, name string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls = append(b.calls, backendCall{"delete", service, name, ""})
	if b.err != nil {
		return b.err
	}
	if _, ok := b.items[name]; !ok {
		return keyring.ErrNotFound
	}
	delete(b.items, name)
	return nil
}

func TestWindowsByteLimitPreflight(t *testing.T) {
	for _, test := range []struct {
		name, value string
		tooLarge    bool
	}{
		{"empty", "", false},
		{"ascii2559", strings.Repeat("a", 2559), false},
		{"ascii2560", strings.Repeat("a", 2560), false},
		{"ascii2561", strings.Repeat("a", 2561), true},
		{"twoByte2559", strings.Repeat("é", 1279) + "a", false},
		{"twoByte2560", strings.Repeat("é", 1280), false},
		{"twoByte2561", strings.Repeat("é", 1280) + "a", true},
		{"fourByte2559", strings.Repeat("𐐀", 639) + "abc", false},
		{"fourByte2560", strings.Repeat("𐐀", 640), false},
		{"fourByte2561", strings.Repeat("𐐀", 640) + "a", true},
		{"combining2560", strings.Repeat("e\u0301", 853) + "a", false},
		{"combining2561", strings.Repeat("e\u0301", 853) + "ab", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			b := &spyBackend{}
			k := newKeychain(b, "windows")
			err := k.Set("POISON-NAME", test.value)
			if test.tooLarge {
				var typed *Error
				if !errors.Is(err, ErrTooLarge) || !errors.As(err, &typed) || typed.Op != "set" || typed.MaxValueBytes != 2560 {
					t.Fatalf("missing typed preflight error: %v", err)
				}
				if len(b.calls) != 0 || len(b.items) != 0 {
					t.Fatal("rejected value reached backend")
				}
				return
			}
			if err != nil || len(b.calls) != 1 || b.calls[0] != (backendCall{"set", Service, "POISON-NAME", test.value}) {
				t.Fatalf("set did not pass the complete value: %v", err)
			}
			got, err := k.Get("POISON-NAME")
			if err != nil || got != test.value {
				t.Fatal("value was changed or truncated")
			}
		})
	}
}

// No real OS vault operations: simulated platform selection tests the preflight
// on every host. The macOS command-length policy stays in the pinned backend.
func TestOtherPlatformsDoNotAcquireWindowsLimit(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "unsupported"} {
		b := &spyBackend{}
		k := newKeychain(b, goos)
		value := strings.Repeat("x", 2561)
		if err := k.Set("n", value); err != nil || len(b.calls) != 1 || b.calls[0].value != value {
			t.Fatalf("%s: %v", goos, err)
		}
	}
}

type poisonError struct{}

func (*poisonError) Error() string { return "POISON-CAUSE: command output: denied locked" }

func TestBackendErrorsAreClassifiedAndSanitized(t *testing.T) {
	poison := &poisonError{}
	cases := []struct {
		name      string
		err, want error
	}{
		{"notFound", keyring.ErrNotFound, ErrNotFound},
		{"unsupported", keyring.ErrUnsupportedPlatform, ErrUnsupported},
		{"tooLarge", keyring.ErrSetDataTooBig, ErrTooLarge},
		{"storeNotFound", ErrNotFound, ErrNotFound},
		{"storeUnsupported", ErrUnsupported, ErrUnsupported},
		{"storeTooLarge", ErrTooLarge, ErrTooLarge},
		{"unavailable", ErrUnavailable, ErrUnavailable},
		{"denied", ErrDenied, ErrDenied},
		{"locked", ErrLocked, ErrLocked},
		{"backend", ErrBackend, ErrBackend},
		{"unknown", poison, ErrBackend},
		{"textIsNotEvidence", errors.New("denied: locked: unsupported: not found"), ErrBackend},
	}
	for _, tc := range cases {
		for _, wrapped := range []bool{false, true} {
			for _, op := range []string{"get", "set", "delete"} {
				t.Run(fmt.Sprintf("%s/%t/%s", tc.name, wrapped, op), func(t *testing.T) {
					cause := tc.err
					if wrapped {
						cause = fmt.Errorf("POISON-WRAPPER: %w", cause)
					}
					b := &spyBackend{err: cause}
					k := newKeychain(b, "darwin")
					var err error
					switch op {
					case "get":
						var value string
						value, err = k.Get("POISON-NAME")
						if value != "" {
							t.Fatal("failed read disclosed a partial value")
						}
					case "set":
						err = k.Set("POISON-NAME", "POISON-VALUE")
					case "delete":
						err = k.Delete("POISON-NAME")
					}
					if len(b.calls) != 1 || b.calls[0].service != Service || b.calls[0].name != "POISON-NAME" || len(b.items) != 0 {
						t.Fatal("wrong boundary, retry, or fallback")
					}
					if op == "delete" && tc.want == ErrNotFound {
						if err != nil {
							t.Fatal("missing delete must be idempotent")
						}
						return
					}
					var typed *Error
					if !errors.Is(err, tc.want) || !errors.As(err, &typed) || typed.Op != op || typed.MaxValueBytes != 0 {
						t.Fatalf("wrong category or operation: %v", err)
					}
					for _, format := range []string{"%s", "%v", "%+v", "%#v"} {
						if strings.Contains(fmt.Sprintf(format, err), "POISON") {
							t.Fatal("diagnostic leaked backend data")
						}
					}
					var raw *poisonError
					if errors.As(err, &raw) || errors.Is(err, poison) {
						t.Fatal("raw cause escaped")
					}
					if errors.Unwrap(err) != tc.want {
						t.Fatal("unwrap must contain only safe category")
					}
				})
			}
		}
	}
}

func TestStoreRoundTripsAndMissingDelete(t *testing.T) {
	for name, store := range map[string]Store{
		"fakeKeychain": newKeychain(&spyBackend{}, "darwin"),
		"memory":       NewMemory(),
	} {
		t.Run(name, func(t *testing.T) {
			if got, err := store.Get("missing"); got != "" || !errors.Is(err, ErrNotFound) {
				t.Fatal("missing get")
			}
			if err := store.Delete("missing"); err != nil {
				t.Fatal(err)
			}
			for _, value := range []string{"", "a\x00é\n", "replacement"} {
				if err := store.Set("n", value); err != nil {
					t.Fatal(err)
				}
				if got, err := store.Get("n"); err != nil || got != value {
					t.Fatal("round trip")
				}
			}
			if err := store.Delete("n"); err != nil {
				t.Fatal(err)
			}
			if err := store.Delete("n"); err != nil {
				t.Fatal(err)
			}
			if _, err := store.Get("n"); !errors.Is(err, ErrNotFound) {
				t.Fatal("delete did not remove value")
			}
		})
	}
}

func TestInjectedNilBackendFailsClosed(t *testing.T) {
	k := newKeychain(nil, "darwin")
	if got, err := k.Get("n"); got != "" || !errors.Is(err, ErrUnavailable) {
		t.Fatal("nil get")
	}
	if err := k.Set("n", "v"); !errors.Is(err, ErrUnavailable) {
		t.Fatal("nil set")
	}
	if err := k.Delete("n"); !errors.Is(err, ErrUnavailable) {
		t.Fatal("nil delete")
	}
	// Windows rejects before even a missing backend can be invoked.
	k = newKeychain(nil, "windows")
	if err := k.Set("n", strings.Repeat("x", 2561)); !errors.Is(err, ErrTooLarge) {
		t.Fatal("preflight precedence")
	}
}

type legacyStore struct{ Store }

func TestStaticInfoAndCompatibilityDoNotProbe(t *testing.T) {
	b := &spyBackend{}
	k := newKeychain(b, "windows")
	want := Info{Location: LocationOSVault, ValuesProtected: true, MaxValueBytes: 2560}
	for _, store := range []Store{k, &k} {
		if Describe(store) != want || !InKeychain(store) {
			t.Fatal("keychain metadata")
		}
	}
	var zero Keychain // Inspect the real adapter wiring, never invoke it.
	d := zero.dependencies()
	if _, ok := d.backend.(systemKeyring); !ok || d.goos != runtime.GOOS {
		t.Fatal("zero-value adapter")
	}
	want.MaxValueBytes = 0
	if runtime.GOOS == "windows" {
		want.MaxValueBytes = 2560
	}
	if Describe(zero) != want || Describe(&zero) != want {
		t.Fatal("zero-value metadata")
	}
	for _, goos := range []string{"darwin", "linux"} {
		if newKeychain(b, goos).Info().MaxValueBytes != 0 {
			t.Fatal("unknown must not mean unlimited")
		}
	}
	memory := NewMemory()
	if Describe(memory) != (Info{Location: LocationMemory}) || InKeychain(memory) {
		t.Fatal("memory metadata")
	}
	var zeroMemory Memory
	if zeroMemory.Info() != memory.Info() {
		t.Fatal("zero memory metadata")
	}
	if Describe(legacyStore{memory}) != (Info{Location: LocationUnknown}) || InKeychain(legacyStore{memory}) {
		t.Fatal("optional contract changed Store")
	}
	if Describe(nil) != (Info{Location: LocationUnknown}) {
		t.Fatal("nil metadata")
	}
	if len(b.calls) != 0 {
		t.Fatal("construction or metadata probed backend")
	}
	if (&Error{Op: "POISON"}).Error() != ErrBackend.Error() {
		t.Fatal("unsafe zero error")
	}
}

func TestConcurrentFakeOperations(t *testing.T) {
	for name, store := range map[string]Store{
		"fakeKeychain": newKeychain(&spyBackend{}, "windows"),
		"memory":       NewMemory(),
	} {
		t.Run(name, func(t *testing.T) {
			var wg sync.WaitGroup
			for i := 0; i < 24; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					key := fmt.Sprintf("n%d", i)
					for j := 0; j < 50; j++ {
						if err := store.Set(key, "value"); err != nil {
							t.Error(err)
							return
						}
						if got, err := store.Get(key); err != nil || got != "value" {
							t.Error("concurrent get")
							return
						}
						if err := store.Delete(key); err != nil {
							t.Error(err)
							return
						}
						_ = Describe(store)
						if m, ok := store.(*Memory); ok {
							_ = m.Names()
						}
					}
				}()
			}
			wg.Wait()
		})
	}
}
