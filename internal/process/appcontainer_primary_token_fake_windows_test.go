//go:build windows

package process

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// No native token acquisition/profiles/processes in the metadata/owner fakes.
type candidatePrimaryFake struct {
	api                  candidatePrimaryAPI
	tokens               map[windows.Token]candidatePrimarySnapshot
	closes               map[windows.Token]int
	sets, creates, opens int
}

func newCandidatePrimaryFake(t *testing.T) *candidatePrimaryFake {
	t.Helper()
	user := candidateSIDBytes(5, 2, 21)
	admin := candidateSIDBytes(5, 2, 32)
	binary.LittleEndian.PutUint32(admin[12:], 544)
	f := &candidatePrimaryFake{closes: make(map[windows.Token]int), tokens: map[windows.Token]candidatePrimarySnapshot{
		10: {complete: true, elevationType: 1, elevation: 1, kind: 1, session: 987654321, il: 0x3000, user: user, integrityAttributes: windows.SE_GROUP_INTEGRITY, privileges: []windows.LUIDAndAttributes{{Luid: windows.LUID{LowPart: 99}, Attributes: 2}}},
		12: {complete: true, elevationType: 1, kind: 1, session: 987654321, il: 0x3000, user: user, integrityAttributes: windows.SE_GROUP_INTEGRITY, groups: []candidatePrimaryGroup{{admin, windows.SE_GROUP_USE_FOR_DENY_ONLY}}, privileges: []windows.LUIDAndAttributes{{Luid: windows.LUID{LowPart: 1}, Attributes: 2}}},
	}}
	f.api = candidatePrimaryAPI{
		query: f.query,
		open: func(process windows.Handle, rights uint32, out *windows.Token) error {
			f.opens++
			if process != windows.CurrentProcess() || rights != windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_ASSIGN_PRIMARY|windows.TOKEN_ADJUST_DEFAULT || *out != 0 {
				t.Fatal("input access/current primary/output contract")
			}
			*out = 10
			return nil
		},
		close:    func(token windows.Token) error { f.closes[token]++; return nil },
		ordinary: func() (map[windows.LUID]bool, error) { return map[windows.LUID]bool{{LowPart: 1}: true}, nil },
		create: func(in windows.Token, out *windows.Token) error {
			f.creates++
			if in != 10 || *out != 0 {
				t.Fatal("explicit input/zero output contract")
			}
			*out = 12
			return nil
		},
		set: func(token windows.Token, class uint32, out *byte, n uint32) error {
			f.sets++
			if token != 12 || class != windows.TokenIntegrityLevel {
				t.Fatal("label targeted original or wrong class")
			}
			header := unsafe.Sizeof(windows.Tokenmandatorylabel{})
			if out == nil || uintptr(n) != header+12 || uintptr(unsafe.Pointer(out))%unsafe.Alignof(windows.Tokenmandatorylabel{}) != 0 {
				t.Fatal("label alignment/extent")
			}
			runtime.GC()
			runtime.Gosched()
			label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(out))
			if unsafe.Pointer(label.Label.Sid) != unsafe.Add(unsafe.Pointer(out), header) || label.Label.Attributes != windows.SE_GROUP_INTEGRITY {
				t.Fatal("embedded SID lifetime/provenance")
			}
			data := unsafe.Slice(out, n)[header:]
			if !candidateSIDMatches(data, [6]byte{0, 0, 0, 0, 0, 16}, 1, 0x2000) {
				t.Fatal("label payload")
			}
			s := f.tokens[token]
			s.il = 0x2000
			f.tokens[token] = s
			return nil
		},
	}
	return f
}
func (f *candidatePrimaryFake) query(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
	s, ok := f.tokens[token]
	if !ok {
		return windows.ERROR_INVALID_HANDLE
	}
	var value uint32
	switch class {
	case windows.TokenElevationType:
		value = s.elevationType
	case windows.TokenElevation:
		value = s.elevation
	case windows.TokenType:
		value = s.kind
	case windows.TokenSessionId:
		value = s.session
	default:
		return f.variable(s, class, out, n, used)
	}
	*used = 4
	if out == nil || n != 4 {
		return windows.ERROR_BAD_LENGTH
	}
	binary.LittleEndian.PutUint32(unsafe.Slice(out, n), value)
	return nil
}
func (f *candidatePrimaryFake) variable(s candidatePrimarySnapshot, class uint32, out *byte, n uint32, used *uint32) error {
	var header, entry uintptr
	var payload []byte
	switch class {
	case windows.TokenUser:
		header = unsafe.Sizeof(windows.Tokenuser{})
		payload = s.user
	case windows.TokenIntegrityLevel:
		header = unsafe.Sizeof(windows.Tokenmandatorylabel{})
		payload = candidateSIDBytes(16, 1, s.il)
	case windows.TokenGroups:
		header = unsafe.Offsetof(windows.Tokengroups{}.Groups)
		entry = unsafe.Sizeof(windows.SIDAndAttributes{})
		for _, g := range s.groups {
			payload = append(payload, g.sid...)
		}
	case windows.TokenPrivileges:
		header = unsafe.Offsetof(windows.Tokenprivileges{}.Privileges)
		entry = unsafe.Sizeof(windows.LUIDAndAttributes{})
	default:
		return windows.ERROR_INVALID_PARAMETER
	}
	total := header + uintptr(len(payload))
	if class == windows.TokenGroups {
		total += uintptr(len(s.groups)) * entry
	}
	if class == windows.TokenPrivileges {
		total += uintptr(len(s.privileges)) * entry
	}
	*used = uint32(total)
	if out == nil || uintptr(n) < total {
		return windows.ERROR_INSUFFICIENT_BUFFER
	}
	data := unsafe.Slice(out, n)
	clear(data)
	switch class {
	case windows.TokenUser:
		copy(data[header:], payload)
		u := (*windows.Tokenuser)(unsafe.Pointer(out))
		u.User.Sid = (*windows.SID)(unsafe.Pointer(&data[header]))
		u.User.Attributes = s.userAttributes
	case windows.TokenIntegrityLevel:
		copy(data[header:], payload)
		l := (*windows.Tokenmandatorylabel)(unsafe.Pointer(out))
		l.Label.Sid = (*windows.SID)(unsafe.Pointer(&data[header]))
		l.Label.Attributes = s.integrityAttributes
	case windows.TokenGroups:
		binary.LittleEndian.PutUint32(data, uint32(len(s.groups)))
		offset := header + uintptr(len(s.groups))*entry
		for i, g := range s.groups {
			p := (*windows.SIDAndAttributes)(unsafe.Pointer(&data[header+uintptr(i)*entry]))
			p.Attributes = g.attrs
			p.Sid = (*windows.SID)(unsafe.Pointer(&data[offset]))
			copy(data[offset:], g.sid)
			offset += uintptr(len(g.sid))
		}
	case windows.TokenPrivileges:
		binary.LittleEndian.PutUint32(data, uint32(len(s.privileges)))
		for i, p := range s.privileges {
			*(*windows.LUIDAndAttributes)(unsafe.Pointer(&data[header+uintptr(i)*entry])) = p
		}
	}
	return nil
}
func (f *candidatePrimaryFake) assertClosed(t *testing.T, input, derived int) {
	t.Helper()
	if f.closes[10] != input || f.closes[12] != derived || len(f.closes) != input+derived {
		t.Fatal("owner close/alias/reserved contract")
	}
}
func TestWindowsPrimaryStrictPresencePredicate(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*candidatePrimarySnapshot)
		pass   bool
	}{
		{"ordinary-present", func(*candidatePrimarySnapshot) {}, true},
		{"absent-privileges", func(s *candidatePrimarySnapshot) { s.privileges = nil }, true},
		{"limited-type", func(s *candidatePrimarySnapshot) { s.elevationType = 3 }, true},
		{"absent-admin", func(s *candidatePrimarySnapshot) { s.groups = nil }, true},
		{"elevation-one", func(s *candidatePrimarySnapshot) { s.elevation = 1 }, false},
		{"elevation-noncanonical", func(s *candidatePrimarySnapshot) { s.elevation = 2 }, false},
		{"Full-type", func(s *candidatePrimarySnapshot) { s.elevationType = 2 }, false},
		{"invalid-type", func(s *candidatePrimarySnapshot) { s.elevationType = 4 }, false},
		{"zero-type", func(s *candidatePrimarySnapshot) { s.elevationType = 0 }, false},
		{"impersonation", func(s *candidatePrimarySnapshot) { s.kind = 2 }, false},
		{"session", func(s *candidatePrimarySnapshot) { s.session++ }, false},
		{"user", func(s *candidatePrimarySnapshot) { s.user = candidateSIDBytes(5, 1, 18) }, false},
		{"enabled-admin", func(s *candidatePrimarySnapshot) { s.groups[0].attrs |= windows.SE_GROUP_ENABLED }, false},
		{"default-enabled-admin", func(s *candidatePrimarySnapshot) { s.groups[0].attrs |= windows.SE_GROUP_ENABLED_BY_DEFAULT }, false},
		{"disabled-admin", func(s *candidatePrimarySnapshot) { s.groups[0].attrs = 0 }, false},
		{"enabled-power-user", func(s *candidatePrimarySnapshot) {
			binary.LittleEndian.PutUint32(s.groups[0].sid[12:], 547)
			s.groups[0].attrs = windows.SE_GROUP_ENABLED
		}, false},
		{"sensitive-disabled-present", func(s *candidatePrimarySnapshot) {
			s.privileges = []windows.LUIDAndAttributes{{Luid: windows.LUID{LowPart: 99}}}
		}, false},
		{"unknown-disabled-present", func(s *candidatePrimarySnapshot) {
			s.privileges = []windows.LUIDAndAttributes{{Luid: windows.LUID{HighPart: 123, LowPart: 999}}}
		}, false},
		{"unknown-enabled-present", func(s *candidatePrimarySnapshot) {
			s.privileges = []windows.LUIDAndAttributes{{Luid: windows.LUID{LowPart: 999}, Attributes: 2}}
		}, false},
		{"removed-still-present", func(s *candidatePrimarySnapshot) {
			s.privileges = []windows.LUIDAndAttributes{{Luid: windows.LUID{LowPart: 99}, Attributes: windows.SE_PRIVILEGE_REMOVED}}
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCandidatePrimaryFake(t)
			s := f.tokens[12]
			tc.change(&s)
			f.tokens[12] = s
			fixture, err := candidateAcquirePrimary(f.api)
			if (err == nil) != tc.pass {
				t.Fatalf("strict verdict pass=%v err=%v", tc.pass, err)
			}
			if err == nil {
				if err := fixture.close(); err != nil {
					t.Fatal(err)
				}
			}
			f.assertClosed(t, 1, 1)
		})
	}
}
func TestWindowsPrimaryLabelAndActualPostQuery(t *testing.T) {
	for _, il := range []uint32{0, 0x1000, 0x2000, 0x2100, 0x2222, 0x3000, 0x4000, 0x5000} {
		t.Run(fmt.Sprintf("IL-%x", il), func(t *testing.T) {
			f := newCandidatePrimaryFake(t)
			s := f.tokens[12]
			s.il = il
			f.tokens[12] = s
			fixture, err := candidateAcquirePrimary(f.api)
			pass := il == 0x2000 || il == 0x2100 || il == 0x3000 || il == 0x4000 || il == 0x5000
			if (err == nil) != pass {
				t.Fatal("known downward-only IL verdict")
			}
			sets := 0
			if pass && il != 0x2000 {
				sets = 1
			}
			if f.sets != sets {
				t.Fatal("unexpected Set count")
			}
			if err == nil {
				if err := fixture.close(); err != nil {
					t.Fatal(err)
				}
			}
			f.assertClosed(t, 1, 1)
		})
	}
	for _, mode := range []string{"success-no-change", "set-fails", "success-add-disabled-privilege", "current-mutated"} {
		t.Run(mode, func(t *testing.T) {
			f := newCandidatePrimaryFake(t)
			set := f.api.set
			f.api.set = func(token windows.Token, class uint32, b *byte, n uint32) error {
				before := f.tokens[12]
				if err := set(token, class, b, n); err != nil {
					return err
				}
				switch mode {
				case "success-no-change":
					f.tokens[12] = before
				case "success-add-disabled-privilege":
					s := f.tokens[12]
					s.privileges = append(s.privileges, windows.LUIDAndAttributes{Luid: windows.LUID{LowPart: 99}})
					f.tokens[12] = s
				case "current-mutated":
					s := f.tokens[10]
					s.il = 0x2000
					f.tokens[10] = s
				case "set-fails":
					return windows.ERROR_ACCESS_DENIED
				}
				return nil
			}
			if _, err := candidateAcquirePrimary(f.api); err == nil {
				t.Fatal("actual postquery/sticky set failure/witness missing")
			}
			f.assertClosed(t, 1, 1)
		})
	}
}
func TestWindowsPrimaryOwnershipFailures(t *testing.T) {
	for index, out := range []windows.Token{0, 10, 12, windows.Token(^uintptr(0)), windows.Token(^uintptr(0) - 3)} {
		for _, failed := range []bool{false, true} {
			t.Run(fmt.Sprintf("output-%d-failure-%v", index, failed), func(t *testing.T) {
				f := newCandidatePrimaryFake(t)
				f.api.create = func(in windows.Token, p *windows.Token) error {
					f.creates++
					*p = out
					if failed {
						return windows.ERROR_ACCESS_DENIED
					}
					return nil
				}
				fixture, err := candidateAcquirePrimary(f.api)
				pass := out == 12 && !failed
				if (err == nil) != pass || (!pass && f.sets != 0) {
					t.Fatal("alias/pseudo/failed output used")
				}
				if pass {
					if err := fixture.close(); err != nil {
						t.Fatal(err)
					}
				}
				derived := 0
				if out == 12 {
					derived = 1
				}
				f.assertClosed(t, 1, derived)
			})
		}
	}
	for _, stage := range []string{"open-partial", "lookup", "query-original", "close-input", "close-derived"} {
		t.Run(stage, func(t *testing.T) {
			f := newCandidatePrimaryFake(t)
			switch stage {
			case "open-partial":
				open := f.api.open
				f.api.open = func(p windows.Handle, a uint32, out *windows.Token) error {
					_ = open(p, a, out)
					return windows.ERROR_ACCESS_DENIED
				}
			case "lookup":
				f.api.ordinary = func() (map[windows.LUID]bool, error) { return nil, windows.ERROR_ACCESS_DENIED }
			case "query-original":
				f.api.query = func(windows.Token, uint32, *byte, uint32, *uint32) error { return windows.ERROR_ACCESS_DENIED }
			default:
				close := f.api.close
				f.api.close = func(token windows.Token) error {
					_ = close(token)
					if (stage == "close-input" && token == 10) || (stage == "close-derived" && token == 12) {
						return windows.ERROR_ACCESS_DENIED
					}
					return nil
				}
			}
			fixture, err := candidateAcquirePrimary(f.api)
			if err == nil {
				err = fixture.close()
				if fixture.close() != err {
					t.Fatal("close failure not sticky")
				}
			}
			if err == nil {
				t.Fatal("failure lost")
			}
			derived := 0
			if strings.HasPrefix(stage, "close") {
				derived = 1
			}
			f.assertClosed(t, 1, derived)
		})
	}
}
func TestWindowsPrimaryMalformedQueries(t *testing.T) {
	for _, class := range []uint32{windows.TokenElevationType, windows.TokenElevation, windows.TokenType, windows.TokenSessionId, windows.TokenUser, windows.TokenIntegrityLevel, windows.TokenGroups, windows.TokenPrivileges} {
		modes := []string{"denied", "length", "oversize", "zero", "changed"}
		if class == windows.TokenUser || class == windows.TokenIntegrityLevel {
			modes = append(modes, "external")
		}
		if class == windows.TokenGroups || class == windows.TokenPrivileges {
			modes = append(modes, "count", "attributes")
		}
		for _, mode := range modes {
			t.Run(fmt.Sprintf("class-%d/%s", class, mode), func(t *testing.T) {
				f := newCandidatePrimaryFake(t)
				q := f.api.query
				changed := false
				f.api.query = func(token windows.Token, c uint32, out *byte, n uint32, used *uint32) error {
					if token != 12 || c != class {
						return q(token, c, out, n, used)
					}
					fixed := c == windows.TokenElevationType || c == windows.TokenElevation || c == windows.TokenType || c == windows.TokenSessionId
					switch mode {
					case "denied":
						changed = true
						return windows.ERROR_ACCESS_DENIED
					case "oversize":
						if out == nil {
							changed = true
							*used = maxCandidateTokenBytes + 1
							return windows.ERROR_INSUFFICIENT_BUFFER
						}
					case "zero":
						if out == nil {
							changed = true
							*used = 0
							return windows.ERROR_INSUFFICIENT_BUFFER
						}
					}
					err := q(token, c, out, n, used)
					if err != nil || out == nil {
						return err
					}
					switch mode {
					case "length":
						changed = true
						*used = n - 1
					case "changed":
						changed = true
						return windows.ERROR_INSUFFICIENT_BUFFER
					case "external":
						if c == windows.TokenUser || c == windows.TokenIntegrityLevel {
							changed = true
							*(**windows.SID)(unsafe.Pointer(out)) = (*windows.SID)(unsafe.Pointer(&f.tokens[10].user[0]))
						}
					case "count":
						if c == windows.TokenGroups || c == windows.TokenPrivileges {
							changed = true
							binary.LittleEndian.PutUint32(unsafe.Slice(out, 4), ^uint32(0))
						}
					case "attributes":
						changed = true
						if c == windows.TokenPrivileges {
							header := unsafe.Offsetof(windows.Tokenprivileges{}.Privileges)
							p := (*windows.LUIDAndAttributes)(unsafe.Add(unsafe.Pointer(out), header))
							p.Attributes = 0x01000000
						} else {
							header := unsafe.Offsetof(windows.Tokengroups{}.Groups)
							g := (*windows.SIDAndAttributes)(unsafe.Add(unsafe.Pointer(out), header))
							g.Attributes = 0x01000000
						}
					}
					if fixed && (mode == "oversize" || mode == "zero") {
						changed = true
						*used = 8
					}
					return nil
				}
				_, err := candidateAcquirePrimary(f.api)
				if !changed {
					t.Fatal("malformed test did not reach selected boundary")
				}
				if err == nil {
					t.Fatal("malformed/error query accepted")
				}
				f.assertClosed(t, 1, 1)
			})
		}
	}
	f := newCandidatePrimaryFake(t)
	s := f.tokens[12]
	s.privileges = append(s.privileges, s.privileges[0])
	f.tokens[12] = s
	if _, err := candidateAcquirePrimary(f.api); err == nil {
		t.Fatal("duplicate privilege accepted")
	}
	f.assertClosed(t, 1, 1)
}
func TestWindowsPrimaryLabelAliasAndBOOL(t *testing.T) {
	f := newCandidatePrimaryFake(t)
	for _, owner := range []*candidatePrimaryOwner{nil, {token: 0}, {token: 10}, {token: windows.Token(^uintptr(0))}, {token: 12, released: true}} {
		if err := candidateLowerPrimary(10, owner, f.tokens[12], f.tokens[10], f.api); err == nil || f.sets != 0 {
			t.Fatal("invalid owner reached Set")
		}
	}
	for _, r := range []uintptr{0, 1, 2, 0x80000000, 0xffffffff} {
		for _, last := range []error{nil, windows.ERROR_SUCCESS, windows.ERROR_ACCESS_DENIED} {
			if (candidatePrimaryBOOL(r, last) == nil) != (uint32(r) != 0) {
				t.Fatal("BOOL/HRESULT/stale-error confusion")
			}
		}
	}
}

func TestWindowsPrimaryDWORDExactContract(t *testing.T) {
	for _, class := range []uint32{windows.TokenElevationType, windows.TokenElevation, windows.TokenType, windows.TokenSessionId} {
		for _, used := range []uint32{0, 1, 3, 4, 5, 8, maxCandidateTokenBytes + 1} {
			calls := 0
			value, err := candidatePrimaryDWORD(10, class, func(token windows.Token, c uint32, out *byte, size uint32, returned *uint32) error {
				calls++
				if token != 10 || c != class || out == nil || size != 4 || uintptr(unsafe.Pointer(out))%unsafe.Alignof(uint32(0)) != 0 {
					t.Fatal("not one aligned exact-four-byte query")
				}
				binary.LittleEndian.PutUint32(unsafe.Slice(out, size), 1)
				*returned = used
				return nil
			})
			if calls != 1 || (err == nil) != (used == 4) || (err == nil && value != 1) {
				t.Fatal("DWORD extent/probe contract")
			}
		}
	}
	if _, err := candidatePrimaryDWORD(10, windows.TokenUser, func(windows.Token, uint32, *byte, uint32, *uint32) error { t.Fatal("non-DWORD queried"); return nil }); err == nil {
		t.Fatal("non-DWORD accepted")
	}
}

func TestWindowsPrimaryWitnessEveryCapturedField(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*candidatePrimarySnapshot)
	}{
		{"complete", func(s *candidatePrimarySnapshot) { s.complete = false }},
		{"elevationType", func(s *candidatePrimarySnapshot) { s.elevationType++ }},
		{"elevation", func(s *candidatePrimarySnapshot) { s.elevation++ }},
		{"kind", func(s *candidatePrimarySnapshot) { s.kind++ }},
		{"session", func(s *candidatePrimarySnapshot) { s.session++ }},
		{"integrity", func(s *candidatePrimarySnapshot) { s.il++ }},
		{"user", func(s *candidatePrimarySnapshot) { s.user = nil }},
		{"user-attrs", func(s *candidatePrimarySnapshot) { s.userAttributes++ }},
		{"integrity-attrs", func(s *candidatePrimarySnapshot) { s.integrityAttributes++ }},
		{"groups", func(s *candidatePrimarySnapshot) { s.groups = nil }},
		{"group-attrs", func(s *candidatePrimarySnapshot) { s.groups[0].attrs++ }},
		{"group-SID", func(s *candidatePrimarySnapshot) { s.groups[0].sid = candidateSIDBytes(5, 1, 18) }},
		{"privileges", func(s *candidatePrimarySnapshot) { s.privileges = nil }},
		{"privilege-attrs", func(s *candidatePrimarySnapshot) { s.privileges[0].Attributes++ }},
		{"privilege-LUID", func(s *candidatePrimarySnapshot) { s.privileges[0].Luid.HighPart++ }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCandidatePrimaryFake(t)
			before, err := candidateInspectPrimary(12, f.api.query)
			if err != nil {
				t.Fatal(err)
			}
			after, err := candidateInspectPrimary(12, f.api.query)
			if err != nil {
				t.Fatal(err)
			}
			if !candidateSamePrimary(before, after) {
				t.Fatal("identical captured fields differ")
			}
			tc.change(&after)
			if candidateSamePrimary(before, after) {
				t.Fatal("captured-field mutation ignored")
			}
		})
	}
}

// Native read-only handle validation, but no profiles or target creation.
func TestWindowsBorrowedPrimaryPrecreationRefusals(t *testing.T) {
	dir := t.TempDir()
	var input windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &input); err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	event, err := windows.CreateEvent(nil, 0, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(event)
	var closed windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &closed); err != nil {
		t.Fatal(err)
	}
	if err := closed.Close(); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		token  windows.Token
		policy *windowsAppContainerPolicy
	}{
		{"nil-policy", input, nil}, {"pseudo-process", windows.Token(^uintptr(0)), candidatePolicy(t, true)},
		{"pseudo-token", windows.Token(^uintptr(0) - 3), candidatePolicy(t, true)},
		{"closed", closed, candidatePolicy(t, true)}, {"not-token", windows.Token(event), candidatePolicy(t, true)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reached, resumed := false, false
			tr, err := startWindowsOwned(context.Background(), windowsHelperCommand(dir, "hold"), windowsLaunchHooks{primaryToken: tc.token, beforeAttribute: func(uintptr) error { reached = true; return errors.New("unexpected attributes") }, resume: func(windows.Handle) (uint32, error) { resumed = true; return 0, errors.New("forbidden") }}, tc.policy)
			if tr != nil || err == nil || reached || resumed {
				t.Fatal("precreation token/policy refusal failed")
			}
		})
	}
	stop := errors.New("injected attribute failure")
	reached := false
	tr, err := startWindowsOwned(context.Background(), windowsHelperCommand(dir, "hold"), windowsLaunchHooks{primaryToken: input, beforeAttribute: func(uintptr) error { reached = true; return stop }, resume: func(windows.Handle) (uint32, error) { t.Fatal("borrowed path resumed"); return 0, stop }}, candidatePolicy(t, true))
	if tr != nil || !reached || !errors.Is(err, stop) {
		t.Fatalf("borrowed launch failure: %v", err)
	}
	if _, err := candidatePrimaryDWORD(input, windows.TokenType, windows.GetTokenInformation); err != nil {
		t.Fatal("launcher closed borrowed token")
	}
	if _, err := os.Stat(filepath.Join(dir, "hold.started")); !os.IsNotExist(err) {
		t.Fatal("precreation failure executed target")
	}
}
