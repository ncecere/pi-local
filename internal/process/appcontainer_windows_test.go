//go:build windows

package process

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// No profiles, ACL edits, foreign processes, network, or credential APIs in this
// first slice. All native children below remain suspended until refusal/reap.
const candidateSyntheticSID = "S-1-15-2-100-200-300-400-500-600-700"

func candidatePolicy(t *testing.T, lpac bool) *windowsAppContainerPolicy {
	t.Helper()
	sid, err := windows.StringToSid(candidateSyntheticSID)
	if err != nil {
		t.Fatal(err)
	}
	return &windowsAppContainerPolicy{profileSID: sid, lpac: lpac}
}

// Explicit fake checker for metadata-only parser tests; never native token work.
func candidateFakeVerification(query windowsTokenInformation) *windowsAppContainerVerification {
	return &windowsAppContainerVerification{query: query, checkLPAC: func(windows.Token, []byte) error { return nil }}
}

func TestWindowsAppContainerSDKLayouts(t *testing.T) {
	word := unsafe.Sizeof(uintptr(0))
	caps := windowsSecurityCapabilities{}
	if unsafe.Offsetof(caps.capabilities) != word || unsafe.Offsetof(caps.capabilityCount) != 2*word || unsafe.Offsetof(caps.reserved) != 2*word+4 || unsafe.Sizeof(caps) != 2*word+8 {
		t.Fatal("SECURITY_CAPABILITIES does not match SDK pointer/pointer/DWORD/DWORD")
	}
	if unsafe.Sizeof(windowsTokenAppContainerInformation{}) != word {
		t.Fatal("TOKEN_APPCONTAINER_INFORMATION does not match SDK PSID")
	}
}

func TestWindowsAppContainerPrivatePolicy(t *testing.T) {
	for _, raw := range []string{"", "S-1-15-2", "S-1-15-2-1", "S-1-15-2-1-2-3-4-5-6", "S-1-15-2-1-2-3-4-5-6-7-8", "S-1-15-3-1-2-3-4-5-6-7", "S-1-5-2-1-2-3-4-5-6-7"} {
		t.Run(raw, func(t *testing.T) {
			p := &windowsAppContainerPolicy{}
			if raw != "" {
				var err error
				p.profileSID, err = windows.StringToSid(raw)
				if err != nil {
					t.Fatal(err)
				}
			}
			if _, err := p.snapshot(); err == nil {
				t.Fatal("accepted missing/broad/capability/non-profile SID")
			}
		})
	}
	for _, lpac := range []bool{false, true} {
		p := candidatePolicy(t, lpac)
		owned, err := p.snapshot()
		if err != nil || owned.profileSID == p.profileSID || !owned.profileSID.Equals(p.profileSID) {
			t.Fatalf("profile SID not independently owned: %v", err)
		}
		var seen []uintptr
		err = owned.install(func(attr uintptr, ptr unsafe.Pointer, size uintptr) error {
			seen = append(seen, attr)
			switch attr {
			case procThreadAttributeSecurityCapabilities:
				caps := (*windowsSecurityCapabilities)(ptr)
				if size != unsafe.Sizeof(*caps) || !caps.appContainerSID.Equals(owned.profileSID) || caps.capabilities != nil || caps.capabilityCount != 0 || caps.reserved != 0 {
					t.Fatal("security attribute was not exact SID/zero capabilities")
				}
			case procThreadAttributeAllPackagesPolicy:
				if !lpac || size != 4 || *(*uint32)(ptr) != 1 {
					t.Fatal("invalid LPAC opt-out layout")
				}
			default:
				t.Fatal("unexpected attribute")
			}
			return nil
		})
		want := 1
		if lpac {
			want++
		}
		if err != nil || len(seen) != want {
			t.Fatalf("attributes=%v err=%v", seen, err)
		}
	}
}

// Construct canonical bytes directly, never via native interior-pointer helpers.
func candidateSIDBytes(authority byte, count byte, first uint32) []byte {
	data := make([]byte, 8+4*int(count))
	data[0], data[1], data[7] = 1, count, authority
	if count > 0 {
		binary.LittleEndian.PutUint32(data[8:12], first)
	}
	return data
}

func TestWindowsAppContainerSIDMetadata(t *testing.T) {
	for _, tc := range []struct {
		name      string
		authority byte
		count     byte
		first     uint32
	}{
		{"profile", 15, 8, 2},
		{"low-integrity", 16, 1, 4096},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := candidateSIDBytes(tc.authority, tc.count, tc.first)
			authority := [6]byte{0, 0, 0, 0, 0, tc.authority}
			matches := func(data []byte) bool { return candidateSIDMatches(data, authority, tc.count, tc.first) }
			if !matches(data) {
				t.Fatal("refused canonical metadata")
			}
			for n := 0; n < len(data); n++ {
				if matches(data[:n]) {
					t.Fatalf("accepted truncated span of %d bytes", n)
				}
			}
			if matches(append(append([]byte(nil), data...), 0)) {
				t.Fatal("accepted non-exact SID extent")
			}
			// All header bytes and all four RID bytes participate in the match.
			for i := 0; i < 12; i++ {
				changed := append([]byte(nil), data...)
				changed[i] ^= 1
				if matches(changed) {
					t.Fatalf("ignored metadata byte %d", i)
				}
			}
			for _, count := range []byte{0, 1, 7, 8, 9, 15, 16, 255} {
				if count != tc.count && matches(candidateSIDBytes(tc.authority, count, tc.first)) {
					t.Fatalf("accepted subauthority count %d", count)
				}
			}
			wrongEndian := append([]byte(nil), data...)
			binary.BigEndian.PutUint32(wrongEndian[8:12], tc.first)
			if matches(wrongEndian) {
				t.Fatal("accepted big-endian subauthority")
			}
		})
	}
	if candidateSIDMatches(candidateSIDBytes(15, 1, 2), [6]byte{0, 0, 0, 0, 0, 15}, 8, 2) ||
		candidateSIDMatches(candidateSIDBytes(15, 8, 3), [6]byte{0, 0, 0, 0, 0, 15}, 8, 2) {
		t.Fatal("accepted broad package or capability SID")
	}
}

func TestWindowsAppContainerBoundedSIDSpan(t *testing.T) {
	header := unsafe.Sizeof(windows.Tokenmandatorylabel{})
	word := unsafe.Sizeof(uintptr(0))
	// Spare token bytes must not become part of the bounded SID span.
	size := header + 12 + 16
	b := windowsTokenBuffer{words: make([]uintptr, (size+word-1)/word), size: uint32(size)}
	data := b.bytes()
	copy(data[header:], candidateSIDBytes(16, 1, 4096))
	sid := (*windows.SID)(unsafe.Pointer(&data[header]))
	span, err := b.boundedSID(sid, header)
	if err != nil || len(span) != 12 || cap(span) != 12 || !candidateSIDMatches(span, [6]byte{0, 0, 0, 0, 0, 16}, 1, 4096) {
		t.Fatalf("lost exact SID extent: len=%d cap=%d err=%v", len(span), cap(span), err)
	}
	for n := uintptr(0); n < 12; n++ {
		b.size = uint32(header + n)
		if _, err := b.boundedSID(sid, header); err == nil {
			t.Fatalf("accepted SID extent of %d bytes", n)
		}
	}
	b.size = uint32(header + 12)
	if _, err := b.boundedSID(sid, header); err != nil {
		t.Fatalf("refused exact buffer boundary: %v", err)
	}
}

type candidateTokenFixture struct {
	appContainer, elevated, capabilities, lpac uint32
	profile, integrity                         *windows.SID
	integrityAttributes                        uint32
}

func goodCandidateToken(t *testing.T) *candidateTokenFixture {
	t.Helper()
	low, err := windows.StringToSid("S-1-16-4096")
	if err != nil {
		t.Fatal(err)
	}
	return &candidateTokenFixture{appContainer: 1, lpac: 1, profile: candidatePolicy(t, true).profileSID, integrity: low, integrityAttributes: windows.SE_GROUP_INTEGRITY}
}

// Models GetTokenInformation's native buffer-relative PSIDs, not dangling
// pointers into separate Go/LocalAlloc storage. Used only for parser tests.
func (f *candidateTokenFixture) query(_ windows.Token, class uint32, out *byte, size uint32, returned *uint32) error {
	var sid *windows.SID
	var header uintptr
	var value uint32
	switch class {
	case tokenIsAppContainer:
		value = f.appContainer
	case windows.TokenElevation:
		value = f.elevated
	case tokenIsLessPrivilegedAppContainer:
		value = f.lpac
	case tokenCapabilities:
		value = f.capabilities
	case tokenAppContainerSID:
		sid, header = f.profile, unsafe.Sizeof(windowsTokenAppContainerInformation{})
	case windows.TokenIntegrityLevel:
		sid, header = f.integrity, unsafe.Sizeof(windows.Tokenmandatorylabel{})
	default:
		return windows.ERROR_INVALID_PARAMETER
	}
	needed := uint32(4)
	if header != 0 {
		needed = uint32(header)
		if sid != nil {
			needed += uint32(sid.Len())
		}
	}
	*returned = needed
	if out == nil || size == 0 {
		switch class {
		case tokenIsAppContainer, windows.TokenElevation, tokenIsLessPrivilegedAppContainer:
			return windows.ERROR_BAD_LENGTH // fixed fields must never use a sizing probe
		}
	}
	if out == nil || size < needed {
		return windows.ERROR_INSUFFICIENT_BUFFER
	}
	data := unsafe.Slice(out, int(size))
	clear(data)
	if header == 0 {
		binary.LittleEndian.PutUint32(data, value)
		return nil
	}
	var embedded *windows.SID
	if sid != nil {
		embedded = (*windows.SID)(unsafe.Pointer(&data[header]))
		if err := windows.CopySid(uint32(sid.Len()), embedded, sid); err != nil {
			return err
		}
	}
	if class == tokenAppContainerSID {
		(*windowsTokenAppContainerInformation)(unsafe.Pointer(out)).sid = embedded
	} else {
		label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(out))
		label.Label.Sid, label.Label.Attributes = embedded, f.integrityAttributes
	}
	return nil
}

func TestWindowsAppContainerDWORDQueryContract(t *testing.T) {
	for _, class := range []uint32{tokenIsAppContainer, windows.TokenElevation, tokenIsLessPrivilegedAppContainer} {
		t.Run(windowsClassName(class), func(t *testing.T) {
			f := goodCandidateToken(t)
			var needed uint32
			if err := f.query(0, class, nil, 0, &needed); err != windows.ERROR_BAD_LENGTH {
				t.Fatalf("model zero-sized probe: %v", err)
			}
			for _, used := range []uint32{0, 1, 2, 3, 4, 5, 8, maxCandidateTokenBytes + 1, ^uint32(0)} {
				calls := 0
				b, err := queryCandidateDWORD(123, class, func(token windows.Token, c uint32, out *byte, n uint32, returned *uint32) error {
					calls++
					if token != 123 || c != class || out == nil || n != 4 || uintptr(unsafe.Pointer(out))%unsafe.Alignof(uint32(0)) != 0 {
						t.Fatalf("not one exact aligned DWORD query: token=%d class=%d nonnil=%v size=%d", token, c, out != nil, n)
					}
					if err := f.query(token, c, out, n, returned); err != nil {
						return err
					}
					*returned = used
					return nil
				})
				if calls != 1 || (err == nil) != (used == 4) {
					t.Fatalf("returned=%d calls=%d err=%v", used, calls, err)
				}
				if used == 4 {
					got, err := b.dword()
					want := uint32(1)
					if class == windows.TokenElevation {
						want = 0
					}
					if err != nil || got != want {
						t.Fatalf("DWORD=%d want=%d err=%v", got, want, err)
					}
				}
			}
		})
	}
	for _, class := range []uint32{0, tokenCapabilities, tokenAppContainerSID, windows.TokenIntegrityLevel, ^uint32(0)} {
		if _, err := queryCandidateDWORD(0, class, func(windows.Token, uint32, *byte, uint32, *uint32) error {
			t.Fatal("unknown/non-DWORD class reached query")
			return nil
		}); err == nil {
			t.Fatalf("accepted non-DWORD class %d", class)
		}
	}
}

func TestWindowsAppContainerTokenGate(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*candidateTokenFixture)
		want string
	}{
		{"valid-synthetic-layout", func(*candidateTokenFixture) {}, ""},
		{"not-appcontainer", func(f *candidateTokenFixture) { f.appContainer = 0 }, "token class 29"},
		{"unknown-appcontainer-value", func(f *candidateTokenFixture) { f.appContainer = 2 }, "token class 29"},
		{"elevated", func(f *candidateTokenFixture) { f.elevated = 1 }, "token class 20"},
		{"elevated-noncanonical", func(f *candidateTokenFixture) { f.elevated = ^uint32(0) }, "token class 20"},
		{"missing-profile", func(f *candidateTokenFixture) { f.profile = nil }, "SID outside"},
		{"wrong-profile", func(f *candidateTokenFixture) { f.profile, _ = windows.StringToSid("S-1-15-2-9-8-7-6-5-4-3") }, "SID mismatch"},
		{"one-capability", func(f *candidateTokenFixture) { f.capabilities = 1 }, "capabilities must be empty"},
		{"missing-integrity", func(f *candidateTokenFixture) { f.integrity = nil }, "SID outside"},
		{"medium-integrity", func(f *candidateTokenFixture) { f.integrity, _ = windows.StringToSid("S-1-16-8192") }, "not Low"},
		{"untrusted-integrity", func(f *candidateTokenFixture) { f.integrity, _ = windows.StringToSid("S-1-16-0") }, "not Low"},
		{"wrong-integrity-authority", func(f *candidateTokenFixture) { f.integrity, _ = windows.StringToSid("S-1-5-4096") }, "not Low"},
		{"extra-integrity-subauthority", func(f *candidateTokenFixture) { f.integrity, _ = windows.StringToSid("S-1-16-4096-0") }, "not Low"},
		{"not-integrity-label", func(f *candidateTokenFixture) { f.integrityAttributes = 0 }, "not Low"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := goodCandidateToken(t)
			tc.edit(f)
			err := verifyWindowsAppContainerToken(0, candidatePolicy(t, true), candidateFakeVerification(f.query))
			if tc.want == "" && err != nil || tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)) {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
		})
	}
}

func TestWindowsAppContainerTokenQueriesFailClosed(t *testing.T) {
	classes := []uint32{tokenIsAppContainer, windows.TokenElevation, tokenAppContainerSID, tokenCapabilities, windows.TokenIntegrityLevel}
	for _, class := range classes {
		for _, mode := range []string{"unsupported", "denied", "bad-length", "oversize", "zero", "zero-success", "truncated", "overreported", "changed-size", "error-after-write"} {
			t.Run(strings.Join([]string{windowsClassName(class), mode}, "/"), func(t *testing.T) {
				f := goodCandidateToken(t)
				calls := 0
				query := func(token windows.Token, c uint32, out *byte, n uint32, used *uint32) error {
					if c != class {
						return f.query(token, c, out, n, used)
					}
					calls++
					switch mode {
					case "unsupported":
						return windows.ERROR_INVALID_PARAMETER
					case "denied":
						return windows.ERROR_ACCESS_DENIED
					case "bad-length":
						return windows.ERROR_BAD_LENGTH
					case "oversize":
						*used = maxCandidateTokenBytes + 1
						return windows.ERROR_INSUFFICIENT_BUFFER
					case "zero":
						*used = 0
						return windows.ERROR_INSUFFICIENT_BUFFER
					}
					if out != nil {
						if mode == "error-after-write" {
							if err := f.query(token, c, out, n, used); err != nil {
								return err
							}
							return windows.ERROR_BAD_LENGTH // even correct bytes/size with an error deny
						}
						if mode == "zero-success" {
							*used = 0
							return nil
						}
						if mode == "changed-size" {
							return windows.ERROR_INSUFFICIENT_BUFFER
						}
						if mode == "overreported" {
							*used = n + 1
						} else {
							*used = 1
						}
						return nil
					}
					return f.query(token, c, out, n, used)
				}
				if err := verifyWindowsAppContainerToken(0, candidatePolicy(t, true), candidateFakeVerification(query)); err == nil {
					t.Fatal("accepted failed/malformed token query")
				}
				switch class {
				case tokenIsAppContainer, windows.TokenElevation, tokenIsLessPrivilegedAppContainer:
					if calls != 1 {
						t.Fatalf("fixed-field failure retried/probed: calls=%d", calls)
					}
				}
			})
		}
	}
}

func windowsClassName(class uint32) string {
	return map[uint32]string{29: "is-appcontainer", 20: "elevation", 31: "profile", 30: "capabilities", 25: "integrity", 46: "lpac"}[class]
}

func TestWindowsAppContainerSIDBufferBounds(t *testing.T) {
	for _, class := range []uint32{tokenAppContainerSID, windows.TokenIntegrityLevel} {
		for _, mode := range []string{"external", "header", "unaligned", "truncated", "count", "revision"} {
			t.Run(windowsClassName(class)+"/"+mode, func(t *testing.T) {
				f := goodCandidateToken(t)
				query := func(token windows.Token, c uint32, out *byte, n uint32, used *uint32) error {
					err := f.query(token, c, out, n, used)
					if err != nil || out == nil || c != class {
						return err
					}
					// Both SDK layouts begin with PSID.
					ptr := (**windows.SID)(unsafe.Pointer(out))
					sid := *ptr
					switch mode {
					case "external":
						*ptr = f.profile
					case "header":
						*ptr = (*windows.SID)(unsafe.Pointer(out))
					case "unaligned":
						*ptr = (*windows.SID)(unsafe.Add(unsafe.Pointer(sid), 1))
					case "truncated":
						*used -= 1
					case "count":
						unsafe.Slice((*byte)(unsafe.Pointer(sid)), 8)[1] = 255
					case "revision":
						*(*byte)(unsafe.Pointer(sid)) = 2
					}
					return nil
				}
				if err := verifyWindowsAppContainerToken(0, candidatePolicy(t, true), candidateFakeVerification(query)); err == nil {
					t.Fatal("accepted invalid embedded SID")
				}
			})
		}
	}
}

func TestWindowsAppContainerAttributeFailureNeverCreatesTarget(t *testing.T) {
	for _, refused := range []uintptr{procThreadAttributeSecurityCapabilities, procThreadAttributeAllPackagesPolicy} {
		dir := t.TempDir()
		sentinel := errors.New("synthetic required attribute unavailable")
		reached, duplicated := false, false
		tr, err := startWindowsOwned(context.Background(), windowsHelperCommand(dir, "hold"), windowsLaunchHooks{
			beforeAttribute: func(attr uintptr) error {
				if attr == refused {
					reached = true
					return sentinel
				}
				// The prerequisite security attribute must still install. An
				// unsupported OS is a failure, not a generic accepted error.
				return nil
			},
			duplicateStdio: func(h windows.Handle) (windows.Handle, error) {
				duplicated = true
				return duplicateWindowsStdio(h)
			},
		}, candidatePolicy(t, true))
		if tr != nil {
			_ = tr.Close()
		}
		if tr != nil || !reached || duplicated || !errors.Is(err, sentinel) {
			t.Fatalf("attribute refusal failed closed: tree=%v reached=%v duplicates=%v err=%v", tr, reached, duplicated, err)
		}
		if _, err := os.Stat(filepath.Join(dir, "hold.started")); !os.IsNotExist(err) {
			t.Fatalf("marker before attribute acceptance: %v", err)
		}
	}
}

func TestWindowsAppContainerOrdinaryStartStillTwoAttributes(t *testing.T) {
	dir := t.TempDir()
	var seen []uintptr
	var observed windows.Handle
	stop := errors.New("synthetic stop while suspended")
	tr, err := startWindows(context.Background(), windowsHelperCommand(dir, "hold"), windowsLaunchHooks{
		beforeAttribute: func(attr uintptr) error { seen = append(seen, attr); return nil },
		beforeResume: func(pi windows.ProcessInformation, job windows.Handle) error {
			if err := windows.DuplicateHandle(windows.CurrentProcess(), pi.Process, windows.CurrentProcess(), &observed, windows.SYNCHRONIZE, false, 0); err != nil {
				return err
			}
			t.Cleanup(func() { _ = windows.CloseHandle(observed) })
			// Native negative control: this owned ordinary child must NOT pass
			// the candidate token gate. Query through its retained handle only.
			var token windows.Token
			if err := windows.OpenProcessToken(pi.Process, windows.TOKEN_QUERY, &token); err != nil {
				return err
			}
			defer token.Close()
			// Exercise the real fixed-size elevation query independently: the
			// ordinary negative gate stops at class 29. CI may be elevated, so
			// require only exact DWORD layout, not the candidate's zero value.
			elevation, err := queryCandidateDWORD(token, windows.TokenElevation, windows.GetTokenInformation)
			if err != nil {
				return err
			}
			elevated, err := elevation.dword()
			if err != nil {
				return err
			}
			t.Logf("ordinary suspended TokenElevation DWORD: elevated=%v", elevated != 0)
			dependencies, err := newNativeAppContainerVerification()
			if err != nil {
				return err
			}
			checker := dependencies.checkLPAC
			dependencies.checkLPAC = func(source windows.Token, profile []byte) error {
				t.Error("non-AppContainer token reached semantic checker")
				return checker(source, profile)
			}
			if err := verifyWindowsAppContainerToken(token, candidatePolicy(t, true), dependencies); err == nil || !strings.Contains(err.Error(), "token class 29") {
				t.Errorf("ordinary child passed or failed unrelated token check: %v", err)
			}
			return stop
		},
	})
	if tr != nil {
		_ = tr.Close()
	}
	if tr != nil || !errors.Is(err, stop) || len(seen) != 2 || seen[0] != procThreadAttributeJobList || seen[1] != windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST {
		t.Fatalf("ordinary Start changed: attrs=%v tree=%v err=%v", seen, tr, err)
	}
	if event, err := windows.WaitForSingleObject(observed, 0); err != nil || event != windows.WAIT_OBJECT_0 {
		t.Fatalf("refused owned child was not reaped: event=%d err=%v", event, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "hold.started")); !os.IsNotExist(err) {
		t.Fatalf("ordinary child executed before negative token gate: %v", err)
	}
}
