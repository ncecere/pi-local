//go:build windows

package process

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Unwired behavioral check for controlled creation ONLY, through retained own
// child handles. Restricted-token lookalikes can mimic this matrix. This is not
// a general token classifier, an error fallback, or proof of confinement. The
// launcher's original mandatory selector46 gate remains authoritative.
//
// source is BORROWED and must already have QUERY|DUPLICATE at a future deliberate
// launcher boundary. This helper cannot open a process/token or widen rights.
// profile is the exact, trusted creation profile, not inferred from the token.
func verifyWindowsLPACSemantics(source windows.Token, profile []byte, api lpacAccessAPI) (err error) {
	// No per-field native defaults: validate the ENTIRE bundle before any call.
	if !api.complete() || !lpacAccessABI() {
		return errors.New("process: LPAC semantic dependencies/ABI refused")
	}
	if !lpacRealToken(source) || !candidateSIDMatches(profile, [6]byte{0, 0, 0, 0, 0, 15}, 8, 2) {
		return errors.New("process: LPAC semantic source/profile refused")
	}
	profile = bytes.Clone(profile)
	owner := &lpacDuplicateOwner{close: api.close}
	defer func() { err = lpacBoundError(errors.Join(err, owner.release())) }()
	if err = lpacAccessDWORD(source, windows.TokenType, windows.TokenPrimary, api.query); err != nil {
		return err
	}
	if err = lpacAccessMetadata(source, profile, api.query); err != nil {
		return err
	}
	user, err := lpacAccessIdentity(source, windows.TokenUser, api.query)
	if err != nil {
		return err
	}
	group, err := lpacAccessIdentity(source, windows.TokenPrimaryGroup, api.query)
	if err != nil {
		return err
	}
	var out windows.Token
	dupErr := api.duplicate(source, windows.TOKEN_QUERY, windows.SecurityImpersonation, windows.TokenImpersonation, &out)
	// Windows ignores the low two handle tag bits. Never retire a borrowed alias,
	// including one returned with an API error. Partial distinct output is owned
	// for cleanup but NEVER accepted as a successful duplicate.
	if uintptr(out)&^uintptr(3) == uintptr(source)&^uintptr(3) {
		return errors.Join(errors.New("process: LPAC semantic duplicate aliases source"), dupErr)
	}
	owner.token = out
	if dupErr != nil {
		return dupErr
	}
	if !lpacRealToken(out) {
		return errors.New("process: LPAC semantic duplicate refused")
	}
	if err = lpacAccessDWORD(out, windows.TokenType, windows.TokenImpersonation, api.query); err != nil {
		return err
	}
	if err = lpacAccessDWORD(out, windows.TokenImpersonationLevel, windows.SecurityImpersonation, api.query); err != nil {
		return err
	}
	if err = lpacAccessMetadata(out, profile, api.query); err != nil {
		return err
	}
	for _, field := range []struct {
		class uint32
		want  []byte
	}{{windows.TokenUser, user}, {windows.TokenPrimaryGroup, group}} {
		got, e := lpacAccessIdentity(out, field.class, api.query)
		if e != nil || !bytes.Equal(got, field.want) {
			return errors.Join(errors.New("process: LPAC semantic duplicate identity refused"), e)
		}
	}
	// Exact S-1-15-2-1, not S-1-15-2-0 or a capability/profile SID.
	aap := []byte{1, 2, 0, 0, 0, 0, 0, 15, 2, 0, 0, 0, 1, 0, 0, 0}
	packages := [3][]byte{nil, aap, profile}
	var descriptors [3]lpacAccessSD
	for i, sid := range packages {
		// A builder cannot rewrite our expected bindings through its arguments.
		descriptors[i], err = api.buildSD(bytes.Clone(user), bytes.Clone(group), bytes.Clone(sid))
		if err != nil {
			return err
		}
	}
	// Validate AFTER all builds, before any native SD walker or AccessCheck.
	for i, sd := range descriptors {
		if !lpacValidAccessSD(sd, user, group, packages[i]) {
			return errors.New("process: LPAC semantic SD binding refused")
		}
		for j := 0; j < i; j++ {
			if lpacSDOverlap(sd, descriptors[j]) {
				return errors.New("process: LPAC semantic SD storage aliases")
			}
		}
	}
	for i, sd := range descriptors {
		allowed, e := lpacAccessCheck(sd, out, api)
		if e != nil {
			return e // API errors are never a DENY decision.
		}
		if allowed != (i == 2) {
			return errors.New("process: LPAC semantic control matrix refused")
		}
	}
	return nil // deferred retirement can still refuse success
}

type lpacAccessMapping struct{ read, write, execute, all uint32 }
type lpacAccessPrivilegeSet struct {
	count, control uint32
	entries        [1]windows.LUIDAndAttributes
}

// SDK winnt.h: DWORD/BOOL=4, GENERIC_MAPPING=16, PRIVILEGE_SET=20.
func lpacAccessABI() bool {
	return unsafe.Sizeof(uint32(0)) == 4 && unsafe.Sizeof(int32(0)) == 4 &&
		unsafe.Sizeof(lpacAccessMapping{}) == 16 && unsafe.Sizeof(lpacAccessPrivilegeSet{}) == 20 &&
		unsafe.Offsetof(lpacAccessPrivilegeSet{}.entries) == 8 && unsafe.Sizeof(windows.LUIDAndAttributes{}) == 12
}

func lpacFileMapping() lpacAccessMapping {
	return lpacAccessMapping{windows.FILE_GENERIC_READ, windows.FILE_GENERIC_WRITE, windows.FILE_GENERIC_EXECUTE, windows.STANDARD_RIGHTS_REQUIRED | windows.SYNCHRONIZE | 0x1ff}
}

type lpacAccessAPI struct {
	query     windowsTokenInformation
	duplicate func(windows.Token, uint32, uint32, uint32, *windows.Token) error
	close     func(windows.Token) error
	buildSD   func([]byte, []byte, []byte) (lpacAccessSD, error)
	validSD   func(*byte) bool
	access    func(*byte, windows.Token, uint32, *lpacAccessMapping, *byte, *uint32, *uint32, *int32) error
}

func (a lpacAccessAPI) complete() bool {
	return a.query != nil && a.duplicate != nil && a.close != nil && a.buildSD != nil && a.validSD != nil && a.access != nil
}

func lpacRealToken(t windows.Token) bool {
	return uintptr(t)&^uintptr(3) != 0 && uintptr(t) < ^uintptr(0)-15
}

type lpacDuplicateOwner struct {
	token    windows.Token
	close    func(windows.Token) error
	released bool
	err      error
}

func (o *lpacDuplicateOwner) release() error {
	if !o.released {
		o.released = true
		if lpacRealToken(o.token) {
			o.err = o.close(o.token)
		}
	}
	return o.err // sticky: never retry a potentially recycled handle
}

func lpacAccessSID(s []byte) bool {
	return len(s) >= 8 && s[0] == 1 && s[1] > 0 && s[1] <= 15 && len(s) == 8+4*int(s[1])
}

// Pure owned-buffer SID parsing: no native SID pointer-return helpers or
// uintptr-to-pointer reconstruction. Even fake inputs never reach native token
// APIs, SID APIs, or an implicit SystemDLL default.
func lpacOwnedSID(b windowsTokenBuffer, sid *windows.SID, header uintptr) ([]byte, error) {
	data := b.bytes()
	base, address := uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(sid))
	if address < base || address-base < header || address-base > uintptr(len(data)) || address%4 != 0 {
		return nil, errors.New("process: LPAC semantic SID outside owned buffer")
	}
	offset := address - base
	if uintptr(len(data))-offset < 8 {
		return nil, errors.New("process: LPAC semantic SID header refused")
	}
	n := 8 + 4*uintptr(data[offset+1])
	if n > uintptr(len(data))-offset || !lpacAccessSID(data[offset:offset+n]) {
		return nil, errors.New("process: LPAC semantic SID extent refused")
	}
	return bytes.Clone(data[offset : offset+n]), nil
}

func lpacAccessDWORD(token windows.Token, class, want uint32, query windowsTokenInformation) error {
	switch class {
	case windows.TokenType, windows.TokenImpersonationLevel, tokenIsAppContainer, windows.TokenElevation:
	default:
		return errors.New("process: LPAC semantic DWORD class refused")
	}
	var got, used uint32
	if err := query(token, class, (*byte)(unsafe.Pointer(&got)), 4, &used); err != nil {
		return err
	}
	if used != 4 || got != want {
		return errors.New("process: LPAC semantic DWORD value/extent refused")
	}
	return nil
}

func lpacAccessIdentity(token windows.Token, class uint32, query windowsTokenInformation) ([]byte, error) {
	if class != windows.TokenUser && class != windows.TokenPrimaryGroup {
		return nil, errors.New("process: LPAC semantic identity class refused")
	}
	b, err := queryCandidateToken(token, class, query)
	if err != nil {
		return nil, err
	}
	header := unsafe.Sizeof(windows.Tokenprimarygroup{})
	if class == windows.TokenUser {
		header = unsafe.Sizeof(windows.Tokenuser{})
	}
	if uintptr(b.size) < header {
		return nil, errors.New("process: LPAC semantic identity header refused")
	}
	var sid *windows.SID
	if class == windows.TokenUser {
		sid = (*windows.Tokenuser)(unsafe.Pointer(&b.words[0])).User.Sid
	} else {
		sid = (*windows.Tokenprimarygroup)(unsafe.Pointer(&b.words[0])).PrimaryGroup
	}
	span, err := lpacOwnedSID(b, sid, header)
	runtime.KeepAlive(b)
	return span, err
}

// Metadata ONLY. No policy fabrication or selector46 query. The original
// verifyWindowsAppContainerToken (including all its errors/checks) is unchanged.
func lpacAccessMetadata(token windows.Token, profile []byte, query windowsTokenInformation) error {
	for _, check := range []struct{ class, want uint32 }{{tokenIsAppContainer, 1}, {windows.TokenElevation, 0}} {
		if err := lpacAccessDWORD(token, check.class, check.want, query); err != nil {
			return err
		}
	}
	for _, class := range []uint32{tokenAppContainerSID, tokenCapabilities, windows.TokenIntegrityLevel} {
		b, err := queryCandidateToken(token, class, query)
		if err != nil {
			return err
		}
		if class == tokenCapabilities {
			if b.size < 4 || binary.LittleEndian.Uint32(b.bytes()) != 0 {
				return errors.New("process: LPAC semantic capabilities refused")
			}
			continue
		}
		header := unsafe.Sizeof(windowsTokenAppContainerInformation{})
		if class == windows.TokenIntegrityLevel {
			header = unsafe.Sizeof(windows.Tokenmandatorylabel{})
		}
		if uintptr(b.size) < header {
			return errors.New("process: LPAC semantic metadata header refused")
		}
		var sid *windows.SID
		if class == tokenAppContainerSID {
			sid = (*windowsTokenAppContainerInformation)(unsafe.Pointer(&b.words[0])).sid
		} else {
			label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&b.words[0]))
			if label.Label.Attributes != windows.SE_GROUP_INTEGRITY && label.Label.Attributes != windows.SE_GROUP_INTEGRITY|windows.SE_GROUP_INTEGRITY_ENABLED {
				return errors.New("process: LPAC semantic integrity attributes refused")
			}
			sid = label.Label.Sid
		}
		span, err := lpacOwnedSID(b, sid, header)
		runtime.KeepAlive(b)
		if err != nil {
			return err
		}
		matches := bytes.Equal(span, profile)
		if class == windows.TokenIntegrityLevel {
			matches = candidateSIDMatches(span, [6]byte{0, 0, 0, 0, 0, 16}, 1, 0x1000)
		}
		if !matches {
			return errors.New("process: LPAC semantic exact profile/Low refused")
		}
	}
	return nil
}

type lpacAccessSD struct {
	words []uint32
	size  int
}

func (s lpacAccessSD) data() []byte {
	if s.size < 20 || s.size > 4096 || len(s.words) < (s.size+3)/4 {
		return nil
	}
	return unsafe.Slice((*byte)(unsafe.Pointer(&s.words[0])), s.size)
}

func lpacSDOverlap(a, b lpacAccessSD) bool {
	x, y := uintptr(unsafe.Pointer(&a.words[0])), uintptr(unsafe.Pointer(&b.words[0]))
	return x < y+uintptr(b.size) && y < x+uintptr(a.size)
}

// Exact content binding, not just structural grammar. Accept any native ordering
// of three contiguous, non-overlapping components; reject padding, aliases,
// defaulted flags, NULL DACL, SACL, extra ACEs, masks, flags and wrong identities.
func lpacValidAccessSD(s lpacAccessSD, user, group, packageSID []byte) bool {
	b := s.data()
	if !lpacAccessSID(user) || !lpacAccessSID(group) || (packageSID != nil && !lpacAccessSID(packageSID)) ||
		len(b) < 20 || len(b)%4 != 0 || b[0] != 1 || b[1] != 0 || binary.LittleEndian.Uint16(b[2:]) != 0x8004 || binary.LittleEndian.Uint32(b[12:]) != 0 {
		return false
	}
	boundSID := func(off int, want []byte) (int, bool) {
		if off < 20 || off%4 != 0 || off > len(b)-len(want) || !bytes.Equal(b[off:off+len(want)], want) {
			return 0, false
		}
		return off + len(want), true
	}
	u, g, d := int(binary.LittleEndian.Uint32(b[4:])), int(binary.LittleEndian.Uint32(b[8:])), int(binary.LittleEndian.Uint32(b[16:]))
	endUser, ok := boundSID(u, user)
	if !ok {
		return false
	}
	endGroup, ok := boundSID(g, group)
	if !ok || d < 20 || d%4 != 0 || d > len(b)-8 {
		return false
	}
	count := 1
	if packageSID != nil {
		count++
	}
	aclSize := int(binary.LittleEndian.Uint16(b[d+2:]))
	if b[d] != 2 || b[d+1] != 0 || aclSize < 8 || aclSize > len(b)-d || int(binary.LittleEndian.Uint16(b[d+4:])) != count || binary.LittleEndian.Uint16(b[d+6:]) != 0 {
		return false
	}
	off := d + 8
	for _, sid := range [][]byte{user, packageSID} {
		if sid == nil {
			continue
		}
		if off > len(b)-8 || b[off] != 0 || b[off+1] != 0 || binary.LittleEndian.Uint32(b[off+4:]) != windows.FILE_READ_DATA || int(binary.LittleEndian.Uint16(b[off+2:])) != 8+len(sid) {
			return false
		}
		var valid bool
		off, valid = boundSID(off+8, sid)
		if !valid {
			return false
		}
	}
	if off != d+aclSize {
		return false
	}
	spans := [3][2]int{{u, endUser}, {g, endGroup}, {d, off}}
	for i := 0; i < 3; i++ {
		for j := i + 1; j < 3; j++ {
			if spans[j][0] < spans[i][0] {
				spans[i], spans[j] = spans[j], spans[i]
			}
		}
	}
	return spans[0][0] == 20 && spans[0][1] == spans[1][0] && spans[1][1] == spans[2][0] && spans[2][1] == len(b)
}

func lpacAccessCheck(sd lpacAccessSD, token windows.Token, api lpacAccessAPI) (bool, error) {
	data := sd.data() // caller has already bound all three descriptors
	if len(data) == 0 || !api.validSD(&data[0]) {
		return false, errors.New("process: LPAC semantic native SD refused")
	}
	size := uint32(20)
	for attempt := 0; attempt < 2; attempt++ {
		storage := make([]uint32, (size+3)/4)
		raw := unsafe.Slice((*byte)(unsafe.Pointer(&storage[0])), int(size))
		used, granted, status := size, uint32(0), int32(0)
		mapping := lpacFileMapping()
		err := api.access(&data[0], token, windows.FILE_READ_DATA, &mapping, &raw[0], &used, &granted, &status)
		runtime.KeepAlive(sd)
		runtime.KeepAlive(storage)
		if err != nil {
			if attempt == 0 && errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) && used > size && used <= 4096 {
				size = used
				continue
			}
			return false, err
		}
		if mapping != lpacFileMapping() || used < 8 || used > size || binary.LittleEndian.Uint32(raw) > (used-8)/12 || binary.LittleEndian.Uint32(raw) != 0 || binary.LittleEndian.Uint32(raw[4:]) & ^uint32(1) != 0 || (status != 0 && status != 1) || granted & ^uint32(windows.FILE_READ_DATA) != 0 || (status == 0 && granted != 0) || (status == 1 && granted != windows.FILE_READ_DATA) {
			return false, errors.New("process: LPAC semantic AccessCheck output refused")
		}
		return status == 1, nil
	}
	return false, errors.New("process: LPAC semantic retry exhausted")
}

// Never stringify injected/native opaque errors (they can contain identities).
// Retain numeric classification and errors.Is/As without exposing their text.
type lpacAccessError struct{ cause error }

func (e lpacAccessError) Error() string {
	var code syscall.Errno
	present := errors.As(e.cause, &code)
	return fmt.Sprintf("process: LPAC semantic refusal numericCodePresent=%v code=%d", present, uint64(code))
}
func (e lpacAccessError) Unwrap() error { return e.cause }
func lpacBoundError(err error) error {
	if err == nil {
		return nil
	}
	return lpacAccessError{cause: err}
}
