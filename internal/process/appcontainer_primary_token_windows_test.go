//go:build windows

package process

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"runtime"
	"slices"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Test-only metadata candidate, NOT a general standard-user security proof.
// securitybaseapi.h: DISABLE_MAX_PRIVILEGE | LUA_TOKEN, no other flags.
const candidateRestrictionFlags uint32 = 0x1 | 0x4

// CreateRestrictedToken inherits handle rights. Request the entire prerequisite
// up front, including ASSIGN_PRIMARY access (not SeAssignPrimaryTokenPrivilege).
const candidatePrimaryAccess = windows.TOKEN_QUERY | windows.TOKEN_DUPLICATE | windows.TOKEN_ASSIGN_PRIMARY | windows.TOKEN_ADJUST_DEFAULT

type candidatePrimaryAPI struct {
	query    windowsTokenInformation
	open     func(windows.Handle, uint32, *windows.Token) error
	close    func(windows.Token) error
	create   func(windows.Token, *windows.Token) error
	set      func(windows.Token, uint32, *byte, uint32) error
	ordinary func() (map[windows.LUID]bool, error)
}

func candidatePrimaryNativeAPI(t *testing.T) (candidatePrimaryAPI, error) {
	t.Helper()
	candidateRequireEphemeralWindowsCI(t)
	create := windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateRestrictedToken")
	if err := create.Find(); err != nil {
		return candidatePrimaryAPI{}, err
	}
	return candidatePrimaryAPI{
		query: windows.GetTokenInformation, open: windows.OpenProcessToken,
		close: func(token windows.Token) error { return token.Close() },
		create: func(in windows.Token, out *windows.Token) error {
			// BOOL(HANDLE,DWORD,DWORD,PSID_AND_ATTRIBUTES,DWORD,
			// PLUID_AND_ATTRIBUTES,DWORD,PSID_AND_ATTRIBUTES,PHANDLE).
			r, _, e := create.Call(uintptr(in), uintptr(candidateRestrictionFlags), 0, 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(out)))
			runtime.KeepAlive(out)
			return candidatePrimaryBOOL(r, e)
		},
		set: windows.SetTokenInformation,
		ordinary: func() (map[windows.LUID]bool, error) {
			// Narrow explicit exceptions only. These rights concern traverse checking,
			// the caller's working set and timezone; not token assignment, quota,
			// impersonation, backup/restore, debug, relabel or credential authority.
			// https://learn.microsoft.com/windows/win32/secauthz/privilege-constants
			ids := make(map[windows.LUID]bool)
			for _, name := range []string{"SeChangeNotifyPrivilege", "SeIncreaseWorkingSetPrivilege", "SeTimeZonePrivilege"} {
				wide, err := windows.UTF16PtrFromString(name)
				if err != nil {
					return nil, err
				}
				var id windows.LUID
				if err := windows.LookupPrivilegeValue(nil, wide, &id); err != nil {
					return nil, err
				}
				if ids[id] {
					return nil, errors.New("duplicate ordinary privilege ID")
				}
				ids[id] = true
			}
			return ids, nil
		},
	}, nil
}

func candidatePrimaryBOOL(result uintptr, last error) error {
	if uint32(result) != 0 {
		return nil
	} // ignore stale last error on success
	if last == nil || errors.Is(last, windows.ERROR_SUCCESS) {
		return errors.New("CreateRestrictedToken returned FALSE")
	}
	return last
}

func candidateRealToken(token windows.Token) bool {
	return token != 0 && uintptr(token) < ^uintptr(0)-15
}

type candidatePrimaryOwner struct {
	token    windows.Token
	close    func(windows.Token) error
	released bool
	err      error
}

func (o *candidatePrimaryOwner) release() error {
	if o == nil {
		return nil
	}
	if !o.released {
		o.released = true
		if candidateRealToken(o.token) {
			o.err = o.close(o.token)
		}
	}
	return o.err // sticky; never retry a potentially recycled handle
}

type candidatePrimaryGroup struct {
	sid   []byte
	attrs uint32
}
type candidatePrimarySnapshot struct {
	elevationType, elevation, kind, session, il uint32
	userAttributes, integrityAttributes         uint32
	user                                        []byte                      // owned bytes; never log identity, session or raw LUIDs
	groups                                      []candidatePrimaryGroup     // EVERY group, not just admin/power users
	privileges                                  []windows.LUIDAndAttributes // EVERY entry, even disabled/unknown
	complete                                    bool
}

func candidatePrimaryDWORD(token windows.Token, class uint32, query windowsTokenInformation) (uint32, error) {
	switch class {
	case windows.TokenElevationType, windows.TokenElevation, windows.TokenType, windows.TokenSessionId:
	default:
		return 0, errors.New("non-DWORD primary metadata class")
	}
	var value, used uint32
	if err := query(token, class, (*byte)(unsafe.Pointer(&value)), 4, &used); err != nil {
		return 0, fmt.Errorf("primary DWORD class %d: %w", class, err)
	}
	if used != 4 {
		return 0, errors.New("primary DWORD extent refused")
	}
	return value, nil
}

func candidatePrimaryVariable(token windows.Token, class uint32, query windowsTokenInformation) (windowsTokenBuffer, error) {
	switch class {
	case windows.TokenUser, windows.TokenGroups, windows.TokenPrivileges, windows.TokenIntegrityLevel:
	default:
		return windowsTokenBuffer{}, errors.New("non-variable primary metadata class")
	}
	var needed uint32
	if err := query(token, class, nil, 0, &needed); !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
		return windowsTokenBuffer{}, errors.New("primary variable size query refused")
	}
	if needed == 0 || needed > maxCandidateTokenBytes {
		return windowsTokenBuffer{}, errors.New("primary variable size out of bounds")
	}
	word := uint32(unsafe.Sizeof(uintptr(0)))
	b := windowsTokenBuffer{words: make([]uintptr, (needed+word-1)/word), size: needed}
	var used uint32
	if err := query(token, class, &b.bytes()[0], needed, &used); err != nil {
		return windowsTokenBuffer{}, err
	}
	if used != needed {
		return windowsTokenBuffer{}, errors.New("primary variable changed extent refused")
	}
	return b, nil
}

func candidateInspectPrimary(token windows.Token, query windowsTokenInformation) (s candidatePrimarySnapshot, err error) {
	for _, field := range []struct {
		class uint32
		out   *uint32
	}{
		{windows.TokenElevationType, &s.elevationType}, {windows.TokenElevation, &s.elevation},
		{windows.TokenType, &s.kind}, {windows.TokenSessionId, &s.session},
	} {
		*field.out, err = candidatePrimaryDWORD(token, field.class, query)
		if err != nil {
			return s, err
		}
	}
	b, err := candidatePrimaryVariable(token, windows.TokenUser, query)
	if err != nil {
		return s, err
	}
	header := unsafe.Sizeof(windows.Tokenuser{})
	if uintptr(b.size) < header {
		return s, errors.New("primary user header truncated")
	}
	u := (*windows.Tokenuser)(unsafe.Pointer(&b.words[0]))
	span, err := b.boundedSID(u.User.Sid, header)
	if err != nil {
		return s, err
	}
	s.user, s.userAttributes = bytes.Clone(span), u.User.Attributes
	runtime.KeepAlive(b)
	b, err = candidatePrimaryVariable(token, windows.TokenIntegrityLevel, query)
	if err != nil {
		return s, err
	}
	header = unsafe.Sizeof(windows.Tokenmandatorylabel{})
	if uintptr(b.size) < header {
		return s, errors.New("primary integrity header truncated")
	}
	label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&b.words[0]))
	span, err = b.boundedSID(label.Label.Sid, header)
	if err != nil {
		return s, err
	}
	if len(span) != 12 {
		return s, errors.New("primary integrity SID extent refused")
	}
	s.il, s.integrityAttributes = binary.LittleEndian.Uint32(span[8:12]), label.Label.Attributes
	// TokenIntegrityLevel may omit INTEGRITY_ENABLED; accept only these two forms.
	if !candidateSIDMatches(span, [6]byte{0, 0, 0, 0, 0, 16}, 1, s.il) || (s.integrityAttributes != windows.SE_GROUP_INTEGRITY && s.integrityAttributes != windows.SE_GROUP_INTEGRITY|windows.SE_GROUP_INTEGRITY_ENABLED) {
		return s, errors.New("primary integrity SID/attributes refused")
	}
	runtime.KeepAlive(b)
	b, err = candidatePrimaryVariable(token, windows.TokenGroups, query)
	if err != nil {
		return s, err
	}
	header = unsafe.Offsetof(windows.Tokengroups{}.Groups)
	entry := unsafe.Sizeof(windows.SIDAndAttributes{})
	if uintptr(b.size) < header {
		return s, errors.New("primary groups header truncated")
	}
	count := uintptr(binary.LittleEndian.Uint32(b.bytes()[:4]))
	if count > (uintptr(b.size)-header)/entry {
		return s, errors.New("primary groups extent refused")
	}
	end := header + count*entry
	seenGroups := make(map[string]bool)
	for i := uintptr(0); i < count; i++ {
		g := (*windows.SIDAndAttributes)(unsafe.Pointer(&b.bytes()[header+i*entry]))
		if g.Attributes & ^uint32(windows.SE_GROUP_VALID_ATTRIBUTES) != 0 {
			return s, errors.New("primary group attributes refused")
		}
		sid, err := b.boundedSID(g.Sid, end)
		if err != nil {
			return s, err
		}
		if seenGroups[string(sid)] {
			return s, errors.New("primary duplicate group refused")
		}
		seenGroups[string(sid)] = true
		s.groups = append(s.groups, candidatePrimaryGroup{bytes.Clone(sid), g.Attributes})
	}
	runtime.KeepAlive(b)
	b, err = candidatePrimaryVariable(token, windows.TokenPrivileges, query)
	if err != nil {
		return s, err
	}
	header = unsafe.Offsetof(windows.Tokenprivileges{}.Privileges)
	entry = unsafe.Sizeof(windows.LUIDAndAttributes{})
	if uintptr(b.size) < header {
		return s, errors.New("primary privileges header truncated")
	}
	count = uintptr(binary.LittleEndian.Uint32(b.bytes()[:4]))
	if count > (uintptr(b.size)-header)/entry || header+count*entry != uintptr(b.size) {
		return s, errors.New("primary privileges extent refused")
	}
	seen := make(map[windows.LUID]bool)
	for i := uintptr(0); i < count; i++ {
		p := *(*windows.LUIDAndAttributes)(unsafe.Pointer(&b.bytes()[header+i*entry]))
		if seen[p.Luid] || p.Attributes & ^uint32(windows.SE_PRIVILEGE_VALID_ATTRIBUTES) != 0 {
			return s, errors.New("primary privilege duplicate/attributes refused")
		}
		seen[p.Luid] = true
		s.privileges = append(s.privileges, p)
	}
	runtime.KeepAlive(b)
	s.complete = true
	return s, nil
}

func candidatePrimaryIdentity(s, original candidatePrimarySnapshot) bool {
	return s.complete && original.complete && s.kind == windows.TokenPrimary && original.kind == windows.TokenPrimary && len(s.user) != 0 && bytes.Equal(s.user, original.user) && s.session == original.session
}
func candidateQualifyPrimary(s, original candidatePrimarySnapshot, ordinary map[windows.LUID]bool) error {
	if !candidatePrimaryIdentity(s, original) || s.elevation != 0 || (s.elevationType != 1 && s.elevationType != 3) || s.il != 0x2000 {
		return errors.New("strict primary identity/elevation/Medium predicate refused")
	}
	for _, g := range s.groups {
		// Canonical BUILTIN Administrators/Power Users: S-1-5-32-544/547.
		if len(g.sid) == 16 && candidateSIDMatches(g.sid, [6]byte{0, 0, 0, 0, 0, 5}, 2, 32) {
			rid := binary.LittleEndian.Uint32(g.sid[12:16])
			if (rid == 544 || rid == 547) && (g.attrs&windows.SE_GROUP_USE_FOR_DENY_ONLY == 0 || g.attrs&(windows.SE_GROUP_ENABLED|windows.SE_GROUP_ENABLED_BY_DEFAULT) != 0) {
				return errors.New("administrative group not strictly deny-only")
			}
		}
	}
	for _, p := range s.privileges {
		// Presence, NOT merely ENABLED, is decisive. Unknown and sensitive IDs
		// remain refused even with attributes=0 or SE_PRIVILEGE_REMOVED.
		if !ordinary[p.Luid] {
			return errors.New("non-ordinary privilege PRESENT; refused even if disabled")
		}
	}
	return nil
}

func candidateSamePrimary(a, b candidatePrimarySnapshot) bool {
	return a.complete && b.complete && a.elevationType == b.elevationType && a.elevation == b.elevation && a.kind == b.kind && a.session == b.session && a.il == b.il && a.userAttributes == b.userAttributes && a.integrityAttributes == b.integrityAttributes && bytes.Equal(a.user, b.user) && slices.Equal(a.privileges, b.privileges) && slices.EqualFunc(a.groups, b.groups, func(a, b candidatePrimaryGroup) bool { return a.attrs == b.attrs && bytes.Equal(a.sid, b.sid) })
}

func candidateLowerPrimary(in windows.Token, owner *candidatePrimaryOwner, pre, original candidatePrimarySnapshot, api candidatePrimaryAPI) error {
	if owner == nil || owner.released || !candidateRealToken(owner.token) || !candidateRealToken(in) || owner.token == in || !candidatePrimaryIdentity(pre, original) {
		return errors.New("derived-only primary label ownership/identity refused")
	}
	switch pre.il {
	case 0x2000:
		return nil
	case 0x2100, 0x3000, 0x4000, 0x5000: // explicit known higher SDK RIDs only
	default:
		return errors.New("unknown/lower integrity; no label increase")
	}
	header := uint32(unsafe.Sizeof(windows.Tokenmandatorylabel{}))
	size := header + 12
	word := uint32(unsafe.Sizeof(uintptr(0)))
	b := windowsTokenBuffer{words: make([]uintptr, (size+word-1)/word), size: size}
	data := b.bytes()
	copy(data[header:], candidateSIDBytes(16, 1, 0x2000))
	label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&b.words[0]))
	label.Label.Sid, label.Label.Attributes = (*windows.SID)(unsafe.Pointer(&data[header])), windows.SE_GROUP_INTEGRITY
	err := api.set(owner.token, windows.TokenIntegrityLevel, &data[0], size)
	runtime.KeepAlive(b)
	return err
}

type candidatePrimaryFixture struct {
	input, derived *candidatePrimaryOwner
	original       candidatePrimarySnapshot
	ordinary       map[windows.LUID]bool
	api            candidatePrimaryAPI
	closed         bool
	closeErr       error
}

func (f *candidatePrimaryFixture) witness() error {
	if f.original.complete {
		after, err := candidateInspectPrimary(f.input.token, f.api.query)
		if err != nil || !candidateSamePrimary(f.original, after) {
			return errors.Join(errors.New("original captured primary metadata changed or unreadable"), err)
		}
	}
	return nil
}
func (f *candidatePrimaryFixture) close() error {
	// Witness after synchronous launcher cleanup. This is captured-field equality,
	// NOT whole-token equivalence or a claim that APIs never enable privileges
	// transiently (CreateProcessAsUser may enable existing caller privileges).
	if !f.closed {
		f.closed = true
		f.closeErr = errors.Join(f.derived.release(), f.witness(), f.input.release())
	}
	return f.closeErr
}
func candidateAcquirePrimary(api candidatePrimaryAPI) (f *candidatePrimaryFixture, err error) {
	f = &candidatePrimaryFixture{api: api, input: &candidatePrimaryOwner{close: api.close}}
	defer func() {
		if err != nil {
			err = errors.Join(err, f.close())
		}
	}()
	if err = api.open(windows.CurrentProcess(), candidatePrimaryAccess, &f.input.token); err != nil {
		return f, err
	}
	if !candidateRealToken(f.input.token) {
		return f, errors.New("input token null/reserved")
	}
	if f.ordinary, err = api.ordinary(); err != nil {
		return f, err
	}
	if f.original, err = candidateInspectPrimary(f.input.token, api.query); err != nil {
		return f, err
	}
	if f.original.kind != windows.TokenPrimary || f.original.elevation > 1 || f.original.elevationType < 1 || f.original.elevationType > 3 {
		return f, errors.New("noncanonical original primary")
	}
	var out windows.Token
	createErr := api.create(f.input.token, &out)
	if out == f.input.token {
		return f, errors.New("restricted output aliases original")
	}
	f.derived = &candidatePrimaryOwner{token: out, close: api.close}
	if createErr != nil {
		return f, createErr
	}
	if !candidateRealToken(out) {
		return f, errors.New("restricted output null/reserved")
	}
	pre, err := candidateInspectPrimary(out, api.query)
	if err != nil {
		return f, err
	}
	if err = candidateLowerPrimary(f.input.token, f.derived, pre, f.original, api); err != nil {
		return f, err
	}
	post, err := candidateInspectPrimary(out, api.query)
	if err != nil {
		return f, err
	}
	if err = candidateQualifyPrimary(post, f.original, f.ordinary); err != nil {
		return f, err
	}
	if err = f.witness(); err != nil {
		return f, err
	}
	return f, nil
}
