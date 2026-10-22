//go:build windows

package process

import (
	"bytes"
	"encoding/binary"
	"errors"
	"runtime"
	"slices"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Test-only inventory, not a token classifier or an execution authority.
// Every operation is explicit, including retirement. No per-field native defaults.
type candidateShapeAPI struct {
	query     windowsTokenInformation
	open      func(windows.Handle, uint32, *windows.Token) error
	duplicate func(windows.Token, uint32, uint32, uint32, *windows.Token) error
	close     func(windows.Token) error
}

func candidateShapeNativeAPI(t *testing.T) candidateShapeAPI {
	t.Helper()
	candidateRequireEphemeralWindowsCI(t)
	return candidateShapeAPI{
		query: windows.GetTokenInformation, open: windows.OpenProcessToken,
		duplicate: func(in windows.Token, rights, level, kind uint32, out *windows.Token) error {
			return windows.DuplicateTokenEx(in, rights, nil, level, kind, out)
		},
		close: func(token windows.Token) error { return token.Close() },
	}
}

type candidateShapeSnapshot struct {
	groups, restricted []candidatePrimaryGroup
	privileges         []windows.LUIDAndAttributes
	kind, level        uint32
	complete           bool
}
type candidateShapeReport struct {
	primary, source, duplicate     candidateShapeSnapshot // raw identities MUST stay internal
	sourceDuplicateEqual, complete bool
}

// Do not expose opaque backend messages, even for joined query/close failures.
// Is/As still reach every original typed cause.
type candidateShapeError struct{ cause error }

func (candidateShapeError) Error() string   { return "token shape diagnostic refused (details withheld)" }
func (e candidateShapeError) Unwrap() error { return e.cause }

func candidateShapeABI() bool {
	p := unsafe.Sizeof(uintptr(0))
	return (p == 4 || p == 8) && unsafe.Offsetof(windows.Tokengroups{}.Groups) == p &&
		unsafe.Sizeof(windows.SIDAndAttributes{}) == 2*p &&
		unsafe.Offsetof(windows.SIDAndAttributes{}.Attributes) == p &&
		unsafe.Offsetof(windows.Tokenprivileges{}.Privileges) == 4 &&
		unsafe.Sizeof(windows.LUIDAndAttributes{}) == 12
}

// Same bounded, aligned two-call pattern as queryCandidateToken, but inventory
// refuses ANY extent change rather than accepting a smaller second result.
func candidateShapeVariable(token windows.Token, class uint32, query windowsTokenInformation) (windowsTokenBuffer, error) {
	var needed uint32
	if err := query(token, class, nil, 0, &needed); !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
		return windowsTokenBuffer{}, errors.Join(errors.New("shape size query refused"), err)
	}
	if needed == 0 || needed > maxCandidateTokenBytes {
		return windowsTokenBuffer{}, errors.New("shape size refused")
	}
	word := uint32(unsafe.Sizeof(uintptr(0)))
	b := windowsTokenBuffer{words: make([]uintptr, (needed+word-1)/word), size: needed}
	var used uint32
	if err := query(token, class, &b.bytes()[0], needed, &used); err != nil {
		return windowsTokenBuffer{}, err
	}
	if used != needed {
		return windowsTokenBuffer{}, errors.New("shape changed extent refused")
	}
	return b, nil
}

// Validate canonical bytes in the owned allocation, never call x/sys SID
// interior metadata helpers (or native IsValidSid) on an embedded pointer.
func candidateShapeSID(b windowsTokenBuffer, sid *windows.SID, arrayEnd uintptr) ([]byte, error) {
	data := b.bytes()
	base, address := uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(sid))
	if address < base || address%4 != 0 || address-base < arrayEnd || address-base > uintptr(len(data)) {
		return nil, errors.New("shape SID provenance refused")
	}
	off := address - base
	if uintptr(len(data))-off < 8 {
		return nil, errors.New("shape SID header refused")
	}
	count := uintptr(data[off+1])
	if data[off] != 1 || count > 15 || 8+4*count > uintptr(len(data))-off {
		return nil, errors.New("shape SID extent refused")
	}
	return bytes.Clone(data[off : off+8+4*count]), nil
}

func candidateShapeGroups(b windowsTokenBuffer) ([]candidatePrimaryGroup, error) {
	header, entry := unsafe.Offsetof(windows.Tokengroups{}.Groups), unsafe.Sizeof(windows.SIDAndAttributes{})
	if uintptr(b.size) < header {
		return nil, errors.New("shape groups header refused")
	}
	count := uintptr(binary.LittleEndian.Uint32(b.bytes()))
	if count > (uintptr(b.size)-header)/entry {
		return nil, errors.New("shape groups array refused")
	}
	end := header + count*entry // count bounded BEFORE multiply/add, including 32-bit builds
	result := make([]candidatePrimaryGroup, 0, count)
	seen := make(map[string]bool)
	for i := uintptr(0); i < count; i++ {
		g := (*windows.SIDAndAttributes)(unsafe.Pointer(&b.bytes()[header+i*entry]))
		sid, err := candidateShapeSID(b, g.Sid, end)
		if err != nil {
			return nil, err
		}
		if seen[string(sid)] {
			return nil, errors.New("shape duplicate SID refused")
		}
		seen[string(sid)] = true
		result = append(result, candidatePrimaryGroup{sid: sid, attrs: g.Attributes})
	}
	runtime.KeepAlive(b)
	slices.SortFunc(result, func(a, b candidatePrimaryGroup) int { return bytes.Compare(a.sid, b.sid) })
	return result, nil
}
func candidateShapePrivileges(b windowsTokenBuffer) ([]windows.LUIDAndAttributes, error) {
	const header, entry = uintptr(4), uintptr(12)
	if uintptr(b.size) < header {
		return nil, errors.New("shape privileges header refused")
	}
	count := uintptr(binary.LittleEndian.Uint32(b.bytes()))
	if count > (uintptr(b.size)-header)/entry || header+count*entry != uintptr(b.size) {
		return nil, errors.New("shape privileges array refused")
	}
	result := make([]windows.LUIDAndAttributes, 0, count)
	seen := make(map[windows.LUID]bool)
	for i := uintptr(0); i < count; i++ {
		p := *(*windows.LUIDAndAttributes)(unsafe.Pointer(&b.bytes()[header+i*entry]))
		if seen[p.Luid] {
			return nil, errors.New("shape duplicate LUID refused")
		}
		seen[p.Luid] = true
		result = append(result, p)
	}
	runtime.KeepAlive(b)
	slices.SortFunc(result, func(a, b windows.LUIDAndAttributes) int {
		if a.Luid.HighPart < b.Luid.HighPart {
			return -1
		}
		if a.Luid.HighPart > b.Luid.HighPart {
			return 1
		}
		if a.Luid.LowPart < b.Luid.LowPart {
			return -1
		}
		if a.Luid.LowPart > b.Luid.LowPart {
			return 1
		}
		return 0
	})
	return result, nil
}
func candidateCollectShape(token windows.Token, kind uint32, query windowsTokenInformation) (s candidateShapeSnapshot, err error) {
	if err = candidateAccessDWORD(token, windows.TokenType, kind, query); err != nil {
		return s, err
	}
	s.kind = kind
	if kind == windows.TokenImpersonation {
		if err = candidateAccessDWORD(token, windows.TokenImpersonationLevel, windows.SecurityImpersonation, query); err != nil {
			return s, err
		}
		s.level = windows.SecurityImpersonation
	}
	for _, field := range []struct {
		class uint32
		out   *[]candidatePrimaryGroup
	}{{windows.TokenGroups, &s.groups}, {windows.TokenRestrictedSids, &s.restricted}} {
		b, e := candidateShapeVariable(token, field.class, query)
		if e != nil {
			return s, e
		}
		*field.out, e = candidateShapeGroups(b)
		if e != nil {
			return s, e
		}
	}
	b, err := candidateShapeVariable(token, windows.TokenPrivileges, query)
	if err != nil {
		return s, err
	}
	s.privileges, err = candidateShapePrivileges(b)
	if err != nil {
		return s, err
	}
	s.complete = true
	return s, nil
}
func candidateShapeEqual(a, b candidateShapeSnapshot) bool {
	groups := func(a, b candidatePrimaryGroup) bool { return a.attrs == b.attrs && bytes.Equal(a.sid, b.sid) }
	// Type/level intentionally differ: primary source vs SecurityImpersonation dup.
	return a.complete && b.complete && slices.EqualFunc(a.groups, b.groups, groups) && slices.EqualFunc(a.restricted, b.restricted, groups) && slices.Equal(a.privileges, b.privileges)
}
func candidateShapeAlias(a, b windows.Token) bool {
	return uintptr(a)&^uintptr(3) == uintptr(b)&^uintptr(3)
}
func candidateShapeHandle(token windows.Token) bool {
	return candidateRealToken(token) && uintptr(token)&3 == 0
}

func candidateDiagnoseShape(primary windows.Token, process windows.Handle, api candidateShapeAPI) (report candidateShapeReport, err error) {
	// COMPLETE bundle before ANY query/open/duplicate/close, including primary.
	if api.query == nil || api.open == nil || api.duplicate == nil || api.close == nil || !candidateShapeABI() {
		return report, candidateShapeError{errors.New("incomplete shape dependencies/ABI")}
	}
	if !candidateShapeHandle(primary) || !candidateShapeHandle(windows.Token(process)) || candidateShapeAlias(primary, windows.Token(process)) {
		return report, candidateShapeError{errors.New("invalid borrowed shape handles")}
	}
	var source, duplicate *candidatePrimaryOwner
	defer func() {
		err = errors.Join(err, duplicate.release(), source.release())
		if err != nil {
			report.complete = false
			err = candidateShapeError{err}
		}
	}()
	// Deterministic order: failed borrowed-primary collection opens NO new tokens.
	report.primary, err = candidateCollectShape(primary, windows.TokenPrimary, api.query)
	if err != nil {
		return report, err
	}
	var out windows.Token
	openErr := api.open(process, windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &out)
	if candidateShapeAlias(out, primary) || candidateShapeAlias(out, windows.Token(process)) {
		return report, errors.Join(errors.New("shape source aliases borrowed owner"), openErr)
	}
	source = &candidatePrimaryOwner{token: out, close: api.close}
	if openErr != nil {
		return report, openErr
	}
	if !candidateShapeHandle(out) {
		return report, errors.New("shape source handle refused")
	}
	report.source, err = candidateCollectShape(out, windows.TokenPrimary, api.query)
	if err != nil {
		return report, err
	}
	out = 0
	dupErr := api.duplicate(source.token, windows.TOKEN_QUERY, windows.SecurityImpersonation, windows.TokenImpersonation, &out)
	if candidateShapeAlias(out, primary) || candidateShapeAlias(out, source.token) || candidateShapeAlias(out, windows.Token(process)) {
		return report, errors.Join(errors.New("shape duplicate aliases another owner"), dupErr)
	}
	duplicate = &candidatePrimaryOwner{token: out, close: api.close}
	if dupErr != nil {
		return report, dupErr
	}
	if !candidateShapeHandle(out) {
		return report, errors.New("shape duplicate handle refused")
	}
	report.duplicate, err = candidateCollectShape(out, windows.TokenImpersonation, api.query)
	if err != nil {
		return report, err
	}
	report.sourceDuplicateEqual = candidateShapeEqual(report.source, report.duplicate)
	if !report.sourceDuplicateEqual {
		return report, errors.New("shape duplicate content mismatch")
	}
	report.complete = true
	return report, nil
}

func candidateLogShapeReport(t *testing.T, r candidateShapeReport, err error) {
	t.Helper()
	t.Logf("token shape: complete=%v error=%v sourceDuplicateEqual=%v (inventory only; no authorization)", r.complete, err != nil, r.sourceDuplicateEqual)
	for i, s := range []candidateShapeSnapshot{r.primary, r.source, r.duplicate} {
		var groupFlags, restrictedFlags, privilegeFlags uint32
		for _, g := range s.groups {
			groupFlags |= g.attrs
		}
		for _, g := range s.restricted {
			restrictedFlags |= g.attrs
		}
		for _, p := range s.privileges {
			privilegeFlags |= p.Attributes
		}
		t.Logf("token shape role=%d complete=%v kind=%d level=%d groups=%d restricted=%d privileges=%d groupAttributeFlags=0x%x restrictedAttributeFlags=0x%x privilegeAttributeFlags=0x%x", i, s.complete, s.kind, s.level, len(s.groups), len(s.restricted), len(s.privileges), groupFlags, restrictedFlags, privilegeFlags)
	}
}
