//go:build windows

package process

import (
	"errors"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Bind query and semantic authority together, never mix fake/native fields.
func newNativeAppContainerVerification() (*windowsAppContainerVerification, error) {
	api, err := newNativeLPACAccessAPI()
	if err != nil {
		return nil, err
	}
	return &windowsAppContainerVerification{
		query: api.query,
		checkLPAC: func(source windows.Token, profile []byte) error {
			return verifyWindowsLPACSemantics(source, profile, api)
		},
	}, nil
}

// Deliberate all-or-nothing native constructor. No lazy per-field defaults, no
// OpenProcess/OpenProcessToken binding, and no source-rights escalation path.
func newNativeLPACAccessAPI() (lpacAccessAPI, error) {
	advapi := windows.NewLazySystemDLL("advapi32.dll")
	kernel := windows.NewLazySystemDLL("kernel32.dll")
	query, duplicate := advapi.NewProc("GetTokenInformation"), advapi.NewProc("DuplicateTokenEx")
	access, valid := advapi.NewProc("AccessCheck"), advapi.NewProc("IsValidSecurityDescriptor")
	initSD, owner, group, dacl := advapi.NewProc("InitializeSecurityDescriptor"), advapi.NewProc("SetSecurityDescriptorOwner"), advapi.NewProc("SetSecurityDescriptorGroup"), advapi.NewProc("SetSecurityDescriptorDacl")
	initACL, addACE, relative := advapi.NewProc("InitializeAcl"), advapi.NewProc("AddAccessAllowedAce"), advapi.NewProc("MakeSelfRelativeSD")
	closeHandle := kernel.NewProc("CloseHandle")
	for _, p := range []*windows.LazyProc{query, duplicate, access, valid, initSD, owner, group, dacl, initACL, addACE, relative, closeHandle} {
		if err := p.Find(); err != nil {
			return lpacAccessAPI{}, lpacBoundError(err)
		}
	}
	return lpacAccessAPI{
		query: func(token windows.Token, class uint32, out *byte, size uint32, used *uint32) error {
			r, _, e := query.Call(uintptr(token), uintptr(class), uintptr(unsafe.Pointer(out)), uintptr(size), uintptr(unsafe.Pointer(used)))
			runtime.KeepAlive(out)
			runtime.KeepAlive(used)
			return lpacAccessBOOL(r, e)
		},
		duplicate: func(in windows.Token, rights, level, kind uint32, out *windows.Token) error {
			// NULL attributes: non-inheritable; no SACL or extra token rights.
			r, _, e := duplicate.Call(uintptr(in), uintptr(rights), 0, uintptr(level), uintptr(kind), uintptr(unsafe.Pointer(out)))
			runtime.KeepAlive(out)
			return lpacAccessBOOL(r, e)
		},
		close: func(token windows.Token) error {
			r, _, e := closeHandle.Call(uintptr(token))
			return lpacAccessBOOL(r, e)
		},
		buildSD: func(user, primaryGroup, packageSID []byte) (lpacAccessSD, error) {
			if !lpacAccessSID(user) || !lpacAccessSID(primaryGroup) || (packageSID != nil && !lpacAccessSID(packageSID)) {
				return lpacAccessSD{}, errors.New("process: LPAC semantic builder SID refused")
			}
			owned := func(b []byte) []uint32 {
				w := make([]uint32, len(b)/4)
				copy(unsafe.Slice((*byte)(unsafe.Pointer(&w[0])), len(b)), b)
				return w
			}
			u, g := owned(user), owned(primaryGroup)
			var p []uint32
			aclSize := 8 + 8 + len(user)
			if packageSID != nil {
				p = owned(packageSID)
				aclSize += 8 + len(packageSID)
			}
			acl := make([]uint32, aclSize/4)
			defer func() { runtime.KeepAlive(u); runtime.KeepAlive(g); runtime.KeepAlive(p); runtime.KeepAlive(acl) }()
			r, _, e := initACL.Call(uintptr(unsafe.Pointer(&acl[0])), uintptr(aclSize), 2)
			if err := lpacAccessBOOL(r, e); err != nil {
				return lpacAccessSD{}, err
			}
			for _, sid := range [][]uint32{u, p} {
				if sid == nil {
					continue
				}
				r, _, e = addACE.Call(uintptr(unsafe.Pointer(&acl[0])), 2, windows.FILE_READ_DATA, uintptr(unsafe.Pointer(&sid[0])))
				runtime.KeepAlive(sid)
				if err := lpacAccessBOOL(r, e); err != nil {
					return lpacAccessSD{}, err
				}
			}
			var absolute windows.SECURITY_DESCRIPTOR
			r, _, e = initSD.Call(uintptr(unsafe.Pointer(&absolute)), 1)
			if err := lpacAccessBOOL(r, e); err != nil {
				return lpacAccessSD{}, err
			}
			r, _, e = owner.Call(uintptr(unsafe.Pointer(&absolute)), uintptr(unsafe.Pointer(&u[0])), 0)
			if err := lpacAccessBOOL(r, e); err != nil {
				return lpacAccessSD{}, err
			}
			r, _, e = group.Call(uintptr(unsafe.Pointer(&absolute)), uintptr(unsafe.Pointer(&g[0])), 0)
			if err := lpacAccessBOOL(r, e); err != nil {
				return lpacAccessSD{}, err
			}
			r, _, e = dacl.Call(uintptr(unsafe.Pointer(&absolute)), 1, uintptr(unsafe.Pointer(&acl[0])), 0)
			if err := lpacAccessBOOL(r, e); err != nil {
				return lpacAccessSD{}, err
			}
			var needed uint32
			r, _, e = relative.Call(uintptr(unsafe.Pointer(&absolute)), 0, uintptr(unsafe.Pointer(&needed)))
			if uint32(r) != 0 || !errors.Is(e, windows.ERROR_INSUFFICIENT_BUFFER) || needed < 20 || needed > 4096 || needed%4 != 0 {
				runtime.KeepAlive(absolute)
				return lpacAccessSD{}, errors.New("process: LPAC semantic SD size refused")
			}
			result := lpacAccessSD{words: make([]uint32, needed/4), size: int(needed)}
			used := needed
			r, _, e = relative.Call(uintptr(unsafe.Pointer(&absolute)), uintptr(unsafe.Pointer(&result.words[0])), uintptr(unsafe.Pointer(&used)))
			runtime.KeepAlive(absolute)
			runtime.KeepAlive(result)
			if err := lpacAccessBOOL(r, e); err != nil {
				return lpacAccessSD{}, err
			}
			if used != needed || !lpacValidAccessSD(result, user, primaryGroup, packageSID) {
				return lpacAccessSD{}, errors.New("process: LPAC semantic constructed SD refused")
			}
			return result, nil
		},
		validSD: func(sd *byte) bool {
			r, _, _ := valid.Call(uintptr(unsafe.Pointer(sd))) // no GetLastError contract
			runtime.KeepAlive(sd)
			return uint32(r) != 0
		},
		access: func(sd *byte, token windows.Token, desired uint32, mapping *lpacAccessMapping, privileges *byte, length, granted *uint32, status *int32) error {
			r, _, e := access.Call(uintptr(unsafe.Pointer(sd)), uintptr(token), uintptr(desired), uintptr(unsafe.Pointer(mapping)), uintptr(unsafe.Pointer(privileges)), uintptr(unsafe.Pointer(length)), uintptr(unsafe.Pointer(granted)), uintptr(unsafe.Pointer(status)))
			runtime.KeepAlive(sd)
			runtime.KeepAlive(mapping)
			runtime.KeepAlive(privileges)
			runtime.KeepAlive(length)
			runtime.KeepAlive(granted)
			runtime.KeepAlive(status)
			return lpacAccessBOOL(r, e) // API success is not access granted
		},
	}, nil
}

func lpacAccessBOOL(result uintptr, last error) error {
	if uint32(result) != 0 {
		return nil // stale last-error is irrelevant on success
	}
	if last == nil || errors.Is(last, windows.ERROR_SUCCESS) {
		return errors.New("process: LPAC semantic API returned FALSE")
	}
	return last
}
