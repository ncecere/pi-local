//go:build windows

package process

import (
	"encoding/binary"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// System boundaries only: no acquisition of native tokens, profiles or children.
// Reuses the first diagnostic's synthetic, bounded native-record encoder.
type restrictionFake struct {
	f                *diagFake
	api              restrictionAPI
	creates, sets    int
	current, derived int // full inspection counts, via TokenElevationType
}

func newRestrictionFake(t *testing.T) *restrictionFake {
	t.Helper()
	f := newDiagFake(t)
	current := f.tokens[10]
	current.elevationType = 1 // measured first-stage runner: Default + elevated
	current.groups[0] = diagGroup{true, windows.SE_GROUP_ENABLED}
	current.privileges = []diagPrivilege{{"SeDebugPrivilege", windows.SE_PRIVILEGE_ENABLED}}
	f.tokens[10] = current
	candidate := f.tokens[12]
	candidate.elevationType, candidate.il = 1, 0x3000
	candidate.privileges = []diagPrivilege{{"SeDebugPrivilege", 0}}
	f.tokens[12] = candidate
	r := &restrictionFake{f: f}
	r.api = restrictionAPI{
		inspect: f.api,
		create: func(in windows.Token, flags, dc uint32, disable *windows.SIDAndAttributes, pc uint32, delete *windows.LUIDAndAttributes, rc uint32, restrict *windows.SIDAndAttributes, out *windows.Token) error {
			r.creates++
			if in != 10 || flags != 0x5 || dc != 0 || disable != nil || pc != 0 || delete != nil || rc != 0 || restrict != nil || out == nil || *out != 0 {
				t.Fatal("CreateRestrictedToken explicit input/flags/NULL/output contract violated")
			}
			*out = 12
			return nil
		},
		set: func(token windows.Token, class uint32, data *byte, n uint32) error {
			r.sets++
			if token != 12 || class != windows.TokenIntegrityLevel || f.tokens[12].il <= 0x2000 {
				t.Fatal("Set reached original/unowned token, wrong class or non-downward operation")
			}
			header := unsafe.Sizeof(windows.Tokenmandatorylabel{})
			if data == nil || uintptr(unsafe.Pointer(data))%unsafe.Alignof(windows.Tokenmandatorylabel{}) != 0 || uintptr(n) != header+12 {
				t.Fatal("label buffer alignment/exact bound violated")
			}
			// Stress lifetime while the boundary holds the pointer; validate only
			// after bounds/layout, and never format pointers, SID or buffer bytes.
			runtime.GC()
			runtime.Gosched()
			label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(data))
			if unsafe.Pointer(label.Label.Sid) != unsafe.Add(unsafe.Pointer(data), header) || label.Label.Attributes != windows.SE_GROUP_INTEGRITY {
				t.Fatal("label SID not embedded immediately after aligned header")
			}
			raw := unsafe.Slice(data, int(n))[header:]
			if string(raw[:8]) != string([]byte{1, 1, 0, 0, 0, 0, 0, 16}) || binary.LittleEndian.Uint32(raw[8:]) != 0x2000 {
				t.Fatal("label payload not exactly Go-owned medium integrity SID")
			}
			s := f.tokens[12]
			s.il = 0x2000
			f.tokens[12] = s
			return nil
		},
	}
	open := r.api.inspect.open
	r.api.inspect.open = func(process windows.Handle, access uint32, out *windows.Token) error {
		if access != windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_ADJUST_DEFAULT {
			t.Fatal("restriction input access must request the exact derived-label prerequisite up front")
		}
		// Reuse only the original fake's ownership encoder; the requested
		// restriction-stage access mask has already been independently asserted.
		return open(process, windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, out)
	}
	r.api.inspect.query = func(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
		if class == windows.TokenLinkedToken {
			t.Fatal("third experiment must not query linked tokens")
		}
		if class == windows.TokenElevationType {
			if token == 10 {
				r.current++
			} else if token == 12 {
				r.derived++
			}
		}
		return f.query(token, class, out, n, used)
	}
	return r
}

func (r *restrictionFake) run() (string, error) {
	var lines []string
	err := restrictionRun(r.api, func(s string) { lines = append(lines, s) })
	return strings.Join(lines, "\n"), err
}

func (r *restrictionFake) closed(t *testing.T, input, derived int) {
	t.Helper()
	if r.f.closed[10] != input || r.f.closed[12] != derived || r.f.closed[11] != 0 || len(r.f.closed) != input+derived || r.f.levelsClosed != 0 || r.f.computed != 0 || r.f.linkedQueries != 0 {
		t.Fatal("ownership cleanup count or first-stage isolation violated")
	}
}

func TestWindowsTokenRestrictionDiagnosticFakeMeasuresActualMetadata(t *testing.T) {
	for _, tc := range []struct {
		name   string
		edit   func(*diagSnapshot)
		sets   int
		reason string
	}{
		{"high-lowered-and-requeried", func(*diagSnapshot) {}, 1, ""},
		{"already-medium-requeried-without-set", func(s *diagSnapshot) { s.il = 0x2000 }, 0, ""},
		{"medium-plus-lowered", func(s *diagSnapshot) { s.il = 0x2100 }, 1, ""},
		{"low-never-raised", func(s *diagSnapshot) { s.il = 0x1000 }, 0, "label increase refused"},
		{"untrusted-never-raised", func(s *diagSnapshot) { s.il = 0 }, 0, "label increase refused"},
		{"unknown-integrity-refused", func(s *diagSnapshot) { s.il = 0x2222 }, 0, "known-integrity gate refused"},
		{"unverified-integrity-refused", func(s *diagSnapshot) { s.il = 0x200a }, 0, "known-integrity gate refused"},
		{"elevation-one-never-waived", func(s *diagSnapshot) { s.elevation = 1 }, 1, "elevation-not-exact-zero"},
		{"noncanonical-elevation-refused", func(s *diagSnapshot) { s.elevation = 2 }, 1, "elevation-not-exact-zero"},
		{"Full-type-refused", func(s *diagSnapshot) { s.elevationType = 2 }, 1, "Full-elevation-type-refused"},
		{"invalid-type-refused", func(s *diagSnapshot) { s.elevationType = 4 }, 1, "invalid-elevation-type"},
		{"zero-type-refused", func(s *diagSnapshot) { s.elevationType = 0 }, 1, "invalid-elevation-type"},
		{"Limited-type-allowed", func(s *diagSnapshot) { s.elevationType = 3 }, 1, ""},
		{"ordinary-enabled-allowed", func(s *diagSnapshot) {
			s.privileges = []diagPrivilege{{"SeChangeNotifyPrivilege", windows.SE_PRIVILEGE_ENABLED}}
		}, 1, ""},
		{"not-primary-no-label", func(s *diagSnapshot) { s.tokenType = 2 }, 0, "not-primary"},
		{"different-session-no-label", func(s *diagSnapshot) { s.session++ }, 0, "session-mismatch"},
		{"admin-enabled-refused", func(s *diagSnapshot) { s.groups[0].attrs |= windows.SE_GROUP_ENABLED }, 1, "administrative-SID-not-deny-only"},
		{"admin-disabled-not-deny-only-refused", func(s *diagSnapshot) { s.groups[0].attrs = 0 }, 1, "administrative-SID-not-deny-only"},
		{"power-users-enabled-refused", func(s *diagSnapshot) { s.groups[1] = diagGroup{true, windows.SE_GROUP_ENABLED} }, 1, "administrative-SID-not-deny-only"},
		{"groups-absent-allowed", func(s *diagSnapshot) { s.groups = [2]diagGroup{} }, 1, ""},
		{"admin-privilege-enabled-refused", func(s *diagSnapshot) {
			s.privileges = []diagPrivilege{{"SeDebugPrivilege", windows.SE_PRIVILEGE_ENABLED}}
		}, 1, "enabled-administrative-privilege"},
		{"unknown-enabled-privilege-refused", func(s *diagSnapshot) { s.privileges = []diagPrivilege{{"unknown", windows.SE_PRIVILEGE_ENABLED}} }, 1, "unclassified-enabled-privilege"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRestrictionFake(t)
			s := r.f.tokens[12]
			tc.edit(&s)
			r.f.tokens[12] = s
			log, err := r.run()
			if (err == nil) != (tc.reason == "") || (tc.reason != "" && !strings.Contains(log, tc.reason)) || r.sets != tc.sets || r.creates != 1 || r.current != 2 || r.derived != 2 {
				t.Fatal("expected metadata verdict, downward-only gate or full reinspection missing")
			}
			for _, marker := range []string{"restriction-current-before", "restriction-derived-PRELABEL", "restriction-derived-POSTLABEL", "current-inspected-metadata-unchanged=true", "METADATA-ONLY", "disabled-administrative-privileges-may-be-enableable"} {
				if !strings.Contains(log, marker) {
					t.Fatal("required checkpoint/caveat missing")
				}
			}
			r.closed(t, 1, 1)
		})
	}
}

func TestWindowsTokenRestrictionDiagnosticFakeDifferentUserPreventsLabel(t *testing.T) {
	r := newRestrictionFake(t)
	other, err := windows.StringToSid("S-1-5-21-999-888-777-666")
	if err != nil {
		t.Fatal("synthetic SID creation failed")
	}
	s := r.f.tokens[12]
	s.user = other
	r.f.tokens[12] = s
	log, err := r.run()
	if err == nil || r.sets != 0 || !strings.Contains(log, "user-mismatch") {
		t.Fatal("different user reached label or passed")
	}
	r.closed(t, 1, 1)
}

func TestWindowsTokenRestrictionDiagnosticFakeCreateOwnership(t *testing.T) {
	for _, out := range []windows.Token{0, 10, 12, windows.Token(^uintptr(0)), windows.Token(^uintptr(0) - 3)} {
		for _, failed := range []bool{false, true} {
			t.Run(fmt.Sprintf("output-case-%d-failed-%v", indexRestrictionHandle(out), failed), func(t *testing.T) {
				r := newRestrictionFake(t)
				create := r.api.create
				r.api.create = func(in windows.Token, flags, dc uint32, ds *windows.SIDAndAttributes, pc uint32, ps *windows.LUIDAndAttributes, rc uint32, rs *windows.SIDAndAttributes, p *windows.Token) error {
					_ = create(in, flags, dc, ds, pc, ps, rc, rs, p) // validate exact call
					*p = out
					if failed {
						return windows.ERROR_ACCESS_DENIED
					}
					return nil
				}
				_, err := r.run()
				valid := out == 12 && !failed
				if (err == nil) != valid || (!valid && (r.sets != 0 || r.derived != 0)) || r.current != 2 {
					t.Fatal("failed/alias/reserved output reached label/query or passed")
				}
				ownedOutput := 0
				if out == 12 {
					ownedOutput = 1 // even FALSE with partial output
				}
				r.closed(t, 1, ownedOutput)
			})
		}
	}
}

// Test labels are CASE NUMBERS, never handle values (including fake handles).
func indexRestrictionHandle(h windows.Token) int {
	for i, candidate := range []windows.Token{0, 10, 12, windows.Token(^uintptr(0)), windows.Token(^uintptr(0) - 3)} {
		if h == candidate {
			return i
		}
	}
	return -1
}

func TestWindowsTokenRestrictionDiagnosticFakeOpenOwnership(t *testing.T) {
	for _, out := range []windows.Token{0, 10, windows.Token(^uintptr(0))} {
		for _, failed := range []bool{false, true} {
			t.Run(fmt.Sprintf("output-case-%d-failed-%v", indexRestrictionHandle(out), failed), func(t *testing.T) {
				r := newRestrictionFake(t)
				open := r.api.inspect.open
				r.api.inspect.open = func(p windows.Handle, access uint32, token *windows.Token) error {
					_ = open(p, access, token)
					*token = out
					if failed {
						return windows.ERROR_ACCESS_DENIED
					}
					return nil
				}
				_, err := r.run()
				valid := out == 10 && !failed
				if (err == nil) != valid || (!valid && (r.creates != 0 || r.sets != 0)) {
					t.Fatal("failed/reserved open reached derivation or passed")
				}
				ownedInput := 0
				if out == 10 {
					ownedInput = 1
				}
				ownedOutput := 0
				if valid {
					ownedOutput = 1
				}
				r.closed(t, ownedInput, ownedOutput)
			})
		}
	}
}

func TestWindowsTokenRestrictionDiagnosticFakePostlabelIsMeasuredNotAssumed(t *testing.T) {
	for _, mode := range []string{"success-no-change", "success-elevation-still-one", "success-new-enabled-admin", "failure-despite-good-post", "failure-no-change"} {
		t.Run(mode, func(t *testing.T) {
			r := newRestrictionFake(t)
			set := r.api.set
			r.api.set = func(token windows.Token, class uint32, data *byte, n uint32) error {
				before := r.f.tokens[12]
				_ = set(token, class, data, n)
				s := r.f.tokens[12]
				switch mode {
				case "success-no-change", "failure-no-change":
					s = before
				case "success-elevation-still-one":
					s.elevation = 1
				case "success-new-enabled-admin":
					s.privileges = []diagPrivilege{{"SeDebugPrivilege", windows.SE_PRIVILEGE_ENABLED}}
				}
				r.f.tokens[12] = s
				if strings.HasPrefix(mode, "failure") {
					return errors.New("PRIVATE-provider-key-path-account")
				}
				return nil
			}
			log, err := r.run()
			if err == nil || r.derived != 2 || !strings.Contains(log, "restriction-derived-POSTLABEL") || strings.Contains(log+err.Error(), "PRIVATE") {
				t.Fatal("postlabel metadata or sticky sanitized Set failure missing")
			}
			r.closed(t, 1, 1)
		})
	}
}

func TestWindowsTokenRestrictionDiagnosticFakeMalformedInspectionFailsClosed(t *testing.T) {
	for _, phase := range []string{"pre", "post", "current-before", "current-after"} {
		for _, mode := range []string{"DWORD-denied", "DWORD-length", "IL-count", "user-outside", "groups-count", "privileges-count"} {
			t.Run(phase+"/"+mode, func(t *testing.T) {
				r := newRestrictionFake(t)
				query := r.api.inspect.query
				r.api.inspect.query = func(token windows.Token, class uint32, data *byte, n uint32, used *uint32) error {
					err := query(token, class, data, n, used)
					selected := (phase == "pre" && token == 12 && r.derived == 1) || (phase == "post" && token == 12 && r.derived == 2) || (phase == "current-before" && token == 10 && r.current == 1) || (phase == "current-after" && token == 10 && r.current == 2)
					if !selected || err != nil || data == nil {
						return err
					}
					switch {
					case class == windows.TokenElevation && mode == "DWORD-denied":
						return errors.New("PRIVATE-identity-path")
					case class == windows.TokenElevation && mode == "DWORD-length":
						*used = 8
					case class == windows.TokenIntegrityLevel && mode == "IL-count":
						p := (*windows.Tokenmandatorylabel)(unsafe.Pointer(data))
						unsafe.Slice((*byte)(unsafe.Pointer(p.Label.Sid)), 8)[1] = 15
					case class == windows.TokenUser && mode == "user-outside":
						(*windows.Tokenuser)(unsafe.Pointer(data)).User.Sid = r.f.tokens[10].user
					case class == windows.TokenGroups && mode == "groups-count", class == windows.TokenPrivileges && mode == "privileges-count":
						binary.LittleEndian.PutUint32(unsafe.Slice(data, 4), ^uint32(0))
					}
					return nil
				}
				log, err := r.run()
				if err == nil || strings.Contains(log+err.Error(), "PRIVATE") || ((phase == "pre" || phase == "current-before") && r.sets != 0) {
					t.Fatal("malformed/error inspection accepted, leaked, or reached label")
				}
				derived := 1
				if phase == "current-before" {
					derived = 0
				}
				r.closed(t, 1, derived)
			})
		}
	}
}

func TestWindowsTokenRestrictionDiagnosticFakeCurrentWitnessAndCloseAreSticky(t *testing.T) {
	for _, mode := range []string{"current-label-changed", "current-elevation-changed", "input-close", "derived-close", "privilege-lookup"} {
		t.Run(mode, func(t *testing.T) {
			r := newRestrictionFake(t)
			if mode == "privilege-lookup" {
				r.api.inspect.privilegeIDs = func() (map[windows.LUID]string, error) { return nil, errors.New("PRIVATE-lookup") }
			} else if strings.HasSuffix(mode, "close") {
				close := r.api.inspect.closeToken
				r.api.inspect.closeToken = func(h windows.Handle) error {
					_ = close(h)
					if (mode == "input-close" && h == 10) || (mode == "derived-close" && h == 12) {
						return errors.New("PRIVATE-close")
					}
					return nil
				}
			} else {
				set := r.api.set
				r.api.set = func(token windows.Token, class uint32, data *byte, n uint32) error {
					_ = set(token, class, data, n)
					s := r.f.tokens[10]
					if mode == "current-label-changed" {
						s.il = 0x2000
					} else {
						s.elevation = 0
					}
					r.f.tokens[10] = s
					return nil
				}
			}
			log, err := r.run()
			if err == nil || strings.Contains(log+err.Error(), "PRIVATE") || (strings.HasPrefix(mode, "current") && !strings.Contains(log, "current-inspected-metadata-unchanged=false")) {
				t.Fatal("witness/close/lookup failure not sticky or sanitized")
			}
			derived := 1
			if mode == "privilege-lookup" {
				derived = 0
			}
			r.closed(t, 1, derived)
		})
	}
}

func TestWindowsTokenRestrictionDiagnosticFakeOwnerAndBOOLContracts(t *testing.T) {
	for _, h := range []windows.Handle{0, windows.CurrentProcess(), windows.Handle(^uintptr(0) - 3)} {
		r := newRestrictionFake(t)
		if _, err := restrictionCreate(windows.Token(h), r.api); err == nil || r.creates != 0 {
			t.Fatal("reserved input reached Create")
		}
	}
	r := newRestrictionFake(t)
	current, pre := r.f.tokens[10], r.f.tokens[12]
	for _, owner := range []*diagOwned{nil, {h: 0}, {h: 10}, {h: windows.CurrentProcess()}, {h: 12, attempted: true}} {
		if err := restrictionLower(10, owner, pre, current, r.api); err == nil || r.sets != 0 {
			t.Fatal("absent/alias/pseudo/released owner reached Set")
		}
	}
	for _, snapshot := range []diagSnapshot{{}, {complete: true, tokenType: 1, il: 0x3000}} {
		if err := restrictionLower(10, &diagOwned{h: 12}, snapshot, current, r.api); err == nil || r.sets != 0 {
			t.Fatal("incomplete/missing identity reached Set")
		}
	}
	for _, result := range []uintptr{0, 1, 2, 0x80000000, 0xffffffff} {
		for _, last := range []error{nil, syscall.Errno(0), syscall.Errno(5), errors.New("PRIVATE-stale-error")} {
			err := diagBOOL("restriction-BOOL", result, last)
			if (err == nil) != (uint32(result) != 0) || (err != nil && strings.Contains(err.Error(), "PRIVATE")) {
				t.Fatal("BOOL treated as HRESULT, stale last error used on success, or private text leaked")
			}
		}
	}
	calls := 0
	owner := &diagOwned{h: 12, close: func(windows.Handle) error { calls++; return windows.ERROR_ACCESS_DENIED }}
	if owner.release() == nil || owner.release() == nil || calls != 1 {
		t.Fatal("failed close retried or lost sticky failure")
	}
}

func TestWindowsTokenRestrictionDiagnosticFakePrivacyAndNativePreflight(t *testing.T) {
	r := newRestrictionFake(t)
	log, err := r.run()
	if err != nil {
		t.Fatal("synthetic metadata case failed")
	}
	for _, secret := range []string{"S-1-", "987654321", "111-222", "LUID", "TokenId", "AuthenticationId", "0xc000"} {
		if strings.Contains(log, secret) {
			t.Fatal("identity/pointer/token identifier leaked")
		}
	}
	for _, values := range [][4]string{{}, {"1", "true", "github-hosted", "Windows"}, {"", "true", "github-hosted", "Windows"}, {"1", "true", "self-hosted", "Windows"}, {"1", "True", "github-hosted", "Windows"}, {"1", "true", "github-hosted", "Darwin"}} {
		skip, err := diagCIPrerequisite(values[0], values[1], values[2], values[3])
		ordinary := values == [4]string{}
		valid := values == [4]string{"1", "true", "github-hosted", "Windows"}
		if skip != ordinary || (err == nil) != (ordinary || valid) {
			t.Fatal("native four-exact-environment fail-closed contract violated")
		}
	}
}

func TestWindowsTokenRestrictionDiagnosticFakeWitnessComparesEveryCapturedField(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*diagSnapshot)
	}{
		{"complete", func(s *diagSnapshot) { s.complete = false }},
		{"type", func(s *diagSnapshot) { s.tokenType++ }},
		{"elevation", func(s *diagSnapshot) { s.elevation++ }},
		{"elevation-type", func(s *diagSnapshot) { s.elevationType++ }},
		{"session", func(s *diagSnapshot) { s.session++ }},
		{"integrity", func(s *diagSnapshot) { s.il++ }},
		{"identity", func(s *diagSnapshot) { s.user = nil }},
		{"group-presence", func(s *diagSnapshot) { s.groups[1].present = true }},
		{"group-attributes", func(s *diagSnapshot) { s.groups[0].attrs++ }},
		{"privileges", func(s *diagSnapshot) { s.privileges = []diagPrivilege{{"SeDebugPrivilege", 0}} }},
		{"enabled-admin", func(s *diagSnapshot) { s.enabledAdmin = !s.enabledAdmin }},
		{"unknown-enabled", func(s *diagSnapshot) { s.unknownEnabled = !s.unknownEnabled }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRestrictionFake(t)
			s := r.f.tokens[10]
			if !restrictionSame(s, s) {
				t.Fatal("identical inspected metadata rejected")
			}
			tc.edit(&s)
			if restrictionSame(r.f.tokens[10], s) {
				t.Fatal("captured metadata change not detected")
			}
		})
	}
}
