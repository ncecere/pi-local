//go:build windows && amd64

package secrets

import (
	"path/filepath"
	"runtime"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Native Authz is TEST ONLY. This is a SID-only synthetic authorization model,
// not a logon token, actual foreign-user login, or proof against administrators.
// AUTHZ_SKIP_TOKEN_GROUPS (2) avoids group/account lookup and S4U logon;
// AUTHZ_RM_FLAG_NO_AUDIT (1) avoids requesting an audit privilege or OS auditing.
// This direct ABI harness is intentionally limited to Windows amd64.
func TestWinPrivateSyntheticSIDAuthz(t *testing.T) {
	root := winTestRoot(t, filepath.Join(winTestBroadParent(t), "private"))
	sd, err := windows.GetSecurityInfo(root.h, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal("Authz fixture descriptor query failed")
	}
	dll := windows.NewLazySystemDLL("authz.dll")
	initRM := dll.NewProc("AuthzInitializeResourceManager")
	freeRM := dll.NewProc("AuthzFreeResourceManager")
	initContext := dll.NewProc("AuthzInitializeContextFromSid")
	freeContext := dll.NewProc("AuthzFreeContext")
	accessCheck := dll.NewProc("AuthzAccessCheck")
	for _, proc := range []*windows.LazyProc{initRM, freeRM, initContext, freeContext, accessCheck} {
		if proc.Find() != nil {
			t.Fatal("native Authz API unavailable")
		}
	}
	var manager windows.Handle
	ok, _, _ := initRM.Call(1, 0, 0, 0, 0, uintptr(unsafe.Pointer(&manager)))
	if ok == 0 {
		t.Fatal("Authz resource manager creation failed")
	}
	defer func() {
		if ok, _, _ := freeRM.Call(uintptr(manager)); ok == 0 {
			t.Error("Authz resource manager release failed")
		}
	}()

	// C layout of AUTHZ_ACCESS_REQUEST / AUTHZ_ACCESS_REPLY on amd64. No cached
	// results, callbacks, audit events, generic mappings, or optional descriptors.
	type request struct {
		desired         uint32
		self            *windows.SID
		objectTypes     unsafe.Pointer
		objectTypeCount uint32
		optional        unsafe.Pointer
	}
	type reply struct {
		count   uint32
		granted *uint32
		sacl    *uint32
		status  *uint32
	}
	for _, tc := range []struct {
		label, sid string
		allowed    bool
	}{
		{"owner-SID-only", root.owner.String(), true},
		{"SYSTEM-SID-only", "S-1-5-18", true},
		{"foreign-synthetic-SID-only", "S-1-5-21-111-222-333-1002", false},
		{"Administrators-SID-only", "S-1-5-32-544", false},
		{"Users-SID-only", "S-1-5-32-545", false},
		{"AllAppPackages-SID-only", "S-1-15-2-1", false},
	} {
		t.Run(tc.label, func(t *testing.T) {
			sid, err := windows.StringToSid(tc.sid)
			if err != nil {
				t.Fatal("synthetic Authz SID creation failed")
			}
			var pinned runtime.Pinner
			pinned.Pin(sid)
			defer pinned.Unpin()
			var context windows.Handle
			// LUID Identifier is an all-zero 8-byte value passed by value on amd64.
			ok, _, _ := initContext.Call(2, uintptr(unsafe.Pointer(sid)), uintptr(manager), 0, 0, 0, uintptr(unsafe.Pointer(&context)))
			if ok == 0 {
				t.Fatal("SID-only Authz context creation failed")
			}
			defer func() {
				if ok, _, _ := freeContext.Call(uintptr(context)); ok == 0 {
					t.Error("Authz context release failed")
				}
			}()
			for _, mask := range []uint32{windows.FILE_READ_DATA, windows.FILE_WRITE_DATA, windows.DELETE, windows.WRITE_DAC, windows.WRITE_OWNER, winPrivateFullControl} {
				var granted, status uint32
				req := request{desired: mask}
				rep := reply{count: 1, granted: &granted, status: &status}
				ok, _, _ := accessCheck.Call(0, uintptr(context), uintptr(unsafe.Pointer(&req)), 0,
					uintptr(unsafe.Pointer(sd)), 0, 0, uintptr(unsafe.Pointer(&rep)), 0)
				runtime.KeepAlive(sd)
				runtime.KeepAlive(req)
				runtime.KeepAlive(rep)
				if ok == 0 {
					t.Fatal("synthetic Authz access evaluation failed")
				}
				if tc.allowed {
					if status != 0 || granted&mask != mask {
						t.Fatal("approved SID-only context not granted requested rights")
					}
				} else if status != uint32(windows.ERROR_ACCESS_DENIED) || granted&mask != 0 {
					t.Fatal("unapproved SID-only context obtained requested rights")
				}
			}
		})
	}
}
