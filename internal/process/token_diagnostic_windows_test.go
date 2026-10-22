//go:build windows

package process

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Token-only experiment: no process creation, impersonation, profile APIs,
// directories, ACLs, registry writes, privilege adjustment or policy changes.
// All helpers and the expanded DWORD allowlist are test-only.
const (
	diagSaferScopeUser  = 2
	diagSaferNormalUser = 0x20000
	diagSaferLevelOpen  = 1
)

type diagAPI struct {
	query        windowsTokenInformation
	open         func(windows.Handle, uint32, *windows.Token) error
	createLevel  func(uint32, uint32, uint32, *windows.Handle) error
	compute      func(windows.Handle, windows.Token, *windows.Token, uint32) error
	closeToken   func(windows.Handle) error
	closeLevel   func(windows.Handle) error
	privilegeIDs func() (map[windows.LUID]string, error)
}

// Only public, fixed privilege names; never discover names/accounts from tokens.
// These are explicitly administrative/sensitive. Standard-user traverse,
// working-set and time-zone privileges are separately allowed below.
var diagAdminPrivileges = []string{
	"SeCreateTokenPrivilege", "SeAssignPrimaryTokenPrivilege", "SeLockMemoryPrivilege",
	"SeIncreaseQuotaPrivilege", "SeMachineAccountPrivilege", "SeTcbPrivilege",
	"SeSecurityPrivilege", "SeTakeOwnershipPrivilege", "SeLoadDriverPrivilege",
	"SeSystemProfilePrivilege", "SeSystemtimePrivilege", "SeProfileSingleProcessPrivilege",
	"SeIncreaseBasePriorityPrivilege", "SeCreatePagefilePrivilege", "SeCreatePermanentPrivilege",
	"SeBackupPrivilege", "SeRestorePrivilege", "SeShutdownPrivilege", "SeDebugPrivilege",
	"SeAuditPrivilege", "SeSystemEnvironmentPrivilege", "SeRemoteShutdownPrivilege",
	"SeUndockPrivilege", "SeManageVolumePrivilege", "SeImpersonatePrivilege",
	"SeCreateGlobalPrivilege", "SeRelabelPrivilege", "SeTrustedCredManAccessPrivilege",
	"SeDelegateSessionUserImpersonatePrivilege", "SeEnableDelegationPrivilege",
	"SeSyncAgentPrivilege", "SeCreateSymbolicLinkPrivilege",
}
var diagOrdinaryPrivileges = []string{
	"SeChangeNotifyPrivilege", "SeIncreaseWorkingSetPrivilege", "SeTimeZonePrivilege",
}

// Never log syscall error text, DLL paths, tokens/addresses or native buffers.
// Diagnostic errors contain only fixed stage names, numeric codes and lengths.
type diagFailure struct {
	stage   string
	code    uint32
	hasCode bool
}

func (e *diagFailure) Error() string {
	if e.hasCode {
		return fmt.Sprintf("%s: win32-code=%d", e.stage, e.code)
	}
	return e.stage + ": API-failure"
}
func diagError(stage string, err error) error {
	// Preserve only our already-sanitized numeric result when layering APIs.
	var safe *diagFailure
	if errors.As(err, &safe) {
		return &diagFailure{stage, safe.code, safe.hasCode}
	}
	var code syscall.Errno
	if errors.As(err, &code) {
		return &diagFailure{stage, uint32(code), true}
	}
	return &diagFailure{stage: stage}
}

func diagBOOL(stage string, r uintptr, last error) error {
	if uint32(r) != 0 { // BOOL, not HRESULT; stale GetLastError is irrelevant
		return nil
	}
	return diagError(stage, last)
}

func diagNativeAPI(t *testing.T) diagAPI {
	t.Helper()
	// Recheck at the native API boundary, not just at the test/workflow entry.
	diagRequireCI(t)
	dll := windows.NewLazySystemDLL("advapi32.dll")
	create := dll.NewProc("SaferCreateLevel")
	compute := dll.NewProc("SaferComputeTokenFromLevel")
	closeLevel := dll.NewProc("SaferCloseLevel")
	for _, p := range []*windows.LazyProc{create, compute, closeLevel} {
		if err := p.Find(); err != nil {
			t.Fatal(diagError("resolve-SAFER", err))
		}
	}
	return diagAPI{
		query:      windows.GetTokenInformation,
		open:       windows.OpenProcessToken,
		closeToken: windows.CloseHandle,
		// winsafer.h: BOOL(DWORD,DWORD,DWORD,SAFER_LEVEL_HANDLE*,LPVOID).
		createLevel: func(scope, level, flags uint32, out *windows.Handle) error {
			r, _, e := create.Call(uintptr(scope), uintptr(level), uintptr(flags), uintptr(unsafe.Pointer(out)), 0)
			runtime.KeepAlive(out)
			return diagBOOL("SaferCreateLevel", r, e)
		},
		// BOOL(SAFER_LEVEL_HANDLE,HANDLE,PHANDLE,DWORD,LPVOID).
		// Explicit process-primary input; never NULL/thread-token fallback.
		compute: func(level windows.Handle, in windows.Token, out *windows.Token, flags uint32) error {
			r, _, e := compute.Call(uintptr(level), uintptr(in), uintptr(unsafe.Pointer(out)), uintptr(flags), 0)
			runtime.KeepAlive(out)
			return diagBOOL("SaferComputeTokenFromLevel", r, e)
		},
		// BOOL(SAFER_LEVEL_HANDLE): NOT CloseHandle.
		closeLevel: func(level windows.Handle) error {
			r, _, e := closeLevel.Call(uintptr(level))
			return diagBOOL("SaferCloseLevel", r, e)
		},
		privilegeIDs: func() (map[windows.LUID]string, error) {
			ids := make(map[windows.LUID]string)
			for _, names := range [][]string{diagAdminPrivileges, diagOrdinaryPrivileges} {
				for _, name := range names {
					wide, err := windows.UTF16PtrFromString(name)
					if err != nil {
						return nil, diagError("privilege-name", err)
					}
					var id windows.LUID
					if err := windows.LookupPrivilegeValue(nil, wide, &id); err != nil {
						return nil, diagError("LookupPrivilegeValue", err)
					}
					ids[id] = name
				}
			}
			return ids, nil
		},
	}
}

func diagCIPrerequisite(opt, actions, environment, runnerOS string) (skip bool, err error) {
	if opt == "" && actions == "" && environment == "" && runnerOS == "" {
		return true, nil // ordinary non-opted-in developer unit run only
	}
	if opt != "1" {
		return false, errors.New("token diagnostic requires explicit PI_LOCAL_CI_TOKEN_DIAGNOSTIC=1")
	}
	if actions != "true" || environment != "github-hosted" || runnerOS != "Windows" {
		return false, errors.New("token diagnostic requires GitHub-hosted Windows CI")
	}
	return false, nil
}

func diagRequireCI(t *testing.T) {
	t.Helper()
	skip, err := diagCIPrerequisite(os.Getenv("PI_LOCAL_CI_TOKEN_DIAGNOSTIC"), os.Getenv("GITHUB_ACTIONS"), os.Getenv("RUNNER_ENVIRONMENT"), os.Getenv("RUNNER_OS"))
	if err != nil {
		t.Fatal(err)
	}
	if skip {
		t.Skip("native token diagnostic is opt-in on ephemeral Windows CI only")
	}
}

// A handle enters this owner only from a native out parameter initialized to 0.
// Reserved pseudo/invalid values are never treated as owned or closed.
type diagOwned struct {
	h         windows.Handle
	close     func(windows.Handle) error
	attempted bool
	err       error
}

func diagRealHandle(h windows.Handle) bool { return h != 0 && uintptr(h) < ^uintptr(0)-15 }
func (o *diagOwned) release() error {
	if o.attempted {
		return o.err
	}
	o.attempted = true
	if diagRealHandle(o.h) {
		if err := o.close(o.h); err != nil {
			o.err = diagError("close-owned-handle", err)
		}
	}
	return o.err // sticky; no retry that could close a recycled handle
}

func diagDWORD(token windows.Token, class uint32, query windowsTokenInformation) (uint32, error) {
	switch class {
	case windows.TokenElevation, windows.TokenElevationType, windows.TokenType, windows.TokenSessionId:
	default:
		return 0, errors.New("diagnostic DWORD class refused")
	}
	var value, used uint32
	if err := query(token, class, (*byte)(unsafe.Pointer(&value)), 4, &used); err != nil {
		return 0, diagError(fmt.Sprintf("DWORD-class-%d", class), err)
	}
	if used != 4 {
		return 0, fmt.Errorf("DWORD-class-%d: returned-length=%d expected=4", class, used)
	}
	return value, nil
}

func diagVariable(token windows.Token, class uint32, query windowsTokenInformation) (windowsTokenBuffer, error) {
	var needed uint32
	if err := query(token, class, nil, 0, &needed); !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
		return windowsTokenBuffer{}, diagError(fmt.Sprintf("probe-class-%d", class), err)
	}
	if needed == 0 || needed > maxCandidateTokenBytes {
		return windowsTokenBuffer{}, fmt.Errorf("probe-class-%d: rejected-length=%d", class, needed)
	}
	word := uint32(unsafe.Sizeof(uintptr(0)))
	b := windowsTokenBuffer{words: make([]uintptr, (needed+word-1)/word), size: needed}
	var used uint32
	if err := query(token, class, &b.bytes()[0], needed, &used); err != nil {
		return windowsTokenBuffer{}, diagError(fmt.Sprintf("fetch-class-%d", class), err)
	}
	// A changed record is refused, not retried or accepted with unqueried tail.
	if used != needed {
		return windowsTokenBuffer{}, fmt.Errorf("fetch-class-%d: returned-length=%d expected=%d", class, used, needed)
	}
	return b, nil
}

func diagSID(b windowsTokenBuffer, sid *windows.SID, header uintptr) (*windows.SID, []byte, error) {
	span, err := b.boundedSID(sid, header) // bounds/alignment/revision/count BEFORE IsValid
	if err != nil {
		return nil, nil, errors.New("embedded-SID bounds/layout rejected")
	}
	bounded := (*windows.SID)(unsafe.Pointer(&span[0]))
	if bounded.Len() != len(span) {
		return nil, nil, errors.New("embedded-SID length rejected")
	}
	return bounded, span, nil // no native interior-pointer-return API
}

type diagGroup struct {
	present bool
	attrs   uint32
}
type diagPrivilege struct {
	name  string
	attrs uint32
}
type diagSnapshot struct {
	elevationType, elevation, tokenType, session, il uint32
	user                                             *windows.SID // Go-owned copy; NEVER formatted, hashed or converted to text
	groups                                           [2]diagGroup
	privileges                                       []diagPrivilege
	enabledAdmin, unknownEnabled                     bool
	complete                                         bool
}

func diagInspect(token windows.Token, api diagAPI, ids map[windows.LUID]string) (s diagSnapshot, err error) {
	for _, field := range []struct {
		class uint32
		out   *uint32
	}{
		{windows.TokenElevationType, &s.elevationType}, {windows.TokenElevation, &s.elevation},
		{windows.TokenType, &s.tokenType}, {windows.TokenSessionId, &s.session},
	} {
		*field.out, err = diagDWORD(token, field.class, api.query)
		if err != nil {
			return s, err
		}
	}
	b, err := diagVariable(token, windows.TokenIntegrityLevel, api.query)
	if err != nil {
		return s, err
	}
	header := unsafe.Sizeof(windows.Tokenmandatorylabel{})
	if uintptr(b.size) < header {
		return s, errors.New("integrity header truncated")
	}
	label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&b.words[0]))
	_, span, err := diagSID(b, label.Label.Sid, header)
	if err != nil {
		return s, err
	}
	if label.Label.Attributes&windows.SE_GROUP_INTEGRITY == 0 || len(span) != 12 || span[1] != 1 || [6]byte(span[2:8]) != [6]byte{0, 0, 0, 0, 0, 16} {
		return s, errors.New("integrity SID/attributes rejected")
	}
	s.il = binary.LittleEndian.Uint32(span[8:12])
	runtime.KeepAlive(b)
	b, err = diagVariable(token, windows.TokenUser, api.query)
	if err != nil {
		return s, err
	}
	header = unsafe.Sizeof(windows.Tokenuser{})
	if uintptr(b.size) < header {
		return s, errors.New("user header truncated")
	}
	user := (*windows.Tokenuser)(unsafe.Pointer(&b.words[0]))
	sid, _, err := diagSID(b, user.User.Sid, header)
	if err != nil {
		return s, err
	}
	s.user, err = sid.Copy() // independent bounded Go allocation, no FreeSid
	runtime.KeepAlive(b)
	if err != nil {
		return s, diagError("copy-user-SID", err)
	}

	b, err = diagVariable(token, windows.TokenGroups, api.query)
	if err != nil {
		return s, err
	}
	header = unsafe.Offsetof(windows.Tokengroups{}.Groups)
	entry := unsafe.Sizeof(windows.SIDAndAttributes{})
	if uintptr(b.size) < header {
		return s, errors.New("groups header truncated")
	}
	count := uintptr(binary.LittleEndian.Uint32(b.bytes()[:4]))
	if count > (uintptr(b.size)-header)/entry {
		return s, errors.New("groups array extent rejected")
	}
	end := header + count*entry
	// The entire array is checked before any element or embedded SID is read.
	admin, err := windows.StringToSid("S-1-5-32-544")
	if err != nil {
		return s, diagError("builtin-admin-SID", err)
	}
	power, err := windows.StringToSid("S-1-5-32-547")
	if err != nil {
		return s, diagError("builtin-power-user-SID", err)
	}
	for i := uintptr(0); i < count; i++ {
		g := (*windows.SIDAndAttributes)(unsafe.Pointer(&b.bytes()[header+i*entry]))
		if g.Attributes & ^uint32(windows.SE_GROUP_VALID_ATTRIBUTES) != 0 {
			return s, errors.New("group attributes rejected")
		}
		sid, _, err := diagSID(b, g.Sid, end)
		if err != nil {
			return s, err
		}
		for j, wellKnown := range []*windows.SID{admin, power} {
			if sid.Equals(wellKnown) {
				if s.groups[j].present {
					return s, errors.New("duplicate administrative SID rejected")
				}
				s.groups[j] = diagGroup{true, g.Attributes}
			}
		}
	}
	runtime.KeepAlive(b)
	b, err = diagVariable(token, windows.TokenPrivileges, api.query)
	if err != nil {
		return s, err
	}
	header = unsafe.Offsetof(windows.Tokenprivileges{}.Privileges)
	entry = unsafe.Sizeof(windows.LUIDAndAttributes{})
	if uintptr(b.size) < header {
		return s, errors.New("privileges header truncated")
	}
	count = uintptr(binary.LittleEndian.Uint32(b.bytes()[:4]))
	if count > (uintptr(b.size)-header)/entry || header+count*entry != uintptr(b.size) {
		return s, errors.New("privileges array extent rejected")
	}
	seen := make(map[windows.LUID]bool)
	for i := uintptr(0); i < count; i++ {
		p := (*windows.LUIDAndAttributes)(unsafe.Pointer(&b.bytes()[header+i*entry]))
		if seen[p.Luid] || p.Attributes & ^uint32(windows.SE_PRIVILEGE_VALID_ATTRIBUTES) != 0 {
			return s, errors.New("privilege duplicate/attributes rejected")
		}
		seen[p.Luid] = true
		name := ids[p.Luid]
		ordinary := false
		for _, allowed := range diagOrdinaryPrivileges {
			ordinary = ordinary || name == allowed
		}
		if !ordinary && name != "" {
			s.privileges = append(s.privileges, diagPrivilege{name, p.Attributes})
		}
		if p.Attributes&windows.SE_PRIVILEGE_ENABLED != 0 && !ordinary {
			if name == "" {
				s.unknownEnabled = true
			} else {
				s.enabledAdmin = true
			}
		}
	}
	runtime.KeepAlive(b)
	s.complete = true
	return s, nil
}

func diagQualify(s, current diagSnapshot, linked bool) []string {
	var why []string
	if !s.complete || !current.complete {
		why = append(why, "incomplete-inspection")
	}
	if s.tokenType != 1 {
		why = append(why, "not-primary")
	}
	if s.elevation != 0 {
		why = append(why, "elevation-not-exact-zero")
	}
	if s.elevationType < 1 || s.elevationType > 3 {
		why = append(why, "invalid-elevation-type")
	}
	if s.elevationType == 2 {
		why = append(why, "Full-elevation-type-refused")
	}
	if linked && s.elevationType != 3 {
		why = append(why, "linked-not-limited")
	}
	if s.il != 0x2000 {
		why = append(why, "not-exact-medium-IL")
	}
	if s.user == nil || current.user == nil || !s.user.Equals(current.user) {
		why = append(why, "user-mismatch")
	}
	if s.session != current.session {
		why = append(why, "session-mismatch")
	}
	for _, g := range s.groups {
		if g.present && (g.attrs&windows.SE_GROUP_USE_FOR_DENY_ONLY == 0 || g.attrs&windows.SE_GROUP_ENABLED != 0) {
			why = append(why, "administrative-SID-not-deny-only")
		}
	}
	if s.enabledAdmin {
		why = append(why, "enabled-administrative-privilege")
	}
	if s.unknownEnabled {
		why = append(why, "unclassified-enabled-privilege")
	}
	return why
}

func diagReport(label string, s, current diagSnapshot, reasons []string) string {
	// Deliberately NOT fmt %+v of a snapshot: it contains a SID and session ID.
	groups := ""
	for i, g := range s.groups {
		groups += fmt.Sprintf(" adminGroup%d={present:%v enabled:%v denyOnly:%v attrs:0x%x}", i, g.present, g.attrs&windows.SE_GROUP_ENABLED != 0, g.attrs&windows.SE_GROUP_USE_FOR_DENY_ONLY != 0, g.attrs)
	}
	privileges := ""
	for _, p := range s.privileges {
		privileges += fmt.Sprintf(" %s=0x%x", p.name, p.attrs)
	}
	return fmt.Sprintf("%s complete=%v TokenElevationType=%d TokenElevation=%d TokenType=%d ILRID=0x%x userMatches=%v sessionMatches=%v%s administrativePrivileges=[%s] unknownEnabledPrivilege=%v eligible=%v reasons=%s",
		label, s.complete, s.elevationType, s.elevation, s.tokenType, s.il,
		s.user != nil && current.user != nil && s.user.Equals(current.user), s.complete && current.complete && s.session == current.session,
		groups, privileges, s.unknownEnabled, len(reasons) == 0, strings.Join(reasons, ","))
}

func diagLinked(in windows.Token, api diagAPI) (owner *diagOwned, err error) {
	// TOKEN_LINKED_TOKEN is exactly one OWNED HANDLE, not a token-info pointer.
	var out windows.Token
	var used uint32
	queryErr := api.query(in, windows.TokenLinkedToken, (*byte)(unsafe.Pointer(&out)), uint32(unsafe.Sizeof(out)), &used)
	owner = &diagOwned{h: windows.Handle(out), close: api.closeToken}
	if queryErr != nil {
		return owner, diagError("linked-token-query", queryErr)
	}
	if used != uint32(unsafe.Sizeof(out)) {
		return owner, fmt.Errorf("linked-token: returned-length=%d expected=%d", used, unsafe.Sizeof(out))
	}
	if !diagRealHandle(owner.h) {
		return owner, errors.New("linked-token: null/reserved handle")
	}
	return owner, nil
}

func diagSafer(in windows.Token, api diagAPI) (owner *diagOwned, err error) {
	var level windows.Handle
	createErr := api.createLevel(diagSaferScopeUser, diagSaferNormalUser, diagSaferLevelOpen, &level)
	levelOwner := &diagOwned{h: level, close: api.closeLevel}
	defer func() { err = errors.Join(err, levelOwner.release()) }()
	if createErr != nil {
		return nil, diagError("create-NORMALUSER-level", createErr)
	}
	if !diagRealHandle(level) {
		return nil, errors.New("NORMALUSER: null/reserved level")
	}
	if !diagRealHandle(windows.Handle(in)) {
		return nil, errors.New("NORMALUSER: explicit owned input required")
	}
	var out windows.Token
	computeErr := api.compute(level, in, &out, 0) // no NULL_IF_EQUAL, MAKE_INERT or COMPARE_ONLY
	owner = &diagOwned{h: windows.Handle(out), close: api.closeToken}
	if computeErr != nil {
		return owner, diagError("compute-NORMALUSER-token", computeErr)
	}
	if !diagRealHandle(owner.h) {
		return owner, errors.New("NORMALUSER: null/reserved output with flags=0 is failure")
	}
	return owner, nil
}

func diagRun(api diagAPI, log func(string)) (err error) {
	query := api.query
	api.query = func(token windows.Token, class uint32, out *byte, size uint32, used *uint32) error {
		err := query(token, class, out, size, used)
		phase := "fetch"
		if out == nil {
			phase = "probe"
		}
		result := "success"
		if err != nil {
			result = diagError("result", err).Error()
		}
		// Neither token/PSID pointers nor buffer content/session identity appear.
		log(fmt.Sprintf("token-query class=%d phase=%s inputBytes=%d returnedBytes=%d %s", class, phase, size, *used, result))
		return err
	}
	var opened windows.Token
	openErr := api.open(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &opened)
	processOwner := &diagOwned{h: windows.Handle(opened), close: api.closeToken}
	defer func() { err = errors.Join(err, processOwner.release()) }()
	if openErr != nil {
		return diagError("OpenProcessToken", openErr)
	}
	if !diagRealHandle(processOwner.h) {
		return errors.New("OpenProcessToken: null/reserved output")
	}
	ids, err := api.privilegeIDs()
	if err != nil {
		return err
	}
	current, currentErr := diagInspect(opened, api, ids)
	currentReasons := []string{"current-is-baseline-not-a-candidate"}
	if currentErr != nil {
		currentReasons = append(currentReasons, currentErr.Error())
	}
	log(diagReport("current-process-primary", current, current, currentReasons))
	err = errors.Join(err, currentErr)
	if current.tokenType != 1 {
		err = errors.Join(err, errors.New("current process token is not primary"))
	}
	if current.elevation > 1 || current.elevationType < 1 || current.elevationType > 3 {
		err = errors.Join(err, errors.New("current process elevation metadata is noncanonical"))
	}
	qualifiedLinked, qualifiedSafer := false, false
	// Only Full(2) establishes the documented linked limited-token opportunity.
	if current.elevationType == 2 {
		owner, linkedErr := diagLinked(opened, api)
		defer func() { err = errors.Join(err, owner.release()) }()
		var linked diagSnapshot
		if linkedErr == nil {
			linked, linkedErr = diagInspect(windows.Token(owner.h), api, ids)
		}
		reasons := diagQualify(linked, current, true)
		if linkedErr != nil {
			reasons = append(reasons, linkedErr.Error())
			err = errors.Join(err, linkedErr)
		}
		qualifiedLinked = len(reasons) == 0
		log(diagReport("UAC-linked", linked, current, reasons))
	} else {
		// Default(1) explicitly has no split-token link; Limited(3) is not a Full source.
		log("UAC-linked eligible=false reasons=not-Full-source; Default(1)-has-no-UAC-link; no-linked-query-attempted")
	}
	// Independent derivation from the SAME explicit process primary token,
	// never from the linked candidate and never inferred safe from NORMALUSER.
	owner, saferErr := diagSafer(opened, api)
	if owner != nil {
		defer func() { err = errors.Join(err, owner.release()) }()
	}
	var safer diagSnapshot
	if saferErr == nil {
		safer, saferErr = diagInspect(windows.Token(owner.h), api, ids)
	}
	reasons := diagQualify(safer, current, false)
	if saferErr != nil {
		reasons = append(reasons, saferErr.Error())
		err = errors.Join(err, saferErr)
	}
	qualifiedSafer = len(reasons) == 0
	log(diagReport("SAFER-NORMALUSER", safer, current, reasons))
	if qualifiedLinked {
		log("preferred=verified-UAC-linked; token-only, no-launch-proof")
	} else if qualifiedSafer {
		log("preferred=verified-SAFER-NORMALUSER; token-only, no-launch-proof")
	} else {
		err = errors.Join(err, errors.New("no qualifying primary token; both candidate outcomes reported"))
	}
	return err
}

func TestWindowsTokenDiagnosticNative(t *testing.T) {
	diagRequireCI(t)
	if err := diagRun(diagNativeAPI(t), func(s string) { t.Log(s) }); err != nil {
		t.Fatal(err)
	}
}
