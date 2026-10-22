//go:build windows

package process

import (
	"encoding/binary"
	"errors"
	"runtime"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

type candidateAccessFake struct {
	api                       candidateAccessAPI
	profile                   *windows.SID
	user, group               []byte
	opens, duplicates, checks int
	closes                    map[windows.Token]int
}

func newCandidateAccessFake(t *testing.T, lpac bool) *candidateAccessFake {
	t.Helper()
	metadata := goodCandidateToken(t)
	f := &candidateAccessFake{profile: metadata.profile, user: candidateSIDBytes(5, 1, 21), group: candidateSIDBytes(5, 1, 32), closes: map[windows.Token]int{}}
	var sdData []byte
	f.api = candidateAccessAPI{
		buildSD: candidateBuildAccessSD,
		open: func(p windows.Handle, rights uint32, out *windows.Token) error {
			f.opens++
			if p != 77 || rights != windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE || *out != 0 {
				t.Error("source acquisition protocol")
			}
			*out = 10
			return nil
		},
		duplicate: func(in windows.Token, rights, level, kind uint32, out *windows.Token) error {
			f.duplicates++
			if in != 10 || rights != windows.TOKEN_QUERY || level != windows.SecurityImpersonation || kind != windows.TokenImpersonation || *out != 0 {
				t.Error("duplicate protocol/rights")
			}
			*out = 12
			return nil
		},
		close: func(token windows.Token) error {
			f.closes[token]++
			if token != 10 && token != 12 {
				t.Error("foreign close")
			}
			return nil
		},
		query: func(token windows.Token, class uint32, out *byte, size uint32, used *uint32) error {
			if (token != 10 && token != 12) || class == 46 {
				t.Error("foreign token or forbidden class46 in semantic helper")
				return windows.ERROR_INVALID_PARAMETER
			}
			if class == windows.TokenType || class == windows.TokenImpersonationLevel {
				if size != 4 || out == nil {
					return windows.ERROR_BAD_LENGTH
				}
				*used = 4
				value := uint32(windows.TokenPrimary)
				if token == 12 {
					value = windows.TokenImpersonation
				}
				if class == windows.TokenImpersonationLevel {
					value = windows.SecurityImpersonation
				}
				binary.LittleEndian.PutUint32(unsafe.Slice(out, 4), value)
				return nil
			}
			if class == windows.TokenUser || class == windows.TokenPrimaryGroup {
				sid, header := f.user, unsafe.Sizeof(windows.Tokenuser{})
				if class == windows.TokenPrimaryGroup {
					sid, header = f.group, unsafe.Sizeof(windows.Tokenprimarygroup{})
				}
				*used = uint32(header) + uint32(len(sid))
				if out == nil || size < *used {
					return windows.ERROR_INSUFFICIENT_BUFFER
				}
				b := unsafe.Slice(out, size)
				clear(b)
				copy(b[header:], sid)
				p := (*windows.SID)(unsafe.Pointer(&b[header]))
				if class == windows.TokenUser {
					(*windows.Tokenuser)(unsafe.Pointer(out)).User.Sid = p
				} else {
					(*windows.Tokenprimarygroup)(unsafe.Pointer(out)).PrimaryGroup = p
				}
				runtime.GC()
				runtime.Gosched()
				return nil
			}
			return metadata.query(token, class, out, size, used)
		},
		validSD: func(p *byte) bool {
			header := unsafe.Slice(p, 20)
			d := binary.LittleEndian.Uint32(header[16:])
			acl := unsafe.Slice((*byte)(unsafe.Add(unsafe.Pointer(p), d)), 8)
			n := d + uint32(binary.LittleEndian.Uint16(acl[2:]))
			sdData = unsafe.Slice(p, n)
			if binary.LittleEndian.Uint32(header[12:]) != 0 || !bytesEqualSIDAt(sdData, 20, f.user) || !bytesEqualSIDAt(sdData, 20+len(f.user), f.group) {
				t.Error("owner/group/SACL protocol")
			}
			return true
		},
		access: func(p *byte, token windows.Token, desired uint32, mapping *candidateAccessMapping, priv *byte, used, granted *uint32, status *int32) error {
			f.checks++
			if token != 12 || desired != 1 || *mapping != candidateFileMapping || *used != 20 || uintptr(unsafe.Pointer(priv))%4 != 0 || p != &sdData[0] || *granted != 0 || *status != 0 {
				t.Error("AccessCheck protocol/alignment/initialization")
			}
			runtime.GC()
			runtime.Gosched()
			d := int(binary.LittleEndian.Uint32(sdData[16:]))
			count := binary.LittleEndian.Uint16(sdData[d+4:])
			allow := false
			if count == 2 {
				second := d + 8 + 8 + len(f.user)
				sid := sdData[second+8:]
				aap := candidateSIDMatches(sid, [6]byte{0, 0, 0, 0, 0, 15}, 2, 2) && binary.LittleEndian.Uint32(sid[12:]) == 1
				allow = !aap || !lpac
			}
			*used = 20
			if allow {
				*granted = 1
				*status = 1
			}
			return nil
		},
	}
	return f
}
func bytesEqualSIDAt(data []byte, offset int, sid []byte) bool {
	if offset < 0 || offset > len(data)-len(sid) {
		return false
	}
	for i, b := range sid {
		if data[offset+i] != b {
			return false
		}
	}
	return true
}
func (f *candidateAccessFake) assertOwned(t *testing.T, source, duplicate int) {
	t.Helper()
	if f.opens != 1 || f.closes[10] != source || f.closes[12] != duplicate || len(f.closes) != source+duplicate {
		t.Fatalf("ownership opens=%d sourceCloses=%d duplicateCloses=%d closeKinds=%d", f.opens, f.closes[10], f.closes[12], len(f.closes))
	}
}
func TestWindowsAccessCheckDiagnosticPairedInference(t *testing.T) {
	if !candidateAccessABI() || candidateFileMapping != (candidateAccessMapping{0x120089, 0x120116, 0x1200a0, 0x1f01ff}) {
		t.Fatal("SDK ABI/file mapping")
	}
	for _, lpac := range []bool{true, false} {
		f := newCandidateAccessFake(t, lpac)
		r, e := candidateDiagnoseAccess(77, f.profile, f.api)
		if e != nil || !r.matches(lpac) || r.matches(!lpac) || f.checks != 3 || f.duplicates != 1 {
			t.Fatal("paired controls/inference")
		}
		f.assertOwned(t, 1, 1)
		for i := range r.checks {
			bad := r
			bad.checks[i].apiSuccess = false
			if bad.matches(lpac) {
				t.Fatal("failed API inferred a deny/allow")
			}
			bad = r
			bad.checks[i].valid = false
			if bad.matches(lpac) {
				t.Fatal("invalid output inferred authority")
			}
			bad = r
			bad.checks[i].allowed = !bad.checks[i].allowed
			if bad.matches(lpac) {
				t.Fatal("negative/positive/control conjunction ignored")
			}
		}
		r.complete = false
		if r.matches(lpac) {
			t.Fatal("incomplete inference")
		}
	}
}

func TestWindowsAccessCheckDiagnosticOwnershipFailures(t *testing.T) {
	injected := errors.New("injected")
	for _, mode := range []string{"open-denied", "open-partial", "open-zero", "open-pseudo", "duplicate-denied", "duplicate-partial", "duplicate-zero", "duplicate-pseudo", "duplicate-alias", "duplicate-error-alias", "source-close", "duplicate-close", "both-close", "access-failure", "builder-failure", "builder-malformed"} {
		t.Run(mode, func(t *testing.T) {
			f := newCandidateAccessFake(t, true)
			src, dup := 1, 1
			switch mode {
			case "open-denied", "open-partial", "open-zero", "open-pseudo":
				src, dup = 0, 0
				f.api.open = func(_ windows.Handle, _ uint32, out *windows.Token) error {
					f.opens++
					switch mode {
					case "open-partial":
						*out = 10
					case "open-pseudo":
						*out = windows.Token(windows.CurrentProcess())
					}
					if mode == "open-zero" || mode == "open-pseudo" {
						return nil
					}
					return injected
				}
				if mode == "open-partial" {
					src = 1
				}
			case "duplicate-denied", "duplicate-partial", "duplicate-zero", "duplicate-pseudo", "duplicate-alias", "duplicate-error-alias":
				dup = 0
				f.api.duplicate = func(_ windows.Token, _, _, _ uint32, out *windows.Token) error {
					f.duplicates++
					switch mode {
					case "duplicate-partial":
						*out = 12
					case "duplicate-pseudo":
						*out = windows.Token(windows.CurrentProcess())
					case "duplicate-alias", "duplicate-error-alias":
						*out = 10
					}
					if mode == "duplicate-denied" || mode == "duplicate-partial" || mode == "duplicate-error-alias" {
						return injected
					}
					return nil
				}
				if mode == "duplicate-partial" {
					dup = 1
				}
			case "source-close", "duplicate-close", "both-close":
				base := f.api.close
				f.api.close = func(token windows.Token) error {
					_ = base(token)
					if mode == "both-close" || (mode == "source-close" && token == 10) || (mode == "duplicate-close" && token == 12) {
						return injected
					}
					return nil
				}
			case "builder-failure":
				f.api.buildSD = func([]byte, []byte, []byte) (candidateAccessSD, error) { return candidateAccessSD{}, injected }
			case "builder-malformed":
				f.api.buildSD = func([]byte, []byte, []byte) (candidateAccessSD, error) { return candidateAccessSD{}, nil }
			case "access-failure":
				f.api.access = func(*byte, windows.Token, uint32, *candidateAccessMapping, *byte, *uint32, *uint32, *int32) error {
					return windows.ERROR_ACCESS_DENIED
				}
			}
			r, e := candidateDiagnoseAccess(77, f.profile, f.api)
			if e == nil || r.matches(true) || r.complete {
				t.Fatal("failure lost or inferred deny")
			}
			if mode == "source-close" || mode == "duplicate-close" || mode == "both-close" {
				if !errors.Is(e, injected) {
					t.Fatal("close failure not sticky")
				}
			}
			f.assertOwned(t, src, dup)
		})
	}
}

func TestWindowsAccessCheckDiagnosticMetadataBounds(t *testing.T) {
	for _, class := range []uint32{windows.TokenUser, windows.TokenPrimaryGroup, tokenCapabilities, tokenAppContainerSID, windows.TokenIntegrityLevel, windows.TokenType, windows.TokenImpersonationLevel} {
		for _, mode := range []string{"api-error", "huge", "zero", "short", "overreported", "sid-outside", "sid-count", "wrong-type"} {
			t.Run(windowsClassName(class)+"/"+mode, func(t *testing.T) {
				f := newCandidateAccessFake(t, true)
				base := f.api.query
				changed := false
				f.api.query = func(token windows.Token, c uint32, out *byte, n uint32, used *uint32) error {
					if c != class || (class == windows.TokenImpersonationLevel && token != 12) {
						return base(token, c, out, n, used)
					}
					changed = true
					if mode == "api-error" {
						return windows.ERROR_ACCESS_DENIED
					}
					fixed := class == windows.TokenType || class == windows.TokenImpersonationLevel
					if out == nil {
						switch mode {
						case "huge":
							*used = maxCandidateTokenBytes + 1
							return windows.ERROR_INSUFFICIENT_BUFFER
						case "zero":
							*used = 0
							return windows.ERROR_INSUFFICIENT_BUFFER
						}
					}
					e := base(token, c, out, n, used)
					if e != nil {
						return e
					}
					switch mode {
					case "huge":
						*used = ^uint32(0)
					case "zero":
						*used = 0
					case "short":
						*used = 1
					case "overreported":
						*used = n + 1
					case "sid-outside", "sid-count":
						if fixed || class == tokenCapabilities {
							*used = 1
							break
						}
						b := unsafe.Slice(out, n)
						// All SID-bearing layouts here begin with PSID, except groups count.
						if mode == "sid-outside" {
							*(*unsafe.Pointer)(unsafe.Pointer(out)) = unsafe.Pointer(out)
						} else {
							p := *(*unsafe.Pointer)(unsafe.Pointer(out))
							// Provenance is retained in the typed pointer written by the fake.
							unsafe.Slice((*byte)(p), 8)[1] = 255
						}
						runtime.KeepAlive(b)
					case "wrong-type":
						if fixed {
							binary.LittleEndian.PutUint32(unsafe.Slice(out, n), 99)
						} else {
							*used = 1
						}
					}
					return nil
				}
				r, e := candidateDiagnoseAccess(77, f.profile, f.api)
				if !changed || e == nil || r.matches(true) || f.checks != 0 {
					t.Fatal("malformed metadata reached semantic controls")
				}
				dup := 0
				if f.duplicates != 0 {
					dup = 1
				}
				f.assertOwned(t, 1, dup)
			})
		}
	}
}

func TestWindowsAccessCheckDiagnosticOutputAndRetryBounds(t *testing.T) {
	for _, mode := range []string{"deny", "allow", "api-denied", "retry", "retry4096", "retry-huge", "retry-same", "retry-zero", "retry-twice", "used-short", "used-huge", "count-huge", "privilege-used", "control-invalid", "status-invalid", "deny-granted", "allow-zero", "unexpected-rights"} {
		t.Run(mode, func(t *testing.T) {
			sd, e := candidateBuildAccessSD(candidateSIDBytes(5, 1, 21), candidateSIDBytes(5, 1, 32), nil)
			if e != nil {
				t.Fatal(e)
			}
			calls := 0
			api := candidateAccessAPI{validSD: func(*byte) bool { return true }, access: func(_ *byte, _ windows.Token, _ uint32, _ *candidateAccessMapping, priv *byte, used, granted *uint32, status *int32) error {
				calls++
				capacity := *used
				if capacity > 4096 || uintptr(unsafe.Pointer(priv))%4 != 0 {
					t.Fatal("allocation bound/alignment")
				}
				if calls == 1 && len(mode) >= 5 && mode[:5] == "retry" {
					switch mode {
					case "retry-huge":
						*used = 4097
					case "retry-same":
						*used = 20
					case "retry-zero":
						*used = 0
					case "retry4096":
						*used = 4096
					default:
						*used = 32
					}
					return windows.ERROR_INSUFFICIENT_BUFFER
				}
				if mode == "retry-twice" {
					*used = 64
					return windows.ERROR_INSUFFICIENT_BUFFER
				}
				if mode == "api-denied" {
					*status = 0
					return windows.ERROR_ACCESS_DENIED
				}
				b := unsafe.Slice(priv, capacity)
				*used = 20
				switch mode {
				case "allow":
					*status = 1
					*granted = 1
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
					*granted = 1
				case "allow-zero":
					*status = 1
				case "unexpected-rights":
					*status = 1
					*granted = 3
				}
				return nil
			}}
			o, e := candidateAccessCheck(sd, 12, api)
			good := mode == "deny" || mode == "allow" || mode == "retry" || mode == "retry4096"
			if (e == nil) != good || o.valid != good || (o.allowed && mode != "allow") {
				t.Fatal("API failure/output conflated with access decision")
			}
			wantCalls := 1
			if mode == "retry" || mode == "retry4096" || mode == "retry-twice" {
				wantCalls = 2
			}
			if calls != wantCalls {
				t.Fatal("retry budget")
			}
		})
	}
}

func TestWindowsAccessCheckDiagnosticSecurityDescriptorBounds(t *testing.T) {
	user, group := candidateSIDBytes(5, 1, 21), candidateSIDBytes(5, 1, 32)
	for _, packageSID := range [][]byte{nil, candidateSIDBytes(15, 2, 2), candidateSIDBytes(15, 8, 2)} {
		sd, e := candidateBuildAccessSD(user, group, packageSID)
		if e != nil || !candidateValidAccessSD(sd) {
			t.Fatal("valid descriptor refused")
		}
		// Native MakeSelfRelativeSD does not promise component ordering. Model
		// DACL-first/group/owner without any native calls or pointer round trips.
		data := sd.data()
		d := int(binary.LittleEndian.Uint32(data[16:]))
		reordered := candidateAccessSD{words: make([]uint32, len(sd.words)), size: sd.size}
		b := reordered.data()
		copy(b[:20], data[:20])
		copy(b[20:], data[d:])
		groupStart := 20 + len(data[d:])
		copy(b[groupStart:], group)
		userStart := groupStart + len(group)
		copy(b[userStart:], user)
		binary.LittleEndian.PutUint32(b[4:], uint32(userStart))
		binary.LittleEndian.PutUint32(b[8:], uint32(groupStart))
		binary.LittleEndian.PutUint32(b[16:], 20)
		if !candidateValidAccessSD(reordered) {
			t.Fatal("valid native component reordering refused")
		}
		// Every truncation and every grammar-bearing field is rejected before native.
		for n := 0; n < sd.size; n++ {
			short := sd
			short.size = n
			if candidateValidAccessSD(short) {
				t.Fatal("truncated SD accepted")
			}
		}
		for _, off := range []int{0, 1, 2, 3, 4, 8, 12, 16, 20, 21, 32, 33, 44, 45, 46, 48, 50, 52, 53, 54, 56, 60, 61} {
			if off >= sd.size {
				continue
			}
			bad := candidateAccessSD{words: append([]uint32(nil), sd.words...), size: sd.size}
			bad.data()[off] ^= 0x80
			// Identity subauthority bytes are arbitrary, not structural. Only test fields
			// that the narrow grammar actually constrains (headers/ACL/ACE/masks).
			if off == 32 || off == 33 || off == 44 || off == 45 || off == 46 || off == 48 || off == 50 || off == 52 || off == 53 || off == 54 || off == 56 || off == 60 || off == 61 || off <= 21 {
				if candidateValidAccessSD(bad) {
					t.Fatalf("malformed SD field=%d accepted", off)
				}
			}
		}
	}
	for _, sid := range [][]byte{nil, {1}, {1, 255, 0, 0, 0, 0, 0, 5}, candidateSIDBytes(5, 0, 0)} {
		if _, e := candidateBuildAccessSD(sid, group, nil); e == nil {
			t.Fatal("malformed identity accepted")
		}
	}
	sd, _ := candidateBuildAccessSD(user, group, nil)
	calls := 0
	api := candidateAccessAPI{validSD: func(*byte) bool { calls++; return false }}
	if _, e := candidateAccessCheck(sd, 12, api); e == nil || calls != 1 {
		t.Fatal("native invalid SD ignored")
	}
	bad := sd
	bad.size = 0
	if _, e := candidateAccessCheck(bad, 12, api); e == nil || calls != 1 {
		t.Fatal("malformed SD reached native")
	}
}

func TestWindowsAccessCheckDiagnosticIdentityAndMetadataMismatch(t *testing.T) {
	for _, mode := range []string{"not-AC", "elevated", "profile", "low", "integrity-attrs", "capabilities", "duplicate-user", "duplicate-group"} {
		t.Run(mode, func(t *testing.T) {
			f := newCandidateAccessFake(t, true)
			base := f.api.query
			f.api.query = func(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
				e := base(token, class, out, n, used)
				if e != nil || out == nil {
					return e
				}
				b := unsafe.Slice(out, n)
				switch {
				case mode == "not-AC" && class == tokenIsAppContainer:
					binary.LittleEndian.PutUint32(b, 0)
				case mode == "elevated" && class == windows.TokenElevation:
					binary.LittleEndian.PutUint32(b, 1)
				case mode == "profile" && class == tokenAppContainerSID:
					b[len(b)-1] ^= 1
				case mode == "low" && class == windows.TokenIntegrityLevel:
					b[len(b)-1] ^= 1
				case mode == "integrity-attrs" && class == windows.TokenIntegrityLevel:
					(*windows.Tokenmandatorylabel)(unsafe.Pointer(out)).Label.Attributes = 0
				case mode == "capabilities" && class == tokenCapabilities:
					binary.LittleEndian.PutUint32(b, ^uint32(0))
				case mode == "duplicate-user" && class == windows.TokenUser && token == 12:
					b[len(b)-1] ^= 1
				case mode == "duplicate-group" && class == windows.TokenPrimaryGroup && token == 12:
					b[len(b)-1] ^= 1
				}
				return nil
			}
			r, e := candidateDiagnoseAccess(77, f.profile, f.api)
			if e == nil || r.matches(true) || f.checks != 0 {
				t.Fatal("mismatch reached controls")
			}
			dup := 0
			if f.duplicates != 0 {
				dup = 1
			}
			f.assertOwned(t, 1, dup)
		})
	}
}

func TestWindowsAccessCheckDiagnosticBOOLAndBoundedErrors(t *testing.T) {
	injected := errors.New("must-not-print-this-identity")
	if candidateAccessBOOL(1, injected) != nil || candidateAccessBOOL(0, injected) != injected || candidateAccessBOOL(0, nil) == nil || candidateAccessBOOL(0, windows.ERROR_SUCCESS) == nil {
		t.Fatal("BOOL return/last-error protocol")
	}
	bounded := candidateBoundAccessError(injected)
	if !errors.Is(bounded, injected) || bounded.Error() != "diagnostic error=true numericCodePresent=false code=0" || candidateBoundAccessError(nil) != nil {
		t.Fatal("opaque error printed or original lost")
	}
	if candidateBoundAccessError(windows.ERROR_ACCESS_DENIED).Error() != "diagnostic error=true numericCodePresent=true code=5" {
		t.Fatal("numeric error classification")
	}
}

func TestWindowsAccessCheckDiagnosticExactJobNonAuthority(t *testing.T) {
	original, diagnostic := errors.New("exact original"), errors.New("diagnostic failure")
	for _, member := range []bool{false, true} {
		for _, exactErr := range []error{nil, original} {
			var sticky error
			witnesses, diagnoses := 0, 0
			verify := candidateAccessVerify(func(p, j windows.Handle) (bool, error) {
				if p != 77 || j != 88 {
					t.Fatal("changed retained handles")
				}
				return member, exactErr
			}, func(windows.Handle) error { witnesses++; return nil }, func(windows.Handle) error { diagnoses++; return diagnostic }, &sticky)
			got, e := verify(77, 88)
			if got != member || e != exactErr {
				t.Fatal("original (member,error) changed")
			}
			want := 0
			if member && exactErr == nil {
				want = 1
			}
			if witnesses != want || diagnoses != want || (want == 1 && !errors.Is(sticky, diagnostic)) {
				t.Fatal("diagnostic ordering/stickiness")
			}
			if want == 1 {
				_, _ = verify(77, 88)
				if witnesses != 1 || diagnoses != 1 || !errors.Is(sticky, diagnostic) {
					t.Fatal("duplicate witness or cleared error")
				}
			}
		}
	}
	var sticky error
	called := false
	verify := candidateAccessVerify(func(windows.Handle, windows.Handle) (bool, error) { return true, nil }, func(windows.Handle) error { return diagnostic }, func(windows.Handle) error { called = true; return nil }, &sticky)
	member, e := verify(77, 88)
	if !member || e != nil || called || !errors.Is(sticky, diagnostic) {
		t.Fatal("witness failure changed authority or ran diagnostics")
	}
	// Successful observations cannot waive the fixed checker's refusal.
	f := newCandidateAccessFake(t, true)
	r, e := candidateDiagnoseAccess(77, f.profile, f.api)
	if e != nil || !r.matches(true) {
		t.Fatal("semantic setup")
	}
	q := goodCandidateToken(t)
	checked := 0
	err := verifyWindowsAppContainerToken(99, candidatePolicy(t, true), &windowsAppContainerVerification{
		query: func(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
			if class == 46 {
				t.Fatal("fixed verifier queried historical selector")
			}
			return q.query(token, class, out, n, used)
		},
		checkLPAC: func(windows.Token, []byte) error { checked++; return diagnostic },
	})
	if err != diagnostic || checked != 1 {
		t.Fatal("diagnostic success waived fixed checker refusal")
	}
}
