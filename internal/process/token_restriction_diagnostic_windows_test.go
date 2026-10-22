//go:build windows

package process

import (
	"encoding/binary"
	"errors"
	"fmt"
	"runtime"
	"slices"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Third and LAST bounded token-only experiment; no production launch path.
// Current Microsoft Learn + SDK winnt.h document these flags. LUA_TOKEN is NOT
// an assurance that elevation, integrity, groups or privileges will qualify.
const restrictionFlags = uint32(0x1 | 0x4) // DISABLE_MAX_PRIVILEGE | LUA_TOKEN

type restrictionAPI struct {
	inspect diagAPI
	create  func(windows.Token, uint32, uint32, *windows.SIDAndAttributes, uint32, *windows.LUIDAndAttributes, uint32, *windows.SIDAndAttributes, *windows.Token) error
	set     func(windows.Token, uint32, *byte, uint32) error
}

func restrictionNativeAPI(t *testing.T) restrictionAPI {
	t.Helper()
	diagRequireCI(t)
	base := diagNativeAPI(t) // read-only queries/open/close + fixed privilege IDs
	dll := windows.NewLazySystemDLL("advapi32.dll")
	create, set := dll.NewProc("CreateRestrictedToken"), dll.NewProc("SetTokenInformation")
	for _, p := range []*windows.LazyProc{create, set} {
		if err := p.Find(); err != nil {
			t.Fatal(diagError("resolve-restriction-API", err))
		}
	}
	return restrictionAPI{
		inspect: base,
		// securitybaseapi.h: BOOL(HANDLE,DWORD,DWORD,PSID_AND_ATTRIBUTES,
		// DWORD,PLUID_AND_ATTRIBUTES,DWORD,PSID_AND_ATTRIBUTES,PHANDLE).
		create: func(in windows.Token, flags, disableCount uint32, disable *windows.SIDAndAttributes, deleteCount uint32, delete *windows.LUIDAndAttributes, restrictCount uint32, restrict *windows.SIDAndAttributes, out *windows.Token) error {
			r, _, e := create.Call(uintptr(in), uintptr(flags), uintptr(disableCount), uintptr(unsafe.Pointer(disable)), uintptr(deleteCount), uintptr(unsafe.Pointer(delete)), uintptr(restrictCount), uintptr(unsafe.Pointer(restrict)), uintptr(unsafe.Pointer(out)))
			runtime.KeepAlive(disable)
			runtime.KeepAlive(delete)
			runtime.KeepAlive(restrict)
			runtime.KeepAlive(out)
			return diagBOOL("CreateRestrictedToken", r, e) // last error only on FALSE
		},
		// BOOL(HANDLE,TOKEN_INFORMATION_CLASS,LPVOID,DWORD).
		set: func(token windows.Token, class uint32, data *byte, size uint32) error {
			r, _, e := set.Call(uintptr(token), uintptr(class), uintptr(unsafe.Pointer(data)), uintptr(size))
			runtime.KeepAlive(data)
			return diagBOOL("SetTokenInformation", r, e)
		},
	}
}

func restrictionCreate(in windows.Token, api restrictionAPI) (*diagOwned, error) {
	if !diagRealHandle(windows.Handle(in)) {
		return nil, errors.New("restriction requires explicit owned input")
	}
	var out windows.Token
	err := api.create(in, restrictionFlags, 0, nil, 0, nil, 0, nil, &out)
	// An alias is NOT a new owned token, including on partial failure. Never
	// close it here, inspect it as a candidate, or permit any label operation.
	if out == in {
		return nil, errors.New("restriction output aliases input")
	}
	owner := &diagOwned{h: windows.Handle(out), close: api.inspect.closeToken}
	if err != nil {
		return owner, diagError("CreateRestrictedToken", err)
	}
	if !diagRealHandle(owner.h) {
		return owner, errors.New("restriction output null/reserved")
	}
	return owner, nil
}

func restrictionKnownIL(il uint32) bool {
	// Explicit SDK RIDs only; do not interpret arbitrary values as a known IL.
	switch il {
	case 0, 0x1000, 0x2000, 0x200a, 0x2100, 0x3000, 0x4000, 0x5000:
		return true
	}
	return false
}

func restrictionLower(in windows.Token, owner *diagOwned, pre, current diagSnapshot, api restrictionAPI) error {
	if owner == nil || owner.attempted || !diagRealHandle(owner.h) || !diagRealHandle(windows.Handle(in)) || owner.h == windows.Handle(in) {
		return errors.New("label requires distinct live owned derived token")
	}
	if !pre.complete || !current.complete || pre.tokenType != 1 || pre.user == nil || current.user == nil || !pre.user.Equals(current.user) || pre.session != current.session || !restrictionKnownIL(pre.il) {
		return errors.New("prelabel primary/identity/session/known-integrity gate refused")
	}
	if pre.il < 0x2000 {
		return errors.New("label increase refused")
	}
	if pre.il == 0x2000 {
		return nil // exact medium already; still re-inspect, never assume success
	}
	// Only the newly derived object may be lowered. No access widening,
	// DuplicateTokenEx, privilege enabling or fallback if this call is denied.
	// CreateRestrictedToken preserves input handle rights (QUERY|DUPLICATE),
	// so the label attempt may fail for insufficient access; that stays RED.
	header := uint32(unsafe.Sizeof(windows.Tokenmandatorylabel{}))
	size := header + 12 // exact TOKEN_MANDATORY_LABEL + S-1-16-8192 SID
	word := uint32(unsafe.Sizeof(uintptr(0)))
	b := windowsTokenBuffer{words: make([]uintptr, (size+word-1)/word), size: size}
	data := b.bytes()
	copy(data[header:], []byte{1, 1, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0})
	binary.LittleEndian.PutUint32(data[header+8:], 0x2000)
	label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&b.words[0]))
	label.Label.Sid = (*windows.SID)(unsafe.Pointer(&data[header]))
	label.Label.Attributes = windows.SE_GROUP_INTEGRITY
	err := api.set(windows.Token(owner.h), windows.TokenIntegrityLevel, &data[0], size)
	runtime.KeepAlive(b) // includes the embedded Go-owned SID through native return
	if err != nil {
		return diagError("lower-derived-integrity-only", err)
	}
	return nil
}

// Strict equality of ALL fields captured by diagInspect, not a token-ID or
// whole-token equivalence claim. Neither user SIDs nor session IDs are logged.
func restrictionSame(a, b diagSnapshot) bool {
	return a.complete && b.complete && a.elevationType == b.elevationType && a.elevation == b.elevation && a.tokenType == b.tokenType && a.session == b.session && a.il == b.il && a.user != nil && b.user != nil && a.user.Equals(b.user) && a.groups == b.groups && slices.Equal(a.privileges, b.privileges) && a.enabledAdmin == b.enabledAdmin && a.unknownEnabled == b.unknownEnabled
}

func restrictionRun(api restrictionAPI, log func(string)) (err error) {
	query := api.inspect.query
	api.inspect.query = func(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
		e := query(token, class, out, n, used)
		phase, result := "fetch", "success"
		if out == nil {
			phase = "probe"
		}
		if e != nil {
			result = diagError("query", e).Error()
		}
		log(fmt.Sprintf("restriction-query class=%d phase=%s inputBytes=%d returnedBytes=%d %s", class, phase, n, *used, result))
		return e
	}
	var in windows.Token
	openErr := api.inspect.open(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &in)
	input := &diagOwned{h: windows.Handle(in), close: api.inspect.closeToken}
	defer func() { err = errors.Join(err, input.release()) }()
	if openErr != nil {
		return diagError("OpenProcessToken", openErr)
	}
	if !diagRealHandle(input.h) {
		return errors.New("current primary output null/reserved")
	}
	ids, e := api.inspect.privilegeIDs()
	if e != nil {
		return diagError("fixed-privilege-IDs", e)
	}
	current, e := diagInspect(in, api.inspect, ids)
	log(diagReport("restriction-current-before", current, current, []string{"baseline-only"}))
	if e != nil {
		return e
	}
	if current.tokenType != 1 || current.elevation > 1 || current.elevationType < 1 || current.elevationType > 3 {
		return errors.New("noncanonical current primary metadata")
	}
	// Witness runs even on partial Create failure, refused prelabel metadata,
	// Set failure or postlabel failure. Candidate cleanup runs before witness.
	defer func() {
		after, witnessErr := diagInspect(in, api.inspect, ids)
		log(diagReport("restriction-current-after", after, current, []string{"baseline-only"}))
		same := witnessErr == nil && restrictionSame(current, after)
		log(fmt.Sprintf("current-inspected-metadata-unchanged=%v", same))
		if !same {
			err = errors.Join(err, errors.New("current metadata witness failed"), witnessErr)
		}
	}()
	owner, e := restrictionCreate(in, api)
	if owner != nil {
		defer func() { err = errors.Join(err, owner.release()) }()
	}
	if e != nil {
		return e
	}
	pre, e := diagInspect(windows.Token(owner.h), api.inspect, ids)
	log(diagReport("restriction-derived-PRELABEL", pre, current, diagQualify(pre, current, false)))
	if e != nil {
		return e
	}
	labelErr := restrictionLower(in, owner, pre, current, api)
	if labelErr != nil {
		log(labelErr.Error())
	} else {
		log("derived-label-stage-complete; actual-postlabel-query-required")
	}
	// Re-query full metadata even after Set failure; neither flags nor successful
	// Set imply elevation=0. All stage errors remain sticky regardless of post.
	post, postErr := diagInspect(windows.Token(owner.h), api.inspect, ids)
	reasons := diagQualify(post, current, false)
	log(diagReport("restriction-derived-POSTLABEL", post, current, reasons))
	if len(reasons) != 0 {
		err = errors.New("no qualifying derived token metadata")
	}
	log("METADATA-ONLY; disabled-administrative-privileges-may-be-enableable; no-launch-authorization-or-standard-user-security-or-confinement-proof")
	return errors.Join(err, labelErr, postErr)
}

func TestWindowsTokenRestrictionDiagnosticNative(t *testing.T) {
	diagRequireCI(t) // ordinary non-opted-in Windows dev run ONLY may skip
	if err := restrictionRun(restrictionNativeAPI(t), func(s string) { t.Log(s) }); err != nil {
		t.Fatal(err) // explicit CI missing qualification/API/close is always RED
	}
}
