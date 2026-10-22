//go:build windows

package process

import (
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Disabled, package-private owned-launch candidate. No profile provisioning,
// filesystem ACLs, capability list, network opt-in, runtime or public API.
// A non-nil policy is used ONLY by synthetic tests, never platformStart.
//
// SDK WinBase.h: ProcThreadAttributeValue(9/15,FALSE,TRUE,FALSE).
// SDK winnt.h: SECURITY_CAPABILITIES, TOKEN_INFORMATION_CLASS (x/sys v0.49
// stops its exported token enum at TokenLogonSid), TOKEN_APPCONTAINER_INFORMATION.
const (
	procThreadAttributeSecurityCapabilities        = 0x00020009
	procThreadAttributeAllPackagesPolicy           = 0x0002000f
	allApplicationPackagesOptOut            uint32 = 1
	tokenIsAppContainer                            = 29
	tokenCapabilities                              = 30
	tokenAppContainerSID                           = 31
	tokenIsLessPrivilegedAppContainer              = 46
	maxCandidateTokenBytes                         = 64 << 10
)

// Native PSID, PSID_AND_ATTRIBUTES, DWORD, DWORD, with natural pointer alignment.
// There is deliberately no caller-settable capabilities field on the policy.
type windowsSecurityCapabilities struct {
	appContainerSID *windows.SID
	capabilities    *windows.SIDAndAttributes
	capabilityCount uint32
	reserved        uint32
}

type windowsTokenAppContainerInformation struct {
	sid *windows.SID
}

var errWindowsAppContainerExecutionDisabled = errors.New("process: AppContainer candidate execution disabled pending owned filesystem and network/IPC gates")

type windowsAppContainerPolicy struct {
	profileSID *windows.SID // trusted owned SID; copied again for each launch
	lpac       bool         // explicit choice; unsupported LPAC must fail closed
}

func (p *windowsAppContainerPolicy) snapshot() (*windowsAppContainerPolicy, error) {
	if p == nil {
		return nil, nil
	}
	sid := p.profileSID
	// Profile SIDs are S-1-15-2 + seven moniker hash DWORDs, not the broad
	// ALL APPLICATION PACKAGES SID or a capability SID. Input is private,
	// trusted memory, not a caller-provided native address.
	if sid == nil || !sid.IsValid() || sid.IdentifierAuthority().Value != [6]byte{0, 0, 0, 0, 0, 15} || sid.SubAuthorityCount() != 8 || sid.SubAuthority(0) != 2 {
		return nil, errors.New("process: candidate requires an exact profile SID")
	}
	owned, err := sid.Copy() // Go-owned copy, never FreeSid/LocalFree this memory
	if err != nil {
		return nil, err
	}
	return &windowsAppContainerPolicy{profileSID: owned, lpac: p.lpac}, nil
}

func (p *windowsAppContainerPolicy) install(update func(uintptr, unsafe.Pointer, uintptr) error) error {
	caps := &windowsSecurityCapabilities{appContainerSID: p.profileSID}
	if err := update(procThreadAttributeSecurityCapabilities, unsafe.Pointer(caps), unsafe.Sizeof(*caps)); err != nil {
		return fmt.Errorf("process: required AppContainer attribute: %w", err)
	}
	if p.lpac {
		optOut := new(uint32)
		*optOut = allApplicationPackagesOptOut
		if err := update(procThreadAttributeAllPackagesPolicy, unsafe.Pointer(optOut), unsafe.Sizeof(*optOut)); err != nil {
			return fmt.Errorf("process: required LPAC attribute: %w", err)
		}
	}
	return nil
}

type windowsTokenInformation func(windows.Token, uint32, *byte, uint32, *uint32) error

// Word backing provides native alignment, with a bounded exact byte extent.
// Embedded PSIDs are validated inside this same buffer before any SID API call.
type windowsTokenBuffer struct {
	words []uintptr
	size  uint32
}

func (b windowsTokenBuffer) bytes() []byte {
	return unsafe.Slice((*byte)(unsafe.Pointer(&b.words[0])), int(b.size))
}

func queryCandidateToken(token windows.Token, class uint32, query windowsTokenInformation) (windowsTokenBuffer, error) {
	var needed uint32
	if err := query(token, class, nil, 0, &needed); !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
		if err == nil {
			return windowsTokenBuffer{}, fmt.Errorf("process: token class %d unexpectedly succeeded without a buffer", class)
		}
		return windowsTokenBuffer{}, fmt.Errorf("process: token class %d size query: %w", class, err)
	}
	if needed == 0 || needed > maxCandidateTokenBytes {
		return windowsTokenBuffer{}, fmt.Errorf("process: token class %d exceeds bounded buffer", class)
	}
	word := uint32(unsafe.Sizeof(uintptr(0)))
	b := windowsTokenBuffer{words: make([]uintptr, (needed+word-1)/word), size: needed}
	var returned uint32
	if err := query(token, class, &b.bytes()[0], needed, &returned); err != nil {
		return windowsTokenBuffer{}, fmt.Errorf("process: token class %d query: %w", class, err)
	}
	if returned == 0 || returned > needed {
		return windowsTokenBuffer{}, fmt.Errorf("process: token class %d invalid returned size", class)
	}
	b.size = returned
	return b, nil // no unbounded retry if token changes between calls
}

func (b windowsTokenBuffer) dword() (uint32, error) {
	if b.size != 4 {
		return 0, errors.New("process: invalid token DWORD layout")
	}
	return *(*uint32)(unsafe.Pointer(&b.words[0])), nil
}

func (b windowsTokenBuffer) boundedSID(sid *windows.SID, header uintptr) (*windows.SID, error) {
	data := b.bytes()
	base := uintptr(unsafe.Pointer(&data[0]))
	address := uintptr(unsafe.Pointer(sid))
	// Subtract only after checking ordering, then bound every read before
	// asking advapi32 to interpret the SID. Never reconstruct a Go pointer
	// from a stored uintptr (also compatible with checkptr).
	if address < base || address-base < header || address-base > uintptr(len(data)) || address%4 != 0 {
		return nil, errors.New("process: token SID outside owned buffer")
	}
	offset := address - base
	if uintptr(len(data))-offset < 8 {
		return nil, errors.New("process: truncated token SID header")
	}
	count := data[offset+1]
	if data[offset] != 1 || count > 15 || uintptr(len(data))-offset < 8+4*uintptr(count) {
		return nil, errors.New("process: truncated or invalid token SID")
	}
	owned := (*windows.SID)(unsafe.Pointer(&data[offset]))
	if !owned.IsValid() {
		return nil, errors.New("process: invalid token SID")
	}
	return owned, nil
}

func verifyWindowsAppContainerToken(token windows.Token, policy *windowsAppContainerPolicy, query windowsTokenInformation) error {
	if query == nil {
		query = windows.GetTokenInformation // advapi32 via x/sys SystemDLL, not PATH
	}
	for _, check := range []struct {
		class uint32
		want  uint32
	}{
		{tokenIsAppContainer, 1},
		{windows.TokenElevation, 0},
	} {
		b, err := queryCandidateToken(token, check.class, query)
		if err != nil {
			return err
		}
		got, err := b.dword()
		if err != nil || got != check.want {
			return fmt.Errorf("process: refused token class %d: value=%d layout=%v", check.class, got, err)
		}
	}
	container, err := queryCandidateToken(token, tokenAppContainerSID, query)
	if err != nil {
		return err
	}
	containerHeader := unsafe.Sizeof(windowsTokenAppContainerInformation{})
	if uintptr(container.size) < containerHeader {
		return errors.New("process: invalid token AppContainer layout")
	}
	info := (*windowsTokenAppContainerInformation)(unsafe.Pointer(&container.words[0]))
	sid, err := container.boundedSID(info.sid, containerHeader)
	if err != nil {
		return err
	}
	if !sid.Equals(policy.profileSID) {
		return errors.New("process: token profile SID mismatch")
	}
	runtime.KeepAlive(container)

	caps, err := queryCandidateToken(token, tokenCapabilities, query)
	if err != nil {
		return err
	}
	// Only GroupCount is needed: any nonzero count is refused, never iterated.
	if caps.size < 4 || *(*uint32)(unsafe.Pointer(&caps.words[0])) != 0 {
		return errors.New("process: token capabilities must be empty (no network capability)")
	}
	integrity, err := queryCandidateToken(token, windows.TokenIntegrityLevel, query)
	if err != nil {
		return err
	}
	integrityHeader := unsafe.Sizeof(windows.Tokenmandatorylabel{})
	if uintptr(integrity.size) < integrityHeader {
		return errors.New("process: invalid token integrity layout")
	}
	label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&integrity.words[0]))
	sid, err = integrity.boundedSID(label.Label.Sid, integrityHeader)
	if err != nil {
		return err
	}
	if label.Label.Attributes&windows.SE_GROUP_INTEGRITY == 0 || sid.IdentifierAuthority() != windows.SECURITY_MANDATORY_LABEL_AUTHORITY || sid.SubAuthorityCount() != 1 || sid.SubAuthority(0) != 0x1000 {
		return errors.New("process: token integrity is not Low")
	}
	runtime.KeepAlive(integrity)
	if policy.lpac {
		b, err := queryCandidateToken(token, tokenIsLessPrivilegedAppContainer, query)
		if err != nil {
			return err // unsupported query is refusal, never an AC fallback
		}
		got, err := b.dword()
		if err != nil || got != 1 {
			return fmt.Errorf("process: token is not LPAC: value=%d layout=%v", got, err)
		}
	}
	return nil
}
