//go:build windows

package secrets

import (
	"bytes"
	"database/sql"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Every mutation below is confined to newly made t.TempDir descendants. No
// fixture adjusts the test executable, token defaults, parent ACLs, profiles,
// developer mode, OS accounts, or global policy. No vault is constructed.
func winTestOwner(t *testing.T) *windows.SID {
	t.Helper()
	sid, err := winPrivateProcessSID()
	if err != nil {
		t.Fatal("process token query failed")
	}
	return sid
}

func winTestSDBytes(sd *windows.SECURITY_DESCRIPTOR) []byte {
	b := bytes.Clone(unsafe.Slice((*byte)(unsafe.Pointer(sd)), int(sd.Length())))
	runtime.KeepAlive(sd)
	return b
}

func winTestSD(t *testing.T, sddl string) *windows.SECURITY_DESCRIPTOR {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatal("fixture descriptor conversion failed")
	}
	return sd
}

// Set only a brand-new, empty fixture directory's owner and DACL. This is a
// deliberately broad test parent; production never repairs any descriptor.
func winTestBroadParent(t *testing.T) string {
	t.Helper()
	parent := filepath.Join(t.TempDir(), "broad-parent")
	if err := os.Mkdir(parent, 0700); err != nil {
		t.Fatal("fixture mkdir failed")
	}
	owner := winTestOwner(t)
	sd := winTestSD(t, "O:"+owner.String()+"D:P(A;OICI;FA;;;WD)")
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal("fixture DACL failed")
	}
	err = windows.SetNamedSecurityInfo(parent, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner, nil, dacl, nil)
	runtime.KeepAlive(sd)
	if err != nil {
		t.Fatal("fixture broad ACL failed")
	}
	return parent
}

func winTestRoot(t *testing.T, path string) *winPrivateRoot {
	t.Helper()
	root, err := createWinPrivateRoot(path)
	if err != nil {
		t.Fatal("private fixture creation failed")
	}
	t.Cleanup(func() {
		if root.close() != nil {
			t.Error("root close failed")
		}
	})
	return root
}

func winTestSnapshot(t *testing.T, path string) []byte {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal("fixture security snapshot failed")
	}
	return winTestSDBytes(sd)
}

func winTestClose(t *testing.T, h *winPrivateHandle) {
	t.Helper()
	if h.close() != nil {
		t.Fatal("fixture handle close failed")
	}
}

// Owner-only SA: no supplied DACL, so the child inherits the root's DACL. This
// avoids depending on an elevated token's default owner being TokenUser. It
// changes no token setting and never rewrites a child after creation.
func winTestFile(t *testing.T, root *winPrivateRoot, name string) {
	t.Helper()
	winTestFileSD(t, root, name, "O:"+root.owner.String())
}

func winTestFileSD(t *testing.T, root *winPrivateRoot, name, sddl string) {
	t.Helper()
	sd := winTestSD(t, sddl)
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	p, _ := windows.UTF16PtrFromString(filepath.Join(root.path, name))
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, winPrivateShare, &sa, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
	runtime.KeepAlive(sd)
	if err != nil {
		t.Fatal("fixture inherited file creation failed")
	}
	owned := &winPrivateHandle{h: h}
	var n uint32
	writeErr := windows.WriteFile(h, []byte("synthetic fixture only"), &n, nil)
	closeErr := owned.close()
	if writeErr != nil || closeErr != nil {
		t.Fatal("fixture file write/close failed")
	}
}

func TestWinPrivateCreationAndInheritance(t *testing.T) {
	parent := winTestBroadParent(t)
	before := winTestSnapshot(t, parent)
	path := filepath.Join(parent, "private")
	root := winTestRoot(t, path)
	sd, err := windows.GetSecurityInfo(root.h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil || !winPrivateDescriptor(winTestSDBytes(sd), root.owner, true) {
		t.Fatal("created root lacks required owner/protected two-ACE DACL")
	}
	if !winPrivatePath(root.path) {
		t.Fatal("no ordinary observed canonical path")
	}
	winTestFile(t, root, "known")
	h, err := openWinPrivateFile(root, "known")
	if err != nil {
		t.Fatal("inherited child was refused")
	}
	childSD, err := windows.GetSecurityInfo(h.h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		winTestClose(t, h)
		t.Fatal("child security query failed")
	}
	b := winTestSDBytes(childSD)
	aclOff := int(binary.LittleEndian.Uint32(b[16:20]))
	ace := aclOff + 8
	for i := 0; i < 2; i++ {
		if b[ace+1] != windows.INHERITED_ACE {
			winTestClose(t, h)
			t.Fatal("file inheritance did not produce an effective inherited ACE")
		}
		ace += int(binary.LittleEndian.Uint16(b[ace+2:]))
	}
	winTestClose(t, h)
	existing, err := inspectWinPrivateRoot(path)
	if err != nil {
		t.Fatal("safe existing root refused")
	}
	winTestClose(t, &existing.winPrivateHandle)
	rootBefore := winTestSnapshot(t, path)
	if duplicate, err := createWinPrivateRoot(path); duplicate != nil || !errors.Is(err, ErrDenied) {
		t.Fatal("existing root treated as a fresh creation")
	}
	if !bytes.Equal(rootBefore, winTestSnapshot(t, path)) || !bytes.Equal(before, winTestSnapshot(t, parent)) {
		t.Fatal("creation/inspection rewrote an existing descriptor")
	}
	if bad, err := inspectWinPrivateRoot(parent); bad != nil || !errors.Is(err, ErrDenied) {
		t.Fatal("broad root accepted")
	}
	if !bytes.Equal(before, winTestSnapshot(t, parent)) {
		t.Fatal("unsafe root repaired instead of rejected")
	}
}

func TestWinPrivateExistingUnsafeDescriptorsNeverRepaired(t *testing.T) {
	parent := winTestBroadParent(t)
	root := winTestRoot(t, filepath.Join(parent, "private"))
	user := root.owner.String()
	for _, tc := range []struct{ name, acl string }{
		{"extra-world", "(A;OICI;FA;;;" + user + ")(A;OICI;FA;;;SY)(A;OICI;FR;;;WD)"},
		{"extra-admin", "(A;OICI;FA;;;" + user + ")(A;OICI;FA;;;SY)(A;OICI;FR;;;BA)"},
		{"extra-users", "(A;OICI;FA;;;" + user + ")(A;OICI;FA;;;SY)(A;OICI;FR;;;BU)"},
		{"extra-app-packages", "(A;OICI;FA;;;" + user + ")(A;OICI;FA;;;SY)(A;OICI;FR;;;AC)"},
		{"extra-owner-rights", "(A;OICI;FA;;;" + user + ")(A;OICI;FA;;;SY)(A;OICI;FR;;;OW)"},
		{"missing-system", "(A;OICI;FA;;;" + user + ")"},
		{"deny", "(D;OICI;0x2;;;S-1-5-21-111-222-333-1002)(A;OICI;FA;;;" + user + ")(A;OICI;FA;;;SY)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(parent, tc.name)
			sd := winTestSD(t, "O:"+user+"D:P"+tc.acl)
			sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
			p, _ := windows.UTF16PtrFromString(path)
			err := windows.CreateDirectory(p, &sa)
			runtime.KeepAlive(sd)
			if err != nil {
				t.Fatal("unsafe directory fixture creation failed")
			}
			before := winTestSnapshot(t, path)
			if h, err := inspectWinPrivateRoot(path); h != nil || !errors.Is(err, ErrDenied) {
				t.Fatal("unsafe existing root was accepted")
			}
			if !bytes.Equal(before, winTestSnapshot(t, path)) {
				t.Fatal("unsafe root descriptor was repaired")
			}
			// File fixtures use explicit effective ACEs rather than inheritable
			// directory flags, isolating the trustee/mask/type policy.
			fileACL := strings.ReplaceAll(tc.acl, ";OICI;", ";;")
			winTestFileSD(t, root, tc.name, "O:"+user+"D:P"+fileACL)
			filePath := filepath.Join(root.path, tc.name)
			fileBefore := winTestSnapshot(t, filePath)
			if h, err := openWinPrivateFile(root, tc.name); h != nil || !errors.Is(err, ErrDenied) {
				t.Fatal("unsafe existing file was accepted")
			}
			if !bytes.Equal(fileBefore, winTestSnapshot(t, filePath)) {
				t.Fatal("unsafe file descriptor was repaired")
			}
		})
	}
}

func TestWinPrivateHostileObjects(t *testing.T) {
	parent := winTestBroadParent(t)
	root := winTestRoot(t, filepath.Join(parent, "private"))
	outside := winTestRoot(t, filepath.Join(parent, "outside-fake"))
	winTestFile(t, outside, "untouched")
	outsidePath := filepath.Join(outside.path, "untouched")
	before, err := os.ReadFile(outsidePath)
	if err != nil {
		t.Fatal("fixture read failed")
	}
	beforeACL := winTestSnapshot(t, outsidePath)
	outsideACL := winTestSnapshot(t, outside.path)
	parentACL := winTestSnapshot(t, parent)
	t.Cleanup(func() {
		after, err := os.ReadFile(outsidePath)
		if err != nil || !bytes.Equal(before, after) || !bytes.Equal(beforeACL, winTestSnapshot(t, outsidePath)) || !bytes.Equal(outsideACL, winTestSnapshot(t, outside.path)) || !bytes.Equal(parentACL, winTestSnapshot(t, parent)) {
			t.Error("outside fixture content or ACL changed")
		}
	})
	// First establish that the source is otherwise an approved private file.
	h, err := openWinPrivateFile(outside, "untouched")
	if err != nil {
		t.Fatal("hardlink source is not otherwise approved")
	}
	winTestClose(t, h)
	if err := os.Link(outsidePath, filepath.Join(root.path, "hardlink")); err != nil {
		t.Fatal("fixture hardlink failed")
	}
	if h, err := openWinPrivateFile(root, "hardlink"); h != nil || !errors.Is(err, ErrDenied) {
		t.Fatal("hardlinked known file accepted")
	}
	if h, err := openWinPrivateFile(root, "missing"); h != nil || !errors.Is(err, ErrNotFound) {
		t.Fatal("missing file classification incorrect")
	}
	for _, name := range []string{"", ".", "..", `..\outside-fake\untouched`, `C:\anything`, "known:stream", "NUL", "trailing."} {
		if h, err := openWinPrivateFile(root, name); h != nil || !errors.Is(err, ErrDenied) {
			t.Fatal("non-child filename accepted")
		}
	}
	t.Run("directory-as-file", func(t *testing.T) {
		_ = winTestRoot(t, filepath.Join(root.path, "directory"))
		if h, err := openWinPrivateFile(root, "directory"); h != nil || !errors.Is(err, ErrDenied) {
			t.Fatal("directory accepted as file")
		}
	})
	t.Run("root-junction", func(t *testing.T) {
		link := filepath.Join(parent, "junction")
		winTestJunction(t, link, outside.path)
		if h, err := inspectWinPrivateRoot(link); h != nil || !errors.Is(err, ErrDenied) {
			t.Fatal("junction root accepted")
		}
	})
	t.Run("file-reparse", func(t *testing.T) {
		link := filepath.Join(root.path, "symlink")
		if err := os.Symlink(outsidePath, link); err != nil {
			if errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD) {
				t.Skip("file symlink fixture requires an already-enabled privilege/developer mode; no settings changed")
			}
			t.Fatal("file symlink fixture failed")
		}
		if h, err := openWinPrivateFile(root, "symlink"); h != nil || !errors.Is(err, ErrDenied) {
			t.Fatal("file reparse point accepted")
		}
	})
	winTestFile(t, root, "not-directory")
	if h, err := inspectWinPrivateRoot(filepath.Join(root.path, "not-directory")); h != nil || !errors.Is(err, ErrDenied) {
		t.Fatal("regular file accepted as root")
	}
}

// Mount-point reparse fixture (junction) needs no new symlink privilege. The
// target is another fixture, and the reparse buffer is set only on a new empty
// fixture directory. Cleanup unlinks the junction, never walks its target.
func winTestJunction(t *testing.T, path, target string) {
	t.Helper()
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal("junction fixture mkdir failed")
	}
	h, err := winPrivateOpen(path, windows.GENERIC_WRITE)
	if err != nil {
		t.Fatal("junction fixture open failed")
	}
	sub, _ := windows.UTF16FromString(`\??\` + target)
	print, _ := windows.UTF16FromString(target)
	data := make([]byte, 16+2*(len(sub)+len(print)))
	binary.LittleEndian.PutUint32(data[0:4], windows.IO_REPARSE_TAG_MOUNT_POINT)
	binary.LittleEndian.PutUint16(data[4:6], uint16(len(data)-8))
	binary.LittleEndian.PutUint16(data[10:12], uint16(2*(len(sub)-1)))
	binary.LittleEndian.PutUint16(data[12:14], uint16(2*len(sub)))
	binary.LittleEndian.PutUint16(data[14:16], uint16(2*(len(print)-1)))
	for i, c := range append(sub, print...) {
		binary.LittleEndian.PutUint16(data[16+2*i:], c)
	}
	var returned uint32
	err = windows.DeviceIoControl(h.h, windows.FSCTL_SET_REPARSE_POINT, &data[0], uint32(len(data)), nil, 0, &returned, nil)
	closeErr := h.close()
	if err != nil || closeErr != nil {
		t.Fatal("junction fixture setup failed")
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil {
			t.Error("junction fixture unlink failed")
		}
	})
}

func TestWinPrivateDeleteSharingAndClose(t *testing.T) {
	root := winTestRoot(t, filepath.Join(winTestBroadParent(t), "private"))
	winTestFile(t, root, "sidecar")
	h, err := openWinPrivateFile(root, "sidecar")
	if err != nil {
		t.Fatal("fixture open failed")
	}
	// Request DELETE while our inspected handle is live. This tests only sharing,
	// not publication/rename durability and not SQLite's own sharing behavior.
	other, err := winPrivateOpen(filepath.Join(root.path, "sidecar"), windows.DELETE|windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		winTestClose(t, h)
		t.Fatal("helper handle prevented delete sharing")
	}
	winTestClose(t, other)
	winTestClose(t, h)
	winTestClose(t, h) // Idempotent close.
	// Synthetic handle plus explicit injected closer: never CloseHandle an
	// arbitrary number that could accidentally belong to the test runtime.
	bad := &winPrivateHandle{h: windows.Handle(42)}
	if err := bad.closeWith(nil); !errors.Is(err, ErrUnavailable) || bad.h != 42 {
		t.Fatal("nil closer did not refuse without I/O")
	}
	calls := 0
	closer := func(h windows.Handle) error {
		calls++
		if h != 42 {
			t.Fatal("unexpected synthetic handle")
		}
		return errors.New("synthetic close diagnostic")
	}
	if err := bad.closeWith(closer); !errors.Is(err, ErrUnavailable) || bad.h != 0 || strings.Contains(err.Error(), "synthetic") {
		t.Fatal("close failure was hidden, unsanitized, or retained an unsafe handle")
	}
	if err := bad.closeWith(closer); err != nil || calls != 1 {
		t.Fatal("failed close was retried")
	}
	winTestClose(t, &root.winPrivateHandle)
	if h, err := openWinPrivateFile(root, "sidecar"); h != nil || !errors.Is(err, ErrDenied) {
		t.Fatal("closed root accepted")
	}
}

func TestWinPrivateDescriptorPolicy(t *testing.T) {
	// Numeric synthetic SIDs: descriptor parsing, not foreign-user execution.
	owner, err := windows.StringToSid("S-1-5-21-111-222-333-1001")
	if err != nil {
		t.Fatal("synthetic SID failed")
	}
	user := owner.String()
	for _, tc := range []struct {
		name, dacl          string
		directory, accepted bool
	}{
		{"root", "D:P(A;OICI;FA;;;" + user + ")(A;OICI;FA;;;SY)", true, true},
		{"root-reversed", "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + user + ")", true, true},
		{"file-inherited", "D:AI(A;ID;FA;;;" + user + ")(A;ID;FA;;;SY)", false, true},
		{"file-explicit", "D:P(A;;FA;;;" + user + ")(A;;FA;;;SY)", false, true},
		{"unprotected-root", "D:(A;OICI;FA;;;" + user + ")(A;OICI;FA;;;SY)", true, false},
		{"inherited-root", "D:P(A;OICIID;FA;;;" + user + ")(A;OICIID;FA;;;SY)", true, false},
		{"inherit-only", "D:P(A;OIIO;FA;;;" + user + ")(A;OIIO;FA;;;SY)", true, false},
		{"no-propagate", "D:P(A;OICINP;FA;;;" + user + ")(A;OICINP;FA;;;SY)", true, false},
		{"file-inherit-only", "D:(A;IO;FA;;;" + user + ")(A;IO;FA;;;SY)", false, false},
		{"file-deny", "D:P(D;;FA;;;WD)(A;;FA;;;" + user + ")(A;;FA;;;SY)", false, false},
		{"partial-mask", "D:P(A;;FR;;;" + user + ")(A;;FA;;;SY)", false, false},
		{"duplicate-user", "D:P(A;;FA;;;" + user + ")(A;;FA;;;" + user + ")", false, false},
		{"empty", "D:P", false, false},
		{"null", "D:NO_ACCESS_CONTROL", false, false},
		{"absent", "", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := winTestSDBytes(winTestSD(t, "O:"+user+tc.dacl))
			if winPrivateDescriptor(b, owner, tc.directory) != tc.accepted {
				t.Fatal("descriptor policy mismatch")
			}
		})
	}
	for _, trustee := range []string{"WD", "BU", "BA", "AC", "OW", "S-1-5-21-111-222-333-1002"} {
		b := winTestSDBytes(winTestSD(t, "O:"+user+"D:P(A;;FA;;;"+user+")(A;;FA;;;"+trustee+")"))
		if winPrivateDescriptor(b, owner, false) {
			t.Fatal("extra/foreign trustee accepted")
		}
	}
	valid := winTestSDBytes(winTestSD(t, "O:"+user+"D:P(A;OICI;FA;;;"+user+")(A;OICI;FA;;;SY)"))
	foreign, _ := windows.StringToSid("S-1-5-21-111-222-333-1002")
	if winPrivateDescriptor(valid, foreign, true) || winPrivateDescriptor(valid, nil, true) {
		t.Fatal("wrong/missing owner accepted")
	}
	for n := 0; n < len(valid); n++ {
		_ = winPrivateDescriptor(valid[:n], owner, true) // All truncations must be bounded/no panic.
	}
	for _, offset := range []uint32{0, 1, 19, uint32(len(valid)), 0xffffffff} {
		for _, field := range []int{4, 16} {
			b := bytes.Clone(valid)
			binary.LittleEndian.PutUint32(b[field:], offset)
			if winPrivateDescriptor(b, owner, true) {
				t.Fatal("invalid owner/ACL offset accepted")
			}
		}
	}
	acl := int(binary.LittleEndian.Uint32(valid[16:20]))
	for _, change := range []struct {
		off   int
		value byte
	}{{acl, 4}, {acl + 4, 3}, {acl + 8, 17}, {acl + 9, 0xff}, {acl + 10, 0}, {acl + 17, 255}} {
		b := bytes.Clone(valid)
		b[change.off] = change.value
		if winPrivateDescriptor(b, owner, true) {
			t.Fatal("unsupported/malformed ACL/ACE accepted")
		}
	}
}

func TestWinPrivateSystemOwnerCannotCollapseTrustees(t *testing.T) {
	owner, err := windows.StringToSid("S-1-5-18")
	if err != nil {
		t.Fatal("synthetic SYSTEM SID creation failed")
	}
	for _, tc := range []struct {
		name, flags string
		directory   bool
	}{
		{"root", "OICI", true},
		{"explicit-file", "", false},
		{"inherited-file", "ID", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sd := winTestSD(t, "O:SYD:P(A;"+tc.flags+";FA;;;SY)(A;"+tc.flags+";FA;;;SY)")
			if winPrivateDescriptor(winTestSDBytes(sd), owner, tc.directory) {
				t.Fatal("SYSTEM owner collapsed two distinct approved trustees")
			}
		})
	}
}

func TestWinPrivatePathContractAndErrors(t *testing.T) {
	for _, path := range []string{`C:\private`, `d:\fixture\normal name`, `C:\fixture\é`} {
		if !winPrivatePath(path) {
			t.Fatal("normal drive absolute path refused")
		}
	}
	for _, path := range []string{"", `C:relative`, `C:\`, `\rooted`, `\\server\share\private`, `\\?\C:\private`, `\\?\Volume{fake}\private`, `\\.\C:\private`, `C:/private`, `C:\foo\..\private`, `C:\foo\.\private`, `C:\foo\`, `C:\foo\\bar`, `C:\foo:stream`, `C:\foo.`, `C:\foo `, `C:\NUL`, `C:\com1.txt`, `C:\LPT²`, "C:\\nul\x00", `C:\` + strings.Repeat("x", 240)} {
		if winPrivatePath(path) {
			t.Fatal("unsupported path spelling accepted")
		}
		// Refusal occurs before token/filesystem access for invalid input.
		if root, err := createWinPrivateRoot(path); root != nil || !errors.Is(err, ErrDenied) {
			t.Fatal("invalid creation path not refused")
		}
	}
	for _, native := range []error{windows.ERROR_ACCESS_DENIED, windows.ERROR_ALREADY_EXISTS, windows.ERROR_FILE_NOT_FOUND, windows.ERROR_SHARING_VIOLATION, errors.New("synthetic sensitive native cause")} {
		err := winPrivateNativeError("private-open", native)
		var typed *Error
		if !errors.As(err, &typed) || strings.Contains(err.Error(), "synthetic") || errors.Unwrap(err) == native {
			t.Fatal("native error was not sanitized")
		}
	}
	path := filepath.Join(t.TempDir(), "missing-parent", "child")
	if root, err := createWinPrivateRoot(path); root != nil || !errors.Is(err, ErrNotFound) {
		t.Fatal("missing parent unexpectedly created recursively")
	}
	if _, err := os.Stat(filepath.Dir(path)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("missing parent was created")
	}
}

func TestWinPrivateSQLiteSidecarInheritance(t *testing.T) {
	root := winTestRoot(t, filepath.Join(winTestBroadParent(t), "private"))
	// All SQL data is synthetic. No Persistent, vault, app DB, or provider.
	db, err := sql.Open("sqlite", filepath.Join(root.path, "fixture.db"))
	if err != nil {
		t.Fatal("fixture SQLite open failed")
	}
	db.SetMaxOpenConns(1)
	defer func() {
		if db.Close() != nil {
			t.Error("fixture SQLite close failed")
		}
	}()
	if _, err := db.Exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('synthetic');"); err != nil {
		t.Fatal("fixture SQLite WAL setup failed")
	}
	for _, name := range []string{"fixture.db", "fixture.db-wal", "fixture.db-shm"} {
		path := filepath.Join(root.path, name)
		sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal("SQLite fixture file missing")
		}
		b := winTestSDBytes(sd)
		// Check inheritance separately from owner: an elevated admin token can
		// default file ownership to Administrators instead of TokenUser. Do not
		// rewrite it or relax production owner policy to make that fixture pass.
		observedOwner, _, err := sd.Owner()
		if err != nil || observedOwner == nil {
			t.Fatal("SQLite fixture owner query failed")
		}
		// Normalize owner only in an independent in-memory descriptor so the
		// same exact two-trustee/mask/flags policy also checks elevated fixtures.
		abs, err := sd.ToAbsolute()
		if err != nil || abs.SetOwner(root.owner, false) != nil {
			t.Fatal("in-memory fixture descriptor conversion failed")
		}
		normalized, err := abs.ToSelfRelative()
		if err != nil || !winPrivateDescriptor(winTestSDBytes(normalized), root.owner, false) {
			t.Fatal("SQLite file inherited an unapproved DACL")
		}
		aclOff := int(binary.LittleEndian.Uint32(b[16:20]))
		ace := aclOff + 8
		for i := 0; i < 2; i++ {
			if b[ace+1] != windows.INHERITED_ACE {
				t.Fatal("SQLite sidecar did not inherit effective file ACEs")
			}
			ace += int(binary.LittleEndian.Uint16(b[ace+2:]))
		}
		h, openErr := openWinPrivateFile(root, name)
		if !observedOwner.Equals(root.owner) {
			if h != nil || !errors.Is(openErr, ErrDenied) {
				t.Fatal("SQLite default-owner mismatch not refused")
			}
			t.Log("SQLite inherited DACL; default owner differs from TokenUser: production helper correctly refuses (not an acceptance proof)")
			continue
		}
		if openErr != nil {
			t.Fatal("SQLite fixture private open failed")
		}
		winTestClose(t, h)
	}
}
