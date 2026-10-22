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

// TEST ONLY. None of these observations can authorize a launch or replace 46.
// SDK winnt.h: DWORD/BOOL=4, GENERIC_MAPPING=16, PRIVILEGE_SET=20.
type candidateAccessMapping struct{ read, write, execute, all uint32 }
type candidateAccessPrivilegeSet struct {
	count, control uint32
	entries        [1]windows.LUIDAndAttributes
}

// FILE_ALL_ACCESS from SDK winnt.h; x/sys does not export it.
const candidateFileAllAccess uint32 = windows.STANDARD_RIGHTS_REQUIRED | windows.SYNCHRONIZE | 0x1ff

var candidateFileMapping = candidateAccessMapping{windows.FILE_GENERIC_READ, windows.FILE_GENERIC_WRITE, windows.FILE_GENERIC_EXECUTE, candidateFileAllAccess}

func candidateAccessABI() bool {
	return unsafe.Sizeof(uint32(0)) == 4 && unsafe.Sizeof(int32(0)) == 4 &&
		unsafe.Sizeof(candidateAccessMapping{}) == 16 && unsafe.Sizeof(candidateAccessPrivilegeSet{}) == 20 &&
		unsafe.Offsetof(candidateAccessPrivilegeSet{}.entries) == 8 && unsafe.Sizeof(windows.LUIDAndAttributes{}) == 12
}

type candidateAccessAPI struct {
	open      func(windows.Handle, uint32, *windows.Token) error
	duplicate func(windows.Token, uint32, uint32, uint32, *windows.Token) error
	close     func(windows.Token) error
	query     windowsTokenInformation
	buildSD   func([]byte, []byte, []byte) (candidateAccessSD, error)
	validSD   func(*byte) bool
	access    func(*byte, windows.Token, uint32, *candidateAccessMapping, *byte, *uint32, *uint32, *int32) error
}

func candidateAccessNativeAPI() (candidateAccessAPI, error) {
	dll := windows.NewLazySystemDLL("advapi32.dll")
	duplicate, access, valid := dll.NewProc("DuplicateTokenEx"), dll.NewProc("AccessCheck"), dll.NewProc("IsValidSecurityDescriptor")
	initACL, addACE, relative := dll.NewProc("InitializeAcl"), dll.NewProc("AddAccessAllowedAce"), dll.NewProc("MakeSelfRelativeSD")
	for _, p := range []*windows.LazyProc{duplicate, access, valid, initACL, addACE, relative} {
		if err := p.Find(); err != nil {
			return candidateAccessAPI{}, err
		}
	}
	return candidateAccessAPI{
		open: windows.OpenProcessToken, close: func(t windows.Token) error { return t.Close() }, query: windows.GetTokenInformation,
		duplicate: func(in windows.Token, rights, level, kind uint32, out *windows.Token) error {
			// NULL attributes: non-inheritable, no SACL and no extra token rights.
			r, _, e := duplicate.Call(uintptr(in), uintptr(rights), 0, uintptr(level), uintptr(kind), uintptr(unsafe.Pointer(out)))
			runtime.KeepAlive(out)
			return candidateAccessBOOL(r, e)
		},
		buildSD: func(user, group, packageSID []byte) (candidateAccessSD, error) {
			// Use documented construction APIs in the native path, not raw ACL writes.
			// Every descriptor owns independent DWORD-aligned identity and ACL storage.
			if !candidateAccessSID(user) || !candidateAccessSID(group) || (packageSID != nil && !candidateAccessSID(packageSID)) {
				return candidateAccessSD{}, errors.New("diagnostic builder SID refused")
			}
			owned := func(b []byte) []uint32 {
				w := make([]uint32, len(b)/4)
				copy(unsafe.Slice((*byte)(unsafe.Pointer(&w[0])), len(b)), b)
				return w
			}
			u, g := owned(user), owned(group)
			var p []uint32
			aclSize := 8 + 8 + len(user)
			if packageSID != nil {
				p = owned(packageSID)
				aclSize += 8 + len(packageSID)
			}
			acl := make([]uint32, aclSize/4)
			defer func() { runtime.KeepAlive(u); runtime.KeepAlive(g); runtime.KeepAlive(p); runtime.KeepAlive(acl) }()
			r, _, e := initACL.Call(uintptr(unsafe.Pointer(&acl[0])), uintptr(aclSize), 2)
			if err := candidateAccessBOOL(r, e); err != nil {
				return candidateAccessSD{}, err
			}
			for _, sid := range [][]uint32{u, p} {
				if sid == nil {
					continue
				}
				r, _, e = addACE.Call(uintptr(unsafe.Pointer(&acl[0])), 2, windows.FILE_READ_DATA, uintptr(unsafe.Pointer(&sid[0])))
				runtime.KeepAlive(sid)
				if err := candidateAccessBOOL(r, e); err != nil {
					return candidateAccessSD{}, err
				}
			}
			absolute, err := windows.NewSecurityDescriptor()
			if err != nil {
				return candidateAccessSD{}, err
			}
			if err = absolute.SetOwner((*windows.SID)(unsafe.Pointer(&u[0])), false); err != nil {
				return candidateAccessSD{}, err
			}
			if err = absolute.SetGroup((*windows.SID)(unsafe.Pointer(&g[0])), false); err != nil {
				return candidateAccessSD{}, err
			}
			if err = absolute.SetDACL((*windows.ACL)(unsafe.Pointer(&acl[0])), true, false); err != nil {
				return candidateAccessSD{}, err
			}
			var needed uint32
			r, _, e = relative.Call(uintptr(unsafe.Pointer(absolute)), 0, uintptr(unsafe.Pointer(&needed)))
			if uint32(r) != 0 || !errors.Is(e, windows.ERROR_INSUFFICIENT_BUFFER) || needed < 20 || needed > 4096 || needed%4 != 0 {
				runtime.KeepAlive(absolute)
				return candidateAccessSD{}, errors.New("diagnostic SD size refused")
			}
			result := candidateAccessSD{words: make([]uint32, needed/4), size: int(needed)}
			used := needed
			r, _, e = relative.Call(uintptr(unsafe.Pointer(absolute)), uintptr(unsafe.Pointer(&result.words[0])), uintptr(unsafe.Pointer(&used)))
			runtime.KeepAlive(absolute)
			runtime.KeepAlive(result)
			if err = candidateAccessBOOL(r, e); err != nil {
				return candidateAccessSD{}, err
			}
			if used != needed || !candidateValidAccessSD(result) {
				return candidateAccessSD{}, errors.New("diagnostic constructed SD refused")
			}
			return result, nil
		},
		validSD: func(sd *byte) bool {
			r, _, _ := valid.Call(uintptr(unsafe.Pointer(sd))) // no GetLastError contract
			runtime.KeepAlive(sd)
			return uint32(r) != 0
		},
		access: func(sd *byte, token windows.Token, desired uint32, mapping *candidateAccessMapping, privileges *byte, length, granted *uint32, status *int32) error {
			r, _, e := access.Call(uintptr(unsafe.Pointer(sd)), uintptr(token), uintptr(desired), uintptr(unsafe.Pointer(mapping)), uintptr(unsafe.Pointer(privileges)), uintptr(unsafe.Pointer(length)), uintptr(unsafe.Pointer(granted)), uintptr(unsafe.Pointer(status)))
			runtime.KeepAlive(sd)
			runtime.KeepAlive(mapping)
			runtime.KeepAlive(privileges)
			runtime.KeepAlive(length)
			runtime.KeepAlive(granted)
			runtime.KeepAlive(status)
			return candidateAccessBOOL(r, e) // API success is NOT access granted
		},
	}, nil
}

func candidateAccessBOOL(result uintptr, last error) error {
	if uint32(result) != 0 {
		return nil
	}
	if last == nil || errors.Is(last, windows.ERROR_SUCCESS) {
		return errors.New("diagnostic API returned FALSE")
	}
	return last
}

// Strict SID byte validation before constructing an independent self-relative SD.
// No SDDL interpolation, identity strings, native SID pointer reconstruction,
// filesystem objects, SACL, mandatory labels, or ACL writes.
func candidateAccessSID(s []byte) bool {
	return len(s) >= 8 && s[0] == 1 && s[1] > 0 && s[1] <= 15 && len(s) == 8+4*int(s[1])
}

type candidateAccessSD struct {
	words []uint32
	size  int
}

func (s candidateAccessSD) data() []byte {
	if s.size < 20 || s.size > 4096 || len(s.words)*4 < s.size {
		return nil
	}
	return unsafe.Slice((*byte)(unsafe.Pointer(&s.words[0])), s.size)
}

// Software builder is used ONLY by injected protocol tests, not native diagnostics.
func candidateBuildAccessSD(user, group, packageSID []byte) (candidateAccessSD, error) {
	if !candidateAccessSID(user) || !candidateAccessSID(group) || (packageSID != nil && !candidateAccessSID(packageSID)) {
		return candidateAccessSD{}, errors.New("diagnostic SID extent refused")
	}
	n := 20 + len(user) + len(group) + 8 + 8 + len(user)
	count := uint16(1)
	if packageSID != nil {
		n += 8 + len(packageSID)
		count++
	}
	s := candidateAccessSD{words: make([]uint32, n/4), size: n}
	b := s.data()
	b[0] = 1
	binary.LittleEndian.PutUint16(b[2:], 0x8004) // SELF_RELATIVE | DACL_PRESENT, no SACL
	binary.LittleEndian.PutUint32(b[4:], 20)
	g := 20 + len(user)
	binary.LittleEndian.PutUint32(b[8:], uint32(g))
	d := g + len(group)
	binary.LittleEndian.PutUint32(b[16:], uint32(d))
	copy(b[20:], user)
	copy(b[g:], group)
	b[d] = 2 // ACL_REVISION
	binary.LittleEndian.PutUint16(b[d+2:], uint16(n-d))
	binary.LittleEndian.PutUint16(b[d+4:], count)
	off := d + 8
	for _, sid := range [][]byte{user, packageSID} {
		if sid == nil {
			continue
		}
		// ACCESS_ALLOWED_ACE, flags=0, mask=FILE_READ_DATA, SID at offset 8.
		binary.LittleEndian.PutUint16(b[off+2:], uint16(8+len(sid)))
		binary.LittleEndian.PutUint32(b[off+4:], windows.FILE_READ_DATA)
		copy(b[off+8:], sid)
		off += 8 + len(sid)
	}
	if !candidateValidAccessSD(s) {
		return candidateAccessSD{}, errors.New("diagnostic SD construction refused")
	}
	return s, nil
}

// Validate every extent/content BEFORE letting a native routine walk the SD.
// Narrow grammar deliberately rejects NULL DACL, SACL, generic masks and aliases.
func candidateValidAccessSD(s candidateAccessSD) bool {
	b := s.data()
	if len(b) < 20 || len(b)%4 != 0 || b[0] != 1 || b[1] != 0 || binary.LittleEndian.Uint16(b[2:]) != 0x8004 || binary.LittleEndian.Uint32(b[12:]) != 0 {
		return false
	}
	nextSID := func(off int) (int, bool) {
		if off < 20 || off%4 != 0 || off > len(b)-8 {
			return 0, false
		}
		n := 8 + 4*int(b[off+1])
		if n > len(b)-off || !candidateAccessSID(b[off:off+n]) {
			return 0, false
		}
		return off + n, true
	}
	u, g, d := int(binary.LittleEndian.Uint32(b[4:])), int(binary.LittleEndian.Uint32(b[8:])), int(binary.LittleEndian.Uint32(b[16:]))
	endUser, ok := nextSID(u)
	if !ok {
		return false
	}
	endGroup, ok := nextSID(g)
	if !ok {
		return false
	}
	if d < 20 || d%4 != 0 || d > len(b)-8 {
		return false
	}
	count := int(binary.LittleEndian.Uint16(b[d+4:]))
	aclSize := int(binary.LittleEndian.Uint16(b[d+2:]))
	if b[d] != 2 || b[d+1] != 0 || aclSize < 8 || aclSize > len(b)-d || count < 1 || count > 2 || binary.LittleEndian.Uint16(b[d+6:]) != 0 {
		return false
	}
	off := d + 8
	for i := 0; i < count; i++ {
		if off > len(b)-16 || b[off] != 0 || b[off+1] != 0 || binary.LittleEndian.Uint32(b[off+4:]) != windows.FILE_READ_DATA {
			return false
		}
		end, ok := nextSID(off + 8)
		if !ok || int(binary.LittleEndian.Uint16(b[off+2:])) != end-off {
			return false
		}
		if i == 0 && !bytes.Equal(b[off+8:end], b[u:endUser]) {
			return false
		}
		off = end
	}
	if off != d+aclSize {
		return false
	}
	// MakeSelfRelativeSD may order its three components differently. Require
	// exact, contiguous, non-overlapping spans, not a particular native order.
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

type candidateAccessDecision struct {
	apiSuccess, valid, allowed bool
	granted                    uint32
	numericCodePresent         bool
	code                       uint64
}
type candidateAccessReport struct {
	complete bool
	checks   [3]candidateAccessDecision
}

// Observation/inference ONLY. Never passed to the production verifier.
func (r candidateAccessReport) matches(lpac bool) bool {
	if !r.complete {
		return false
	}
	for _, c := range r.checks {
		if !c.apiSuccess || !c.valid {
			return false
		}
	}
	return !r.checks[0].allowed && r.checks[1].allowed == !lpac && r.checks[2].allowed
}

func candidateAccessCheck(sd candidateAccessSD, token windows.Token, api candidateAccessAPI) (o candidateAccessDecision, err error) {
	if !candidateAccessABI() || !candidateValidAccessSD(sd) {
		return o, errors.New("diagnostic ABI/SD refused")
	}
	data := sd.data()
	if !api.validSD(&data[0]) {
		return o, errors.New("diagnostic native SD refused")
	}
	size := uint32(20)
	for attempt := 0; attempt < 2; attempt++ {
		// Word-aligned, exact bounded advertised byte extent; never inspect failure output.
		storage := make([]uint32, (size+3)/4)
		raw := unsafe.Slice((*byte)(unsafe.Pointer(&storage[0])), int(size))
		used, granted, status := size, uint32(0), int32(0)
		mapping := candidateFileMapping
		err = api.access(&data[0], token, windows.FILE_READ_DATA, &mapping, &raw[0], &used, &granted, &status)
		runtime.KeepAlive(sd)
		runtime.KeepAlive(storage)
		if err != nil {
			if attempt == 0 && errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) && used > size && used <= 4096 {
				size = used
				continue
			}
			return o, err // API failure is NEVER DENY; no reopen or rights widening
		}
		o.apiSuccess, o.granted = true, granted
		// Count must fit both returned and allocated extents; reject any privilege
		// participation (these concrete read DACL controls must not need privileges).
		if used < 8 || used > size || binary.LittleEndian.Uint32(raw) > (used-8)/12 || binary.LittleEndian.Uint32(raw) != 0 || binary.LittleEndian.Uint32(raw[4:]) & ^uint32(1) != 0 || (status != 0 && status != 1) || granted & ^uint32(windows.FILE_READ_DATA) != 0 || (status == 0 && granted != 0) || (status == 1 && granted != windows.FILE_READ_DATA) {
			return o, errors.New("diagnostic AccessCheck output refused")
		}
		o.valid, o.allowed = true, status == 1
		return o, nil
	}
	return o, errors.New("diagnostic retry exhausted")
}

func candidateAccessDWORD(token windows.Token, class uint32, want uint32, query windowsTokenInformation) error {
	if class != windows.TokenType && class != windows.TokenImpersonationLevel {
		return errors.New("diagnostic DWORD class refused")
	}
	var got, used uint32
	if err := query(token, class, (*byte)(unsafe.Pointer(&got)), 4, &used); err != nil {
		return err
	}
	if used != 4 || got != want {
		return errors.New("diagnostic type/level refused")
	}
	return nil
}
func candidateAccessIdentity(token windows.Token, class uint32, query windowsTokenInformation) ([]byte, error) {
	if class != windows.TokenUser && class != windows.TokenPrimaryGroup {
		return nil, errors.New("diagnostic identity class refused")
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
		return nil, errors.New("diagnostic identity header refused")
	}
	var sid *windows.SID
	if class == windows.TokenUser {
		sid = (*windows.Tokenuser)(unsafe.Pointer(&b.words[0])).User.Sid
	} else {
		sid = (*windows.Tokenprimarygroup)(unsafe.Pointer(&b.words[0])).PrimaryGroup
	}
	span, err := b.boundedSID(sid, header)
	if err != nil {
		return nil, err
	}
	result := bytes.Clone(span)
	runtime.KeepAlive(b)
	if !candidateAccessSID(result) {
		return nil, errors.New("diagnostic identity SID refused")
	}
	return result, nil
}

// Independent non-46 parser, not a relaxed policy or a replacement verifier.
func candidateAccessMetadata(token windows.Token, profile []byte, query windowsTokenInformation) error {
	for _, check := range []struct{ class, want uint32 }{{tokenIsAppContainer, 1}, {windows.TokenElevation, 0}} {
		b, err := queryCandidateDWORD(token, check.class, query)
		if err != nil {
			return err
		}
		got, err := b.dword()
		if err != nil || got != check.want {
			return errors.New("diagnostic AC/elevation refused")
		}
	}
	for _, class := range []uint32{tokenAppContainerSID, tokenCapabilities, windows.TokenIntegrityLevel} {
		b, err := queryCandidateToken(token, class, query)
		if err != nil {
			return err
		}
		if class == tokenCapabilities {
			if b.size < 4 || binary.LittleEndian.Uint32(b.bytes()) != 0 {
				return errors.New("diagnostic capabilities refused")
			}
			continue
		}
		header := unsafe.Sizeof(windowsTokenAppContainerInformation{})
		if class == windows.TokenIntegrityLevel {
			header = unsafe.Sizeof(windows.Tokenmandatorylabel{})
		}
		if uintptr(b.size) < header {
			return errors.New("diagnostic SID metadata header refused")
		}
		var sid *windows.SID
		if class == tokenAppContainerSID {
			sid = (*windowsTokenAppContainerInformation)(unsafe.Pointer(&b.words[0])).sid
		} else {
			label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&b.words[0]))
			if label.Label.Attributes != windows.SE_GROUP_INTEGRITY && label.Label.Attributes != windows.SE_GROUP_INTEGRITY|windows.SE_GROUP_INTEGRITY_ENABLED {
				return errors.New("diagnostic integrity attributes refused")
			}
			sid = label.Label.Sid
		}
		span, err := b.boundedSID(sid, header)
		if err != nil {
			return err
		}
		matches := bytes.Equal(span, profile)
		if class == windows.TokenIntegrityLevel {
			matches = candidateSIDMatches(span, [6]byte{0, 0, 0, 0, 0, 16}, 1, 0x1000)
		}
		runtime.KeepAlive(b)
		if !matches {
			return errors.New("diagnostic exact-profile/Low metadata refused")
		}
	}
	return nil
}

func candidateDiagnoseAccess(process windows.Handle, profile *windows.SID, api candidateAccessAPI) (report candidateAccessReport, err error) {
	if !candidateAccessABI() {
		return report, errors.New("diagnostic ABI refused")
	}
	// Only validate/copy the trusted owned profile. Never create a relaxed launch
	// policy: lpac=false is reserved for the disposable ordinary-AC control.
	p, e := (&windowsAppContainerPolicy{profileSID: profile, lpac: true}).snapshot()
	if e != nil {
		return report, e
	}
	profileBytes := bytes.Clone(unsafe.Slice((*byte)(unsafe.Pointer(p.profileSID)), p.profileSID.Len()))
	runtime.KeepAlive(p)
	source := &candidatePrimaryOwner{close: api.close}
	var duplicate *candidatePrimaryOwner
	defer func() {
		err = errors.Join(err, duplicate.release(), source.release())
		if err != nil {
			report.complete = false
		}
	}()
	err = api.open(process, windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &source.token) // ONCE, no reopen
	if err != nil {
		return report, err
	}
	if !candidateRealToken(source.token) {
		return report, errors.New("diagnostic source refused")
	}
	if err = candidateAccessDWORD(source.token, windows.TokenType, windows.TokenPrimary, api.query); err != nil {
		return report, err
	}
	// Explicitly non-46 metadata only. This does NOT replace the original gate.
	if err = candidateAccessMetadata(source.token, profileBytes, api.query); err != nil {
		return report, err
	}
	user, err := candidateAccessIdentity(source.token, windows.TokenUser, api.query)
	if err != nil {
		return report, err
	}
	group, err := candidateAccessIdentity(source.token, windows.TokenPrimaryGroup, api.query)
	if err != nil {
		return report, err
	}
	var out windows.Token
	dupErr := api.duplicate(source.token, windows.TOKEN_QUERY, windows.SecurityImpersonation, windows.TokenImpersonation, &out)
	if out == source.token {
		return report, errors.New("diagnostic duplicate aliases source")
	}
	duplicate = &candidatePrimaryOwner{token: out, close: api.close}
	if dupErr != nil {
		return report, dupErr
	}
	if !candidateRealToken(out) {
		return report, errors.New("diagnostic duplicate refused")
	}
	if err = candidateAccessDWORD(out, windows.TokenType, windows.TokenImpersonation, api.query); err != nil {
		return report, err
	}
	if err = candidateAccessDWORD(out, windows.TokenImpersonationLevel, windows.SecurityImpersonation, api.query); err != nil {
		return report, err
	}
	if err = candidateAccessMetadata(out, profileBytes, api.query); err != nil {
		return report, err
	}
	for _, field := range []struct {
		class uint32
		want  []byte
	}{{windows.TokenUser, user}, {windows.TokenPrimaryGroup, group}} {
		got, e := candidateAccessIdentity(out, field.class, api.query)
		if e != nil || !bytes.Equal(got, field.want) {
			return report, errors.Join(errors.New("diagnostic duplicate identity refused"), e)
		}
	}
	var descriptors [3]candidateAccessSD
	for i, sid := range [][]byte{nil, candidateSIDBytes(15, 2, 2), profileBytes} {
		// candidateSIDBytes initializes remaining subauthorities to zero: broad AAP
		// needs S-1-15-2-1, not S-1-15-2-0.
		if i == 1 {
			binary.LittleEndian.PutUint32(sid[12:], 1)
		}
		descriptors[i], err = api.buildSD(user, group, sid)
		if err != nil {
			return report, err
		}
	}
	for i, sd := range descriptors {
		report.checks[i], err = candidateAccessCheck(sd, out, api)
		if err != nil {
			var errno syscall.Errno
			report.checks[i].numericCodePresent = errors.As(err, &errno)
			report.checks[i].code = uint64(errno)
			return report, err
		}
	}
	report.complete = true
	return report, nil
}

// Native cleanup reporting must not stringify an opaque diagnostic API error.
// Keep the original for errors.Is/As while exposing only numeric classification.
type candidateAccessBoundedError struct{ cause error }

func (e candidateAccessBoundedError) Error() string {
	var code syscall.Errno
	present := errors.As(e.cause, &code)
	return fmt.Sprintf("diagnostic error=true numericCodePresent=%v code=%d", present, uint64(code))
}
func (e candidateAccessBoundedError) Unwrap() error { return e.cause }
func candidateBoundAccessError(err error) error {
	if err == nil {
		return nil
	}
	return candidateAccessBoundedError{cause: err}
}

// Wrap real exact-job verification without changing EITHER returned value.
// Diagnostic/witness errors are sticky and asserted only AFTER launch cleanup.
func candidateAccessVerify(exact func(windows.Handle, windows.Handle) (bool, error), witness func(windows.Handle) error, diagnose func(windows.Handle) error, sticky *error) func(windows.Handle, windows.Handle) (bool, error) {
	ran := false
	return func(process, job windows.Handle) (bool, error) {
		member, err := exact(process, job)
		if err == nil && member {
			if ran {
				*sticky = errors.Join(*sticky, errors.New("diagnostic verify repeated"))
			} else {
				ran = true
				if e := witness(process); e != nil {
					*sticky = errors.Join(*sticky, candidateBoundAccessError(e))
				} else {
					*sticky = errors.Join(*sticky, candidateBoundAccessError(diagnose(process)))
				}
			}
		}
		return member, err
	}
}
