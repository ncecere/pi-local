//go:build windows

package secrets

// These primitives are deliberately not called by the persistent store. They
// establish neither publication durability nor a race-proof namespace binding.
import (
	"bytes"
	"encoding/binary"
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"
)

const winPrivateFullControl = 0x001f01ff // FILE_ALL_ACCESS, not GENERIC_ALL
const winPrivateShare = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE

// winPrivateHandle owns exactly one non-inheritable native handle. It must not
// be copied or used concurrently with close. No finalizer hides close failures.
type winPrivateHandle struct {
	h windows.Handle
}

func (h *winPrivateHandle) close() error { return h.closeWith(windows.CloseHandle) }

// Explicit close seam only: a nil injected closer never falls through to I/O.
func (h *winPrivateHandle) closeWith(closeHandle func(windows.Handle) error) error {
	if h == nil || h.h == 0 || h.h == windows.InvalidHandle {
		return nil
	}
	if closeHandle == nil {
		return failure("close", ErrUnavailable)
	}
	err := closeHandle(h.h)
	h.h = 0 // Never retry a possibly released/reused handle.
	if err != nil {
		return failure("close", ErrUnavailable)
	}
	return nil
}

type winPrivateRoot struct {
	winPrivateHandle
	path  string       // Observed DOS final path; NOT a portable identity or binding.
	owner *windows.SID // Independent Go-owned copy of process TokenUser.
}

// winPrivatePath accepts only ordinary drive-absolute DOS paths, deliberately
// bounded below MAX_PATH. No UNC, extended/device/volume namespace, ADS, relative
// component, trailing dot/space, DOS device name, or alternate slash spelling.
// This does not normalize or claim equivalence of case/8.3/ancestor aliases.
func winPrivatePath(path string) bool {
	if !utf8.ValidString(path) || len(path) < 4 || !((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) || path[1:3] != `:\` {
		return false
	}
	u, err := windows.UTF16FromString(path)
	if err != nil || len(u) > 241 {
		return false
	}
	for _, part := range strings.Split(path[3:], `\`) {
		if part == "" || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return false
		}
		for _, c := range part {
			if c < 32 || strings.ContainsRune(`<>:"/|?*`, c) {
				return false
			}
		}
		base, _, _ := strings.Cut(strings.ToUpper(part), ".")
		switch base {
		case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
			return false
		}
		if len([]rune(base)) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && strings.ContainsRune("123456789¹²³", []rune(base)[3]) {
			return false
		}
	}
	return true
}

func winPrivateNativeError(op string, err error) error {
	kind := ErrUnavailable
	switch {
	case errors.Is(err, windows.ERROR_ACCESS_DENIED), errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD), errors.Is(err, windows.ERROR_ALREADY_EXISTS), errors.Is(err, windows.ERROR_FILE_EXISTS):
		kind = ErrDenied
	case errors.Is(err, windows.ERROR_FILE_NOT_FOUND), errors.Is(err, windows.ERROR_PATH_NOT_FOUND):
		kind = ErrNotFound
	}
	return failure(op, kind)
}

// Query a real TOKEN_QUERY process token, not an impersonation token or a
// profile/account lookup. Copy before releasing its owned information buffer.
func winPrivateProcessSID() (_ *windows.SID, result error) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		return nil, winPrivateNativeError("private-owner", err)
	}
	defer func() {
		if token.Close() != nil {
			result = failure("close", ErrUnavailable)
		}
	}()
	user, err := token.GetTokenUser()
	if err != nil {
		return nil, winPrivateNativeError("private-owner", err)
	}
	if user.User.Sid == nil || !user.User.Sid.IsValid() {
		return nil, failure("private-owner", ErrDenied)
	}
	sid, err := user.User.Sid.Copy()
	runtime.KeepAlive(user)
	if err != nil {
		return nil, winPrivateNativeError("private-owner", err)
	}
	// Shared by creation and existing-root inspection: approved trustees must
	// remain distinct. SYSTEM cannot stand for both the user and SYSTEM ACE.
	if sid.IsWellKnown(windows.WinLocalSystemSid) {
		return nil, failure("private-owner", ErrUnsupported)
	}
	return sid, nil
}

func winPrivateOpen(path string, access uint32) (*winPrivateHandle, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, failure("private-open", ErrDenied)
	}
	h, err := windows.CreateFile(p, access, winPrivateShare, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return nil, winPrivateNativeError("private-open", err)
	}
	return &winPrivateHandle{h: h}, nil
}

// Only ordinary fixed local NTFS volumes with persistent ACLs are accepted.
// QueryDosDevice rejects SUBST/redirected and ambiguous drive mappings. Final
// path and filesystem facts are observed via the opened object, not a pathname
// security-descriptor lookup. These checks do not lock drive mappings/ancestors.
func winPrivateVolume(h windows.Handle) (string, error) {
	var buf [512]uint16
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0) // normalized DOS name
	if err != nil {
		return "", winPrivateNativeError("private-volume", err)
	}
	if n == 0 || n >= uint32(len(buf)) {
		return "", failure("private-volume", ErrUnsupported)
	}
	final := windows.UTF16ToString(buf[:n])
	if !strings.HasPrefix(final, `\\?\`) {
		return "", failure("private-volume", ErrUnsupported)
	}
	final = final[4:]
	// A volume root is allowed only for this parent-volume observation; public
	// primitive inputs still require a nonempty child below the drive root.
	if !winPrivatePath(final) && !(len(final) == 3 && winPrivatePath(final+"parent")) {
		return "", failure("private-volume", ErrUnsupported)
	}
	device, err := winPrivateDrive(final[:3])
	if err != nil {
		return "", err
	}
	// Compare the handle's actual NT volume to the ordinary drive's device.
	// Otherwise an ancestor mount point could disguise a different/removable
	// volume behind a DRIVE_FIXED drive letter. Reject instead of guessing.
	var native [512]uint16
	n, err = windows.GetFinalPathNameByHandle(h, &native[0], uint32(len(native)), 2) // VOLUME_NAME_NT
	if err != nil || n == 0 || n >= uint32(len(native)) || !strings.HasPrefix(windows.UTF16ToString(native[:n]), device+`\`) {
		return "", failure("private-volume", ErrUnsupported)
	}
	var flags uint32
	var fs [32]uint16
	if err := windows.GetVolumeInformationByHandle(h, nil, 0, nil, nil, &flags, &fs[0], uint32(len(fs))); err != nil {
		return "", winPrivateNativeError("private-volume", err)
	}
	if flags&windows.FILE_PERSISTENT_ACLS == 0 || windows.UTF16ToString(fs[:]) != "NTFS" {
		return "", failure("private-volume", ErrUnsupported)
	}
	return final, nil
}

func winPrivateDrive(root string) (string, error) {
	if len(root) != 3 || !winPrivatePath(root+"volume") {
		return "", failure("private-volume", ErrUnsupported)
	}
	p, err := windows.UTF16PtrFromString(root)
	if err != nil || windows.GetDriveType(p) != windows.DRIVE_FIXED {
		return "", failure("private-volume", ErrUnsupported)
	}
	drive, _ := windows.UTF16PtrFromString(root[:2])
	var target [512]uint16
	n, err := windows.QueryDosDevice(drive, &target[0], uint32(len(target)))
	if err != nil || n == 0 || n >= uint32(len(target)) {
		return "", failure("private-volume", ErrUnsupported)
	}
	name := windows.UTF16ToString(target[:n])
	const prefix = `\Device\HarddiskVolume`
	if !strings.HasPrefix(name, prefix) || len(name) == len(prefix) {
		return "", failure("private-volume", ErrUnsupported)
	}
	for _, c := range name[len(prefix):] {
		if c < '0' || c > '9' {
			return "", failure("private-volume", ErrUnsupported)
		}
	}
	return name, nil
}

// createWinPrivateRoot creates exactly one fresh child of an existing parent.
// The owner and protected two-ACE DACL are supplied to CreateDirectoryW itself.
// An existing name is never treated as our creation and is never rewritten.
// A failure after mkdir can leave a private child; no rollback/delete is tried.
func createWinPrivateRoot(path string) (*winPrivateRoot, error) {
	if !winPrivatePath(path) {
		return nil, failure("private-create", ErrDenied)
	}
	if _, err := winPrivateDrive(path[:3]); err != nil {
		return nil, err
	}
	parent, err := winPrivateOpen(filepath.Dir(path), windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		return nil, err
	}
	_, volumeErr := winPrivateVolume(parent.h)
	closeErr := parent.close()
	if closeErr != nil {
		return nil, closeErr
	}
	if volumeErr != nil {
		return nil, volumeErr
	}
	owner, err := winPrivateProcessSID()
	if err != nil {
		return nil, err
	}
	// SYSTEM process ownership would collapse the two distinct approved trustees.
	if owner.IsWellKnown(windows.WinLocalSystemSid) {
		return nil, failure("private-create", ErrUnsupported)
	}
	sidText := owner.String()
	if sidText == "" {
		return nil, failure("private-create", ErrUnavailable)
	}
	sd, err := windows.SecurityDescriptorFromString("O:" + sidText + "D:P(A;OICI;FA;;;" + sidText + ")(A;OICI;FA;;;SY)")
	if err != nil {
		return nil, winPrivateNativeError("private-create", err)
	}
	// x/sys owns an aligned Go-heap self-relative SD. Its typed pointer remains
	// live across this synchronous call (no uintptr storage or async retention).
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	p, _ := windows.UTF16PtrFromString(path)
	err = windows.CreateDirectory(p, &sa)
	runtime.KeepAlive(sd)
	if err != nil {
		return nil, winPrivateNativeError("private-create", err)
	}
	return winPrivateInspectRoot(path, owner)
}

// inspectWinPrivateRoot validates only; it never repairs an existing descriptor.
func inspectWinPrivateRoot(path string) (*winPrivateRoot, error) {
	if !winPrivatePath(path) {
		return nil, failure("private-root", ErrDenied)
	}
	owner, err := winPrivateProcessSID()
	if err != nil {
		return nil, err
	}
	return winPrivateInspectRoot(path, owner)
}

func winPrivateInspectRoot(path string, owner *windows.SID) (_ *winPrivateRoot, result error) {
	if !winPrivatePath(path) {
		return nil, failure("private-root", ErrDenied)
	}
	if _, err := winPrivateDrive(path[:3]); err != nil {
		return nil, err
	}
	h, err := winPrivateOpen(path, windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		return nil, err
	}
	defer func() {
		if result != nil {
			if err := h.close(); err != nil {
				result = err
			}
		}
	}()
	if err := winPrivateObject(h.h, owner, true); err != nil {
		return nil, err
	}
	canonical, err := winPrivateVolume(h.h)
	if err != nil {
		return nil, err
	}
	return &winPrivateRoot{winPrivateHandle: *h, path: canonical, owner: owner}, nil
}

// openWinPrivateFile opens one existing direct child, with delete sharing (also
// for SQLite sidecars). It never creates/follows a final reparse point. The
// parent path is NOT a handle-relative lookup: same-user/admin/ancestor races
// remain out of scope. The returned handle is the object actually inspected.
func openWinPrivateFile(root *winPrivateRoot, name string) (_ *winPrivateHandle, result error) {
	if root == nil || root.h == 0 || root.h == windows.InvalidHandle || !winPrivatePath(root.path) || name == "" || strings.ContainsAny(name, `\/:`) || !winPrivatePath(root.path+`\`+name) {
		return nil, failure("private-file", ErrDenied)
	}
	h, err := winPrivateOpen(root.path+`\`+name, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.READ_CONTROL)
	if err != nil {
		return nil, err
	}
	defer func() {
		if result != nil {
			if err := h.close(); err != nil {
				result = err
			}
		}
	}()
	if err := winPrivateObject(h.h, root.owner, false); err != nil {
		return nil, err
	}
	if _, err := winPrivateVolume(h.h); err != nil {
		return nil, err
	}
	return h, nil
}

func winPrivateObject(h windows.Handle, owner *windows.SID, directory bool) error {
	kind, err := windows.GetFileType(h)
	if err != nil {
		return winPrivateNativeError("private-inspect", err)
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return winPrivateNativeError("private-inspect", err)
	}
	if kind != windows.FILE_TYPE_DISK || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != directory || (!directory && info.NumberOfLinks != 1) {
		return failure("private-inspect", ErrDenied)
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return winPrivateNativeError("private-inspect", err)
	}
	if sd == nil || !sd.IsValid() || sd.Length() < 20 || sd.Length() > 65536 {
		return failure("private-inspect", ErrDenied)
	}
	// GetSecurityInfo returns a Go-owned, aligned self-relative copy (x/sys frees
	// the native LocalAlloc buffer). Parse bounded offsets, never native SID
	// interior-pointer accessors; those are incompatible with checkptr on Win.
	data := unsafe.Slice((*byte)(unsafe.Pointer(sd)), int(sd.Length()))
	ok := winPrivateDescriptor(data, owner, directory)
	runtime.KeepAlive(sd)
	if !ok {
		return failure("private-inspect", ErrDenied)
	}
	return nil
}

// winPrivateSIDBytes bounds the SID's revision/count before any comparison.
// No account lookup, IdentifierAuthority/SubAuthority APIs, or unsafe uintptr
// round-trip is used anywhere in this implementation.
func winPrivateSIDBytes(b []byte) []byte {
	if len(b) < 8 || b[0] != 1 || b[1] > 15 {
		return nil
	}
	n := 8 + 4*int(b[1])
	if n > len(b) {
		return nil
	}
	return b[:n]
}

func winPrivateDescriptor(b []byte, owner *windows.SID, directory bool) bool {
	if owner == nil || !owner.IsValid() || owner.Len() < 8 || owner.Len() > 68 || owner.IsWellKnown(windows.WinLocalSystemSid) || len(b) < 20 || b[0] != 1 {
		return false
	}
	want := unsafe.Slice((*byte)(unsafe.Pointer(owner)), owner.Len())
	defer runtime.KeepAlive(owner)
	control := windows.SECURITY_DESCRIPTOR_CONTROL(binary.LittleEndian.Uint16(b[2:4]))
	if control&(windows.SE_SELF_RELATIVE|windows.SE_DACL_PRESENT) != windows.SE_SELF_RELATIVE|windows.SE_DACL_PRESENT || (directory && control&windows.SE_DACL_PROTECTED == 0) {
		return false
	}
	ownerOff := uint64(binary.LittleEndian.Uint32(b[4:8]))
	aclOff := uint64(binary.LittleEndian.Uint32(b[16:20]))
	if ownerOff < 20 || ownerOff+8 > uint64(len(b)) || aclOff < 20 || aclOff+8 > uint64(len(b)) {
		return false
	}
	if !bytes.Equal(winPrivateSIDBytes(b[ownerOff:]), want) {
		return false
	}
	acl := b[aclOff:]
	size := int(binary.LittleEndian.Uint16(acl[2:4]))
	if acl[0] != 2 || size < 8 || size > len(acl) || binary.LittleEndian.Uint16(acl[4:6]) != 2 {
		return false
	}
	acl = acl[:size]
	var seenUser, seenSystem bool
	// Well-known LocalSystem SID S-1-5-18, encoded without any account lookup.
	system := []byte{1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0}
	for i, off := 0, 8; i < 2; i++ {
		if off+8 > len(acl) {
			return false
		}
		ace := acl[off:]
		n := int(binary.LittleEndian.Uint16(ace[2:4]))
		if n < 16 || n > len(ace) || ace[0] != windows.ACCESS_ALLOWED_ACE_TYPE || binary.LittleEndian.Uint32(ace[4:8]) != winPrivateFullControl {
			return false
		}
		flags := ace[1]
		if (directory && flags != windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE) || (!directory && flags != 0 && flags != windows.INHERITED_ACE) {
			return false
		}
		sid := winPrivateSIDBytes(ace[8:n])
		if sid == nil || len(sid)+8 != n {
			return false
		}
		switch {
		case bytes.Equal(sid, want) && !seenUser:
			seenUser = true
		case bytes.Equal(sid, system) && !seenSystem:
			seenSystem = true
		default:
			return false
		}
		off += n
		if i == 1 && off != len(acl) {
			return false
		}
	}
	return seenUser && seenSystem
}
