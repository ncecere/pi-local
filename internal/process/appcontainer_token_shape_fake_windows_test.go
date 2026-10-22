//go:build windows

package process

import (
	"encoding/binary"
	"errors"
	"fmt"
	"slices"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

type candidateShapeFake struct {
	api                  candidateShapeAPI
	shapes               map[windows.Token]candidateShapeSnapshot
	closed               []windows.Token
	opens, dups, queries int
}

func newCandidateShapeFake(t *testing.T) *candidateShapeFake {
	t.Helper()
	f := &candidateShapeFake{shapes: make(map[windows.Token]candidateShapeSnapshot)}
	for _, token := range []windows.Token{100, 200, 300} {
		f.shapes[token] = candidateShapeSnapshot{kind: windows.TokenPrimary, groups: []candidatePrimaryGroup{{candidateSIDBytes(5, 1, 18), 4}, {candidateSIDBytes(5, 1, 19), 16}}, restricted: []candidatePrimaryGroup{{candidateSIDBytes(15, 2, 2), 7}, {candidateSIDBytes(5, 1, 21), 0}}, privileges: []windows.LUIDAndAttributes{{Luid: windows.LUID{LowPart: 7}, Attributes: 2}, {Luid: windows.LUID{LowPart: 8}, Attributes: 0}}}
	}
	s := f.shapes[100]
	s.groups = nil
	s.restricted = nil
	s.privileges = nil
	f.shapes[100] = s // primary need NOT equal child
	s = f.shapes[300]
	s.kind = windows.TokenImpersonation
	s.level = windows.SecurityImpersonation
	slices.Reverse(s.groups)
	slices.Reverse(s.restricted)
	slices.Reverse(s.privileges)
	f.shapes[300] = s
	f.api = candidateShapeAPI{
		query: f.query,
		open: func(process windows.Handle, rights uint32, out *windows.Token) error {
			f.opens++
			if process != 400 || rights != windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE || *out != 0 {
				t.Fatal("shape source rights/borrowed process/output")
			}
			*out = 200
			return nil
		},
		duplicate: func(in windows.Token, rights, level, kind uint32, out *windows.Token) error {
			f.dups++
			if in != 200 || rights != windows.TOKEN_QUERY || level != windows.SecurityImpersonation || kind != windows.TokenImpersonation || *out != 0 {
				t.Fatal("shape duplicate rights/type/level/output")
			}
			*out = 300
			return nil
		},
		close: func(token windows.Token) error {
			if token == 100 || token == 400 || slices.Contains(f.closed, token) {
				t.Fatal("shape borrowed/double retirement")
			}
			f.closed = append(f.closed, token)
			return nil
		},
	}
	return f
}
func (f *candidateShapeFake) query(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
	f.queries++
	if slices.Contains(f.closed, token) {
		return errors.New("query after retirement")
	}
	s, ok := f.shapes[token]
	if !ok {
		return windows.ERROR_INVALID_HANDLE
	}
	if class == windows.TokenType || class == windows.TokenImpersonationLevel {
		if out == nil || n != 4 {
			return windows.ERROR_BAD_LENGTH
		}
		*used = 4
		value := s.kind
		if class == windows.TokenImpersonationLevel {
			value = s.level
		}
		binary.LittleEndian.PutUint32(unsafe.Slice(out, n), value)
		return nil
	}
	var groups []candidatePrimaryGroup
	header, entry := unsafe.Offsetof(windows.Tokengroups{}.Groups), unsafe.Sizeof(windows.SIDAndAttributes{})
	switch class {
	case windows.TokenGroups:
		groups = s.groups
	case windows.TokenRestrictedSids:
		groups = s.restricted
	case windows.TokenPrivileges:
		header = 4
		entry = 12
	default:
		return windows.ERROR_INVALID_PARAMETER
	}
	count := len(groups)
	if class == windows.TokenPrivileges {
		count = len(s.privileges)
	}
	total := header + uintptr(count)*entry
	for _, g := range groups {
		total += uintptr(len(g.sid))
	}
	*used = uint32(total)
	if out == nil {
		return windows.ERROR_INSUFFICIENT_BUFFER
	}
	if uintptr(n) != total || uintptr(unsafe.Pointer(out))%unsafe.Alignof(uintptr(0)) != 0 {
		return windows.ERROR_BAD_LENGTH
	}
	b := unsafe.Slice(out, n)
	clear(b)
	binary.LittleEndian.PutUint32(b, uint32(count))
	if class == windows.TokenPrivileges {
		for i, p := range s.privileges {
			*(*windows.LUIDAndAttributes)(unsafe.Pointer(&b[header+uintptr(i)*entry])) = p
		}
		return nil
	}
	off := header + uintptr(count)*entry
	for i, g := range groups {
		p := (*windows.SIDAndAttributes)(unsafe.Pointer(&b[header+uintptr(i)*entry]))
		p.Attributes = g.attrs
		p.Sid = (*windows.SID)(unsafe.Pointer(&b[off]))
		copy(b[off:], g.sid)
		off += uintptr(len(g.sid))
	}
	return nil
}
func TestWindowsTokenShapeInventoryAndOwnership(t *testing.T) {
	f := newCandidateShapeFake(t)
	r, err := candidateDiagnoseShape(100, 400, f.api)
	if err != nil || !r.complete || !r.sourceDuplicateEqual || f.opens != 1 || f.dups != 1 || !slices.Equal(f.closed, []windows.Token{300, 200}) || len(r.primary.groups) != 0 {
		t.Fatal("complete inventory/order normalization/ownership")
	}
	// Independent owned copies survive mutation of all fake source storage.
	f.shapes[200].groups[0].sid[0] = 0
	if r.source.groups[0].sid[0] != 1 || r.duplicate.groups[0].sid[0] != 1 {
		t.Fatal("snapshot retained borrowed bytes")
	}
	candidateLogShapeReport(t, r, nil)
}
func TestWindowsTokenShapeCompleteBundleZeroOperations(t *testing.T) {
	for mask := 0; mask < 15; mask++ {
		f := newCandidateShapeFake(t)
		a := f.api
		if mask&1 == 0 {
			a.query = nil
		}
		if mask&2 == 0 {
			a.open = nil
		}
		if mask&4 == 0 {
			a.duplicate = nil
		}
		if mask&8 == 0 {
			a.close = nil
		}
		r, err := candidateDiagnoseShape(100, 400, a)
		if err == nil || r.complete || f.queries+f.opens+f.dups+len(f.closed) != 0 {
			t.Fatalf("partial bundle %d operated", mask)
		}
	}
}
func TestWindowsTokenShapeCustodyFailures(t *testing.T) {
	cause := errors.New("SECRET backend identity address environment")
	for _, stage := range []string{"primary-query", "source-query", "duplicate-query", "open-before", "open-partial", "duplicate-before", "duplicate-partial", "source-close", "duplicate-close", "both-close", "query-both-close"} {
		t.Run(stage, func(t *testing.T) {
			f := newCandidateShapeFake(t)
			query, open, dup, close := f.api.query, f.api.open, f.api.duplicate, f.api.close
			f.api.query = func(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
				if (stage == "primary-query" && token == 100) || (stage == "source-query" && token == 200) || ((stage == "duplicate-query" || stage == "query-both-close") && token == 300) {
					return cause
				}
				return query(token, class, out, n, used)
			}
			f.api.open = func(p windows.Handle, r uint32, o *windows.Token) error {
				if stage == "open-before" {
					f.opens++
					return cause
				}
				e := open(p, r, o)
				if stage == "open-partial" {
					return cause
				}
				return e
			}
			f.api.duplicate = func(in windows.Token, r, l, k uint32, o *windows.Token) error {
				if stage == "duplicate-before" {
					f.dups++
					return cause
				}
				e := dup(in, r, l, k, o)
				if stage == "duplicate-partial" {
					return cause
				}
				return e
			}
			sourceClose, dupClose := fmt.Errorf("source: %w", windows.ERROR_ACCESS_DENIED), fmt.Errorf("dup: %w", windows.ERROR_INVALID_HANDLE)
			f.api.close = func(token windows.Token) error {
				_ = close(token)
				if (strings.Contains(stage, "both-close") || stage == "source-close") && token == 200 {
					return sourceClose
				}
				if (strings.Contains(stage, "both-close") || stage == "duplicate-close") && token == 300 {
					return dupClose
				}
				return nil
			}
			r, err := candidateDiagnoseShape(100, 400, f.api)
			if err == nil || r.complete || strings.Contains(err.Error(), "SECRET") {
				t.Fatal("failure passed or leaked")
			}
			if (strings.Contains(stage, "query") || !strings.HasSuffix(stage, "close")) && !errors.Is(err, cause) {
				t.Fatal("lost opaque typed cause")
			}
			want := []windows.Token{300, 200}
			switch stage {
			case "primary-query", "open-before":
				want = nil
			case "source-query", "open-partial", "duplicate-before":
				want = []windows.Token{200}
			}
			if !slices.Equal(f.closed, want) {
				t.Fatal("partial outputs not retired exactly once")
			}
			if stage == "primary-query" && f.opens != 0 {
				t.Fatal("primary failure opened child")
			}
			if strings.Contains(stage, "both-close") && (!errors.Is(err, sourceClose) || !errors.Is(err, dupClose)) {
				t.Fatal("lost joined cleanup causes")
			}
			if strings.HasSuffix(stage, "close") {
				var errno syscall.Errno
				if !errors.As(err, &errno) || strings.Contains(err.Error(), "source:") || strings.Contains(err.Error(), "dup:") {
					t.Fatal("typed close cause lost or plaintext exposed")
				}
			}
		})
	}
	// Sticky close errors are never retried, even if a handle might be recycled.
	calls := 0
	owner := &candidatePrimaryOwner{token: 200, close: func(windows.Token) error { calls++; return cause }}
	if !errors.Is(owner.release(), cause) || !errors.Is(owner.release(), cause) || calls != 1 {
		t.Fatal("close not sticky")
	}
}
func TestWindowsTokenShapeAliases(t *testing.T) {
	for _, stage := range []string{"source", "duplicate"} {
		for _, out := range []windows.Token{0, windows.Token(^uintptr(0)), 100, 101, 102, 103, 200, 201, 202, 203, 400, 401} {
			if stage == "source" && out >= 200 && out <= 203 {
				continue
			}
			t.Run(fmt.Sprintf("%s/%d", stage, out), func(t *testing.T) {
				f := newCandidateShapeFake(t)
				if stage == "source" {
					f.api.open = func(_ windows.Handle, _ uint32, o *windows.Token) error { f.opens++; *o = out; return nil }
				} else {
					f.api.duplicate = func(_ windows.Token, _, _, _ uint32, o *windows.Token) error { f.dups++; *o = out; return nil }
				}
				r, err := candidateDiagnoseShape(100, 400, f.api)
				if err == nil || r.complete {
					t.Fatal("alias/pseudo accepted")
				}
				want := []windows.Token(nil)
				if stage == "duplicate" {
					want = []windows.Token{200}
				}
				if !slices.Equal(f.closed, want) {
					t.Fatal("closed borrowed or other owner's alias")
				}
			})
		}
	}
	for _, primary := range []windows.Token{0, 101, windows.Token(^uintptr(0))} {
		f := newCandidateShapeFake(t)
		if _, e := candidateDiagnoseShape(primary, 400, f.api); e == nil || f.queries+f.opens != 0 {
			t.Fatal("invalid borrowed primary operated")
		}
	}
}
func TestWindowsTokenShapeSemanticMismatch(t *testing.T) {
	for _, field := range []string{"group-attr", "group-SID", "restricted-attr", "restricted-SID", "privilege-attr", "LUID", "type", "level"} {
		t.Run(field, func(t *testing.T) {
			f := newCandidateShapeFake(t)
			s := f.shapes[300]
			switch field {
			case "group-attr":
				s.groups[0].attrs ^= 1
			case "group-SID":
				s.groups[0].sid = candidateSIDBytes(5, 1, 20)
			case "restricted-attr":
				s.restricted[0].attrs ^= 1
			case "restricted-SID":
				s.restricted[0].sid = candidateSIDBytes(5, 1, 22)
			case "privilege-attr":
				s.privileges[0].Attributes ^= 1
			case "LUID":
				s.privileges[0].Luid.HighPart++
			case "type":
				s.kind = windows.TokenPrimary
			case "level":
				s.level = windows.SecurityIdentification
			}
			f.shapes[300] = s
			if r, e := candidateDiagnoseShape(100, 400, f.api); e == nil || r.complete || !slices.Equal(f.closed, []windows.Token{300, 200}) {
				t.Fatal("duplicate inconsistency accepted")
			}
		})
	}
}

func TestWindowsTokenShapeMalformedQueries(t *testing.T) {
	for _, class := range []uint32{windows.TokenGroups, windows.TokenRestrictedSids, windows.TokenPrivileges} {
		for _, mode := range []string{"probe-success", "probe-error", "size-zero", "oversize", "fetch-error", "partial-error", "changed-smaller", "changed-larger", "header", "count-overflow", "array-truncated", "SID-nil", "SID-foreign", "SID-array", "SID-later-entry", "SID-unaligned", "SID-end", "SID-revision", "SID-count", "SID-truncated", "duplicate-entry", "privilege-tail"} {
			if class == windows.TokenPrivileges && strings.HasPrefix(mode, "SID-") {
				continue
			}
			if class != windows.TokenPrivileges && mode == "privilege-tail" {
				continue
			}
			t.Run(fmt.Sprintf("%d/%s", class, mode), func(t *testing.T) {
				f := newCandidateShapeFake(t)
				query := f.api.query
				opaque := errors.New("SECRET malformed query backend")
				f.api.query = func(token windows.Token, c uint32, out *byte, n uint32, used *uint32) error {
					if token != 200 || c != class {
						return query(token, c, out, n, used)
					}
					if out == nil {
						switch mode {
						case "probe-success":
							return nil
						case "probe-error":
							return opaque
						case "size-zero":
							*used = 0
							return windows.ERROR_INSUFFICIENT_BUFFER
						case "oversize":
							*used = maxCandidateTokenBytes + 1
							return windows.ERROR_INSUFFICIENT_BUFFER
						case "header":
							*used = 3
							return windows.ERROR_INSUFFICIENT_BUFFER
						}
					} else {
						if mode == "header" {
							*used = n
							clear(unsafe.Slice(out, n))
							return nil
						}
						if mode == "fetch-error" {
							return opaque
						}
					}
					e := query(token, c, out, n, used)
					if e != nil || out == nil {
						return e
					}
					b := unsafe.Slice(out, n)
					switch mode {
					case "partial-error":
						binary.LittleEndian.PutUint32(b, ^uint32(0))
						return opaque
					case "changed-smaller":
						*used = n - 1
					case "changed-larger":
						*used = n + 1
					case "count-overflow":
						binary.LittleEndian.PutUint32(b, ^uint32(0))
					case "array-truncated":
						binary.LittleEndian.PutUint32(b, n)
					case "privilege-tail":
						binary.LittleEndian.PutUint32(b, 0)
					case "duplicate-entry":
						if c == windows.TokenPrivileges {
							*(*windows.LUIDAndAttributes)(unsafe.Pointer(&b[16])) = *(*windows.LUIDAndAttributes)(unsafe.Pointer(&b[4]))
						} else {
							h := unsafe.Offsetof(windows.Tokengroups{}.Groups)
							a := (*windows.SIDAndAttributes)(unsafe.Pointer(&b[h]))
							z := (*windows.SIDAndAttributes)(unsafe.Pointer(&b[h+unsafe.Sizeof(*a)]))
							z.Sid = a.Sid
						}
					default:
						if strings.HasPrefix(mode, "SID-") {
							h := unsafe.Offsetof(windows.Tokengroups{}.Groups)
							g := (*windows.SIDAndAttributes)(unsafe.Pointer(&b[h]))
							end := h + uintptr(binary.LittleEndian.Uint32(b))*unsafe.Sizeof(*g)
							switch mode {
							case "SID-nil":
								g.Sid = nil
							case "SID-foreign":
								g.Sid = (*windows.SID)(unsafe.Pointer(new([16]byte)))
							case "SID-array":
								g.Sid = (*windows.SID)(unsafe.Pointer(&b[h]))
							case "SID-later-entry":
								g.Sid = (*windows.SID)(unsafe.Pointer(&b[end-unsafe.Sizeof(*g)]))
							case "SID-unaligned":
								g.Sid = (*windows.SID)(unsafe.Pointer(&b[end+1]))
							case "SID-end":
								g.Sid = (*windows.SID)(unsafe.Pointer(&b[len(b)-4]))
							case "SID-revision":
								b[end] = 2
							case "SID-count":
								b[end+1] = 16
							case "SID-truncated":
								b[end+1] = 15
							}
						}
					}
					return nil
				}
				r, err := candidateDiagnoseShape(100, 400, f.api)
				if err == nil || r.complete || strings.Contains(err.Error(), "SECRET") || !slices.Equal(f.closed, []windows.Token{200}) {
					t.Fatal("malformed inventory accepted/leaked or custody lost")
				}
				if (mode == "probe-error" || mode == "fetch-error" || mode == "partial-error") && !errors.Is(err, opaque) {
					t.Fatal("query error cause lost")
				}
			})
		}
	}
}

func TestWindowsTokenShapeDWORDAndDiagnosticNonauthority(t *testing.T) {
	for _, token := range []windows.Token{100, 200, 300} {
		for _, class := range []uint32{windows.TokenType, windows.TokenImpersonationLevel} {
			if class == windows.TokenImpersonationLevel && token != 300 {
				continue
			}
			for _, mode := range []string{"error-after-write", "short", "oversize"} {
				t.Run(fmt.Sprintf("%d/%d/%s", token, class, mode), func(t *testing.T) {
					f := newCandidateShapeFake(t)
					query := f.api.query
					f.api.query = func(tok windows.Token, c uint32, out *byte, n uint32, used *uint32) error {
						e := query(tok, c, out, n, used)
						if tok == token && c == class {
							switch mode {
							case "error-after-write":
								return windows.ERROR_ACCESS_DENIED
							case "short":
								*used = 3
							case "oversize":
								*used = 8
							}
						}
						return e
					}
					if r, e := candidateDiagnoseShape(100, 400, f.api); e == nil || r.complete {
						t.Fatal("malformed DWORD accepted")
					}
					if token == 100 && f.opens != 0 {
						t.Fatal("failed primary acquired source")
					}
				})
			}
		}
	}
	// A diagnostic failure sticks AFTER the same early cleanup witness, without
	// changing either value of the real exact-job result or manufacturing authority.
	for _, member := range []bool{false, true} {
		f := newCandidateShapeFake(t)
		witnessed := false
		var sticky error
		diagnosed := 0
		f.api.query = func(windows.Token, uint32, *byte, uint32, *uint32) error {
			if !witnessed {
				t.Fatal("shape query preceded cleanup witness")
			}
			return windows.ERROR_ACCESS_DENIED
		}
		verify := candidateAccessVerify(func(windows.Handle, windows.Handle) (bool, error) { return member, nil }, func(windows.Handle) error { witnessed = true; return nil }, func(p windows.Handle) error { diagnosed++; _, e := candidateDiagnoseShape(100, p, f.api); return e }, &sticky)
		got, e := verify(400, 500)
		if got != member || e != nil || witnessed != member || (sticky != nil) != member || diagnosed != map[bool]int{false: 0, true: 1}[member] {
			t.Fatal("inventory changed exact-job result or bypassed witness")
		}
		if member && (!errors.Is(sticky, windows.ERROR_ACCESS_DENIED) || f.opens != 0) {
			t.Fatal("diagnostic cause/primary-first refusal lost")
		}
	}
}
