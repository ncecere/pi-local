//go:build windows

package process

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Explicit test-only adapters. Neither production file imports diagnostic
// owners, SID builders, mapping/SD types, fixtures or software construction.
// Fake handles 10/12 cannot authorize real native token operations; every token
// operation stays inside these hooks. In particular the old fake open is NEVER
// adapted, and a class46 request is a hard failure inside the diagnostic fake.
func lpacTestAPI(f *candidateAccessFake) lpacAccessAPI {
	return lpacAccessAPI{
		query: func(t windows.Token, c uint32, b *byte, n uint32, u *uint32) error {
			return f.api.query(t, c, b, n, u)
		},
		duplicate: func(t windows.Token, r, l, k uint32, o *windows.Token) error {
			return f.api.duplicate(t, r, l, k, o)
		},
		close: func(t windows.Token) error { return f.api.close(t) },
		buildSD: func(u, g, p []byte) (lpacAccessSD, error) {
			s, e := f.api.buildSD(u, g, p)
			return lpacAccessSD{words: s.words, size: s.size}, e
		},
		validSD: func(b *byte) bool { return f.api.validSD(b) },
		access: func(b *byte, t windows.Token, d uint32, m *lpacAccessMapping, p *byte, n, g *uint32, s *int32) error {
			mapping := candidateAccessMapping{m.read, m.write, m.execute, m.all}
			e := f.api.access(b, t, d, &mapping, p, n, g, s)
			*m = lpacAccessMapping{mapping.read, mapping.write, mapping.execute, mapping.all}
			return e
		},
	}
}

func lpacTestProfile() []byte {
	p := candidateSIDBytes(15, 8, 2)
	for i := 0; i < 7; i++ {
		binary.LittleEndian.PutUint32(p[12+4*i:], uint32(100*(i+1)))
	}
	return p
}

func lpacAssertBorrowed(t *testing.T, f *candidateAccessFake, duplicateCloses int) {
	t.Helper()
	if f.opens != 0 || f.closes[10] != 0 || f.closes[12] != duplicateCloses || len(f.closes) != duplicateCloses {
		t.Fatalf("borrowed ownership: opens=%d source=%d duplicate=%d kinds=%d", f.opens, f.closes[10], f.closes[12], len(f.closes))
	}
}

func TestWindowsLPACSemanticCompleteDependenciesBeforeAnyOperation(t *testing.T) {
	// Every possible partial bundle, not just the zero bundle. ALL functions
	// (even close/build/validSD/access) count as operations for this assertion.
	for mask := 0; mask < 64; mask++ {
		t.Run(fmt.Sprint(mask), func(t *testing.T) {
			calls := 0
			injected := errors.New("injected")
			api := lpacAccessAPI{}
			if mask&1 != 0 {
				api.query = func(windows.Token, uint32, *byte, uint32, *uint32) error { calls++; return injected }
			}
			if mask&2 != 0 {
				api.duplicate = func(windows.Token, uint32, uint32, uint32, *windows.Token) error { calls++; return injected }
			}
			if mask&4 != 0 {
				api.close = func(windows.Token) error { calls++; return injected }
			}
			if mask&8 != 0 {
				api.buildSD = func([]byte, []byte, []byte) (lpacAccessSD, error) { calls++; return lpacAccessSD{}, injected }
			}
			if mask&16 != 0 {
				api.validSD = func(*byte) bool { calls++; return false }
			}
			if mask&32 != 0 {
				api.access = func(*byte, windows.Token, uint32, *lpacAccessMapping, *byte, *uint32, *uint32, *int32) error {
					calls++
					return injected
				}
			}
			err := verifyWindowsLPACSemantics(10, lpacTestProfile(), api)
			want := 0
			if mask == 63 {
				want = 1
			}
			if err == nil || calls != want {
				t.Fatal("incomplete injection called a dependency or fell back to native")
			}
		})
	}
}

func TestWindowsLPACSemanticPairedAndBorrowed(t *testing.T) {
	if !lpacAccessABI() || lpacFileMapping() != (lpacAccessMapping{0x120089, 0x120116, 0x1200a0, 0x1f01ff}) {
		t.Fatal("SDK ABI/mapping")
	}
	for _, lpac := range []bool{true, false} {
		f := newCandidateAccessFake(t, lpac)
		err := verifyWindowsLPACSemantics(10, lpacTestProfile(), lpacTestAPI(f))
		if (err == nil) != lpac || f.duplicates != 1 || f.checks != map[bool]int{true: 3, false: 2}[lpac] {
			t.Fatal("ordinary AC accepted or LPAC conjunction failed")
		}
		lpacAssertBorrowed(t, f, 1)
	}
}

func TestWindowsLPACSemanticInvalidSourceAndProfileZeroCalls(t *testing.T) {
	for _, source := range []windows.Token{0, 1, 2, 3, windows.Token(^uintptr(0)), windows.Token(^uintptr(0) - 1), windows.Token(^uintptr(0) - 15)} {
		f := newCandidateAccessFake(t, true)
		api := lpacTestAPI(f)
		api.query = func(windows.Token, uint32, *byte, uint32, *uint32) error {
			t.Fatal("invalid source queried")
			return nil
		}
		if verifyWindowsLPACSemantics(source, lpacTestProfile(), api) == nil || f.duplicates != 0 {
			t.Fatal("invalid source accepted")
		}
		lpacAssertBorrowed(t, f, 0)
	}
	for _, profile := range [][]byte{nil, {1}, candidateSIDBytes(15, 2, 2), candidateSIDBytes(15, 8, 3), candidateSIDBytes(5, 8, 2), append(lpacTestProfile(), 0)} {
		f := newCandidateAccessFake(t, true)
		api := lpacTestAPI(f)
		api.query = func(windows.Token, uint32, *byte, uint32, *uint32) error {
			t.Fatal("invalid profile queried")
			return nil
		}
		if verifyWindowsLPACSemantics(10, profile, api) == nil || f.duplicates != 0 {
			t.Fatal("invalid profile accepted")
		}
		lpacAssertBorrowed(t, f, 0)
	}
}

func TestWindowsLPACSemanticDuplicateAndRetirementFailures(t *testing.T) {
	injected := errors.New("private-identity-do-not-print")
	for _, mode := range []string{"denied", "partial", "zero", "null-tag", "pseudo", "pseudo-error", "alias", "alias-error", "tag-alias", "tag-alias-error", "close", "access-and-close"} {
		t.Run(mode, func(t *testing.T) {
			f := newCandidateAccessFake(t, true)
			dupCloses := 0
			if mode == "close" || mode == "access-and-close" {
				dupCloses = 1
				base := f.api.close
				f.api.close = func(token windows.Token) error { _ = base(token); return injected }
				if mode == "access-and-close" {
					f.api.access = func(*byte, windows.Token, uint32, *candidateAccessMapping, *byte, *uint32, *uint32, *int32) error {
						return windows.ERROR_ACCESS_DENIED
					}
				}
			} else {
				f.api.duplicate = func(_ windows.Token, _, _, _ uint32, out *windows.Token) error {
					f.duplicates++
					switch mode {
					case "partial":
						*out = 12
					case "null-tag":
						*out = 3
					case "pseudo", "pseudo-error":
						*out = windows.Token(^uintptr(0))
					case "alias", "alias-error":
						*out = 10
					case "tag-alias", "tag-alias-error":
						*out = 11
					}
					if mode == "denied" || mode == "partial" || strings.HasSuffix(mode, "-error") {
						return injected
					}
					return nil
				}
				if mode == "partial" {
					dupCloses = 1
				}
			}
			err := verifyWindowsLPACSemantics(10, lpacTestProfile(), lpacTestAPI(f))
			if err == nil || strings.Contains(err.Error(), "private-identity") || f.duplicates != 1 {
				t.Fatal("duplicate/close failure lost, unsanitized or retried")
			}
			if mode == "denied" || mode == "partial" || strings.HasSuffix(mode, "-error") || mode == "close" || mode == "access-and-close" {
				if !errors.Is(err, injected) {
					t.Fatal("cleanup or partial-output error not retained")
				}
			}
			if mode == "access-and-close" && !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
				t.Fatal("primary error lost to cleanup error")
			}
			if mode != "close" && mode != "access-and-close" && f.checks != 0 {
				t.Fatal("partial/alias/pseudo output reached AccessCheck")
			}
			lpacAssertBorrowed(t, f, dupCloses)
		})
	}
	calls := 0
	o := &lpacDuplicateOwner{token: 12, close: func(windows.Token) error { calls++; return injected }}
	for i := 0; i < 3; i++ {
		if !errors.Is(o.release(), injected) || calls != 1 {
			t.Fatal("retirement retried or uncertainty cleared")
		}
	}
}

func TestWindowsLPACSemanticEveryMetadataFailure(t *testing.T) {
	for _, token := range []windows.Token{10, 12} {
		for _, class := range []uint32{windows.TokenType, windows.TokenImpersonationLevel, tokenIsAppContainer, windows.TokenElevation, tokenAppContainerSID, tokenCapabilities, windows.TokenIntegrityLevel, windows.TokenUser, windows.TokenPrimaryGroup} {
			if token == 10 && class == windows.TokenImpersonationLevel {
				continue
			}
			fixed := class == windows.TokenType || class == windows.TokenImpersonationLevel || class == tokenIsAppContainer || class == windows.TokenElevation
			modes := []string{"api-error", "short", "zero", "overreported", "wrong-value"}
			if !fixed {
				modes = append(modes, "probe-success", "probe-error", "probe-zero", "probe-huge", "fill-error")
				if class != tokenCapabilities {
					modes = append(modes, "sid-nil", "sid-header", "sid-unaligned", "sid-end", "sid-count", "sid-revision", "sid-truncated")
				}
			}
			for _, mode := range modes {
				t.Run(fmt.Sprintf("%d/%d/%s", token, class, mode), func(t *testing.T) {
					f := newCandidateAccessFake(t, true)
					base := f.api.query
					changed := false
					f.api.query = func(tok windows.Token, c uint32, out *byte, n uint32, used *uint32) error {
						if tok != token || c != class {
							return base(tok, c, out, n, used)
						}
						changed = true
						if mode == "api-error" {
							return windows.ERROR_ACCESS_DENIED
						}
						if out == nil {
							switch mode {
							case "probe-success":
								return nil
							case "probe-error":
								return windows.ERROR_BAD_LENGTH
							case "probe-zero":
								*used = 0
								return windows.ERROR_INSUFFICIENT_BUFFER
							case "probe-huge":
								*used = maxCandidateTokenBytes + 1
								return windows.ERROR_INSUFFICIENT_BUFFER
							}
						}
						if out != nil && mode == "fill-error" {
							return windows.ERROR_ACCESS_DENIED
						}
						e := base(tok, c, out, n, used)
						if e != nil {
							return e
						}
						b := unsafe.Slice(out, n)
						switch mode {
						case "short":
							*used = 1
						case "zero":
							*used = 0
						case "overreported":
							*used = n + 1
						case "wrong-value":
							if fixed || class == tokenCapabilities {
								binary.LittleEndian.PutUint32(b, 99)
							} else {
								b[len(b)-1] ^= 1 // exact profile/Low or duplicate identity
								if token == 10 && (class == windows.TokenUser || class == windows.TokenPrimaryGroup) {
									// Source identity is not hardcoded; make it malformed,
									// not merely a different legitimate user/group.
									*used = 1
								}
							}
						case "sid-nil":
							*(*unsafe.Pointer)(unsafe.Pointer(out)) = nil
						case "sid-header":
							*(*unsafe.Pointer)(unsafe.Pointer(out)) = unsafe.Pointer(out)
						case "sid-unaligned":
							p := *(*unsafe.Pointer)(unsafe.Pointer(out))
							*(*unsafe.Pointer)(unsafe.Pointer(out)) = unsafe.Add(p, 1)
						case "sid-end":
							*(*unsafe.Pointer)(unsafe.Pointer(out)) = unsafe.Add(unsafe.Pointer(out), n-4)
						case "sid-count", "sid-revision":
							p := *(*unsafe.Pointer)(unsafe.Pointer(out))
							h := unsafe.Slice((*byte)(p), 8)
							if mode == "sid-count" {
								h[1] = 255
							} else {
								h[0] = 2
							}
						case "sid-truncated":
							*used = n - 1
						}
						return nil
					}
					err := verifyWindowsLPACSemantics(10, lpacTestProfile(), lpacTestAPI(f))
					if !changed || err == nil || f.checks != 0 {
						t.Fatal("metadata failure accepted/reached controls")
					}
					dup := 0
					if f.duplicates != 0 {
						dup = 1
					}
					lpacAssertBorrowed(t, f, dup)
				})
			}
		}
	}
	// Stronger than the old verifier's bit-presence test, without changing it.
	for _, attrs := range []uint32{0, windows.SE_GROUP_INTEGRITY | windows.SE_GROUP_ENABLED, ^uint32(0)} {
		f := newCandidateAccessFake(t, true)
		base := f.api.query
		f.api.query = func(tok windows.Token, c uint32, out *byte, n uint32, used *uint32) error {
			e := base(tok, c, out, n, used)
			if e == nil && out != nil && c == windows.TokenIntegrityLevel {
				(*windows.Tokenmandatorylabel)(unsafe.Pointer(out)).Label.Attributes = attrs
			}
			return e
		}
		if verifyWindowsLPACSemantics(10, lpacTestProfile(), lpacTestAPI(f)) == nil || f.checks != 0 {
			t.Fatal("unexpected integrity attributes accepted")
		}
		lpacAssertBorrowed(t, f, 0)
	}
}

func TestWindowsLPACSemanticEveryControlAndOutputFailure(t *testing.T) {
	modes := []string{"flip", "api-denied", "retry", "retry4096", "retry-unaligned", "retry-huge", "retry-same", "retry-zero", "retry-twice", "used-short", "used-huge", "count-huge", "privilege-used", "control-invalid", "status-invalid", "deny-granted", "allow-zero", "unexpected-rights", "mapping-mutated", "native-invalid"}
	for control := 0; control < 3; control++ {
		for _, mode := range modes {
			t.Run(fmt.Sprintf("%d/%s", control, mode), func(t *testing.T) {
				f := newCandidateAccessFake(t, true)
				api := lpacTestAPI(f)
				calls, retries, validCalls := 0, 0, 0
				api.validSD = func(*byte) bool {
					i := validCalls
					validCalls++
					return mode != "native-invalid" || i != control
				}
				api.access = func(_ *byte, token windows.Token, desired uint32, mapping *lpacAccessMapping, priv *byte, used, granted *uint32, status *int32) error {
					i := calls
					calls++
					capacity := *used
					if token != 12 || desired != 1 || *mapping != lpacFileMapping() || capacity > 4096 || uintptr(unsafe.Pointer(priv))%4 != 0 || *granted != 0 || *status != 0 {
						t.Fatal("AccessCheck protocol/ABI/rights/initialization")
					}
					b := unsafe.Slice(priv, capacity)
					if !bytes.Equal(b, make([]byte, capacity)) {
						t.Fatal("privilege buffer not initialized")
					}
					if retries != 0 {
						i--
					}
					if i == control && strings.HasPrefix(mode, "retry") {
						if retries == 0 {
							retries++
							*used = map[string]uint32{"retry": 32, "retry4096": 4096, "retry-unaligned": 21, "retry-huge": 4097, "retry-same": 20, "retry-zero": 0, "retry-twice": 32}[mode]
							// Poison every other output: none may be read on failure.
							*granted, *status = ^uint32(0), -1
							binary.LittleEndian.PutUint32(b, ^uint32(0))
							return windows.ERROR_INSUFFICIENT_BUFFER
						}
						if mode == "retry-twice" {
							*used = 64
							return windows.ERROR_INSUFFICIENT_BUFFER
						}
					}
					*used = 20
					if i == 2 {
						*granted, *status = 1, 1
					}
					if i == control {
						switch mode {
						case "flip":
							if i == 2 {
								*granted, *status = 0, 0
							} else {
								*granted, *status = 1, 1
							}
						case "api-denied":
							*granted, *status = 0, 0
							return windows.ERROR_ACCESS_DENIED
						case "used-short":
							*used = 7
						case "used-huge":
							*used = capacity + 1
						case "count-huge":
							binary.LittleEndian.PutUint32(b, ^uint32(0))
						case "privilege-used":
							binary.LittleEndian.PutUint32(b, 1)
						case "control-invalid":
							binary.LittleEndian.PutUint32(b[4:], 2)
						case "status-invalid":
							*status = 2
						case "deny-granted":
							*granted, *status = 1, 0
						case "allow-zero":
							*granted, *status = 0, 1
						case "unexpected-rights":
							*granted, *status = 3, 1
						case "mapping-mutated":
							mapping.read = 0
						}
					}
					runtime.GC()
					runtime.Gosched()
					return nil
				}
				err := verifyWindowsLPACSemantics(10, lpacTestProfile(), api)
				good := mode == "retry" || mode == "retry4096" || mode == "retry-unaligned"
				if (err == nil) != good {
					t.Fatal("control/output/API failure accepted or bounded retry refused")
				}
				want := control + 1
				if good {
					want = 4
				} else if mode == "retry-twice" {
					want++
				} else if mode == "native-invalid" {
					want--
				}
				if calls != want {
					t.Fatalf("retry/control budget got=%d want=%d", calls, want)
				}
				lpacAssertBorrowed(t, f, 1)
			})
		}
	}
}

func TestWindowsLPACSemanticConstructionAndExactBindings(t *testing.T) {
	for control := 0; control < 3; control++ {
		for _, mode := range []string{"build-error", "empty", "owner", "group", "user-ace", "package-ace", "count", "mask", "flags", "SACL", "control", "revision", "ACL-revision", "ACE-type", "ACE-size", "ACL-size", "padding", "argument-mutation"} {
			if control == 0 && mode == "package-ace" {
				continue
			}
			t.Run(fmt.Sprintf("%d/%s", control, mode), func(t *testing.T) {
				f := newCandidateAccessFake(t, true)
				api := lpacTestAPI(f)
				build := api.buildSD
				calls, walkers := 0, 0
				api.validSD = func(*byte) bool { walkers++; return true }
				api.buildSD = func(u, g, p []byte) (lpacAccessSD, error) {
					i := calls
					calls++
					if i == control && mode == "argument-mutation" {
						u[len(u)-1] ^= 1
						g[len(g)-1] ^= 1
						if p != nil {
							p[len(p)-1] ^= 1
						}
					}
					s, e := build(u, g, p)
					if i != control || e != nil {
						return s, e
					}
					b := s.data()
					d := int(binary.LittleEndian.Uint32(b[16:]))
					ace := d + 8
					switch mode {
					case "build-error":
						return s, errors.New("opaque-builder-error")
					case "empty":
						return lpacAccessSD{}, nil
					case "owner":
						b[int(binary.LittleEndian.Uint32(b[4:]))+8] ^= 1
					case "group":
						b[int(binary.LittleEndian.Uint32(b[8:]))+8] ^= 1
					case "user-ace":
						b[ace+16] ^= 1
					case "package-ace":
						b[ace+8+len(u)+16] ^= 1
					case "count":
						b[d+4] ^= 1
					case "mask":
						b[ace+4] ^= 2
					case "flags":
						b[ace+1] = 1
					case "SACL":
						binary.LittleEndian.PutUint32(b[12:], 20)
					case "control":
						b[2] ^= 1
					case "revision":
						b[0] = 2
					case "ACL-revision":
						b[d] = 4
					case "ACE-type":
						b[ace] = 1
					case "ACE-size":
						b[ace+2]--
					case "ACL-size":
						b[d+2]--
					case "padding":
						s.words = append(s.words, 0)
						s.size += 4
					}
					return s, nil
				}
				if verifyWindowsLPACSemantics(10, lpacTestProfile(), api) == nil || walkers != 0 || f.checks != 0 {
					t.Fatal("unbound/malformed composition reached native walker/control")
				}
				lpacAssertBorrowed(t, f, 1)
			})
		}
	}
	// Two otherwise valid descriptors cannot share their storage, even if
	// differing slice lengths could bind A and B independently.
	for _, control := range []int{1, 2} {
		f := newCandidateAccessFake(t, true)
		api := lpacTestAPI(f)
		build := api.buildSD
		var first lpacAccessSD
		calls := 0
		api.buildSD = func(u, g, p []byte) (lpacAccessSD, error) {
			i := calls
			calls++
			if i == control {
				return first, nil
			}
			s, e := build(u, g, p)
			if i == 0 {
				first = s
			}
			return s, e
		}
		api.validSD = func(*byte) bool { t.Fatal("alias reached native walker"); return true }
		if verifyWindowsLPACSemantics(10, lpacTestProfile(), api) == nil {
			t.Fatal("aliased descriptor accepted")
		}
		lpacAssertBorrowed(t, f, 1)
	}
}

func TestWindowsLPACSemanticSDGrammarTruncationAndReordering(t *testing.T) {
	u, g := candidateSIDBytes(5, 1, 21), candidateSIDBytes(5, 1, 32)
	for _, p := range [][]byte{nil, {1, 2, 0, 0, 0, 0, 0, 15, 2, 0, 0, 0, 1, 0, 0, 0}, lpacTestProfile()} {
		raw, e := candidateBuildAccessSD(u, g, p)
		if e != nil {
			t.Fatal(e)
		}
		s := lpacAccessSD{words: raw.words, size: raw.size}
		if !lpacValidAccessSD(s, u, g, p) {
			t.Fatal("valid binding refused")
		}
		for n := 0; n < s.size; n++ {
			short := s
			short.size = n
			if lpacValidAccessSD(short, u, g, p) {
				t.Fatal("truncation accepted")
			}
		}
		// Every byte participates in exact content or structural binding.
		for off := 0; off < s.size; off++ {
			bad := lpacAccessSD{words: append([]uint32(nil), s.words...), size: s.size}
			bad.data()[off] ^= 0x80
			if lpacValidAccessSD(bad, u, g, p) {
				t.Fatalf("unbound byte %d", off)
			}
		}
		data := s.data()
		d := int(binary.LittleEndian.Uint32(data[16:]))
		reordered := lpacAccessSD{words: make([]uint32, len(s.words)), size: s.size}
		b := reordered.data()
		copy(b[:20], data[:20])
		copy(b[20:], data[d:])
		groupStart := 20 + len(data[d:])
		copy(b[groupStart:], g)
		userStart := groupStart + len(g)
		copy(b[userStart:], u)
		binary.LittleEndian.PutUint32(b[4:], uint32(userStart))
		binary.LittleEndian.PutUint32(b[8:], uint32(groupStart))
		binary.LittleEndian.PutUint32(b[16:], 20)
		if !lpacValidAccessSD(reordered, u, g, p) {
			t.Fatal("native component order unnecessarily constrained")
		}
	}
	// Exercise the independent overlap guard, not just binding refusal.
	words := make([]uint32, 100)
	if !lpacSDOverlap(lpacAccessSD{words: words[:30], size: 120}, lpacAccessSD{words: words[20:], size: 80}) ||
		lpacSDOverlap(lpacAccessSD{words: words[:20], size: 80}, lpacAccessSD{words: words[20:], size: 80}) {
		t.Fatal("overlap boundary check")
	}
}

type lpacOpaqueVariableError struct{ message string }

func (e *lpacOpaqueVariableError) Error() string { return e.message }

func TestWindowsLPACSemanticVariableQueryAndCleanupCauses(t *testing.T) {
	for _, class := range []uint32{windows.TokenUser, windows.TokenPrimaryGroup} {
		f := newCandidateAccessFake(t, true)
		baseQuery, baseClose := f.api.query, f.api.close
		queryError := &lpacOpaqueVariableError{message: "opaque-query-private-text"}
		cleanupError := errors.New("opaque-cleanup-private-text")
		f.api.query = func(token windows.Token, c uint32, out *byte, n uint32, used *uint32) error {
			if token == 12 && c == class {
				return queryError
			}
			return baseQuery(token, c, out, n, used)
		}
		f.api.close = func(token windows.Token) error {
			_ = baseClose(token)
			return cleanupError
		}
		err := verifyWindowsLPACSemantics(10, lpacTestProfile(), lpacTestAPI(f))
		var typed *lpacOpaqueVariableError
		if !errors.Is(err, queryError) || !errors.Is(err, cleanupError) || !errors.As(err, &typed) || typed != queryError {
			t.Fatal("joined variable-query and retirement causes were not retained")
		}
		if strings.Contains(err.Error(), queryError.message) || strings.Contains(err.Error(), cleanupError.Error()) {
			t.Fatal("outward reporting disclosed an opaque cause")
		}
		if f.checks != 0 {
			t.Fatal("failed variable query reached controls")
		}
		lpacAssertBorrowed(t, f, 1)
	}
}

func TestWindowsLPACSemanticSanitizedErrorsAndFixedAuthority(t *testing.T) {
	injected := errors.New("opaque-private-text")
	if lpacAccessBOOL(1, injected) != nil || lpacAccessBOOL(0, injected) != injected || lpacAccessBOOL(0, nil) == nil || lpacAccessBOOL(0, windows.ERROR_SUCCESS) == nil || lpacBoundError(nil) != nil {
		t.Fatal("BOOL/error protocol")
	}
	if !errors.Is(lpacBoundError(injected), injected) || strings.Contains(lpacBoundError(injected).Error(), injected.Error()) || lpacBoundError(windows.ERROR_ACCESS_DENIED).Error() != "process: LPAC semantic refusal numericCodePresent=true code=5" {
		t.Fatal("unsanitized or lost cause")
	}
	for _, result := range []uint32{0, 1} {
		for _, queryError := range []error{nil, windows.ERROR_INVALID_PARAMETER} {
			f := newCandidateAccessFake(t, true)
			if err := verifyWindowsLPACSemantics(10, lpacTestProfile(), lpacTestAPI(f)); err != nil {
				t.Fatal(err)
			}
			metadata := goodCandidateToken(t)
			seen46 := 0
			checked := 0
			err := verifyWindowsAppContainerToken(99, candidatePolicy(t, true), &windowsAppContainerVerification{query: func(tok windows.Token, class uint32, out *byte, size uint32, used *uint32) error {
				if class == 46 {
					seen46++
					if queryError != nil {
						return queryError
					}
					*used = 4
					binary.LittleEndian.PutUint32(unsafe.Slice(out, size), result)
					return nil
				}
				return metadata.query(tok, class, out, size, used)
			}, checkLPAC: func(token windows.Token, profile []byte) error {
				checked++
				if token != 99 || !bytes.Equal(profile, lpacTestProfile()) {
					t.Fatal("checker arguments changed")
				}
				return nil // explicit fake; token99 never reaches native APIs
			}})
			if seen46 != 0 || checked != 1 || err != nil {
				t.Fatal("historical selector46 influenced fixed authority")
			}
			lpacAssertBorrowed(t, f, 1)
		}
	}
}
