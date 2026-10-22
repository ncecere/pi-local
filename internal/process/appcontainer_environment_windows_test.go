//go:build windows

package process

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Test-only selected metadata, not a runtime environment builder. In particular,
// this never restores the parent environment or loads a user profile.
const (
	candidateEnvironmentUnits      = 64 * 1024 / 2 // 64 KiB, in UTF-16 code units
	candidateEnvironmentEntryUnits = 8192
	candidateEnvironmentEntries    = 1024
)

type candidateEnvironmentSelection struct{ root, local string }
type candidateEnvironmentLegacy struct{ present, nonempty, absolute, equal bool }
type candidateEnvironmentAPI struct {
	root        func() (string, error)
	lookup      func(string) (string, bool)
	create      func(**uint16, windows.Token, bool) error
	destroy     func(*uint16) error
	selectBlock func(*uint16) (candidateEnvironmentSelection, error)
}

func candidateEnvironmentNativeAPI(t *testing.T) (candidateEnvironmentAPI, error) {
	t.Helper()
	candidateRequireEphemeralWindowsCI(t)
	// Own bindings, SystemDLL resolution, required exports, BOOL not HRESULT.
	// GetSystemWindowsDirectoryW is already wrapped by pinned x/sys v0.49.0.
	// https://learn.microsoft.com/windows/win32/api/userenv/nf-userenv-createenvironmentblock
	// https://learn.microsoft.com/windows/win32/api/userenv/nf-userenv-destroyenvironmentblock
	dll := windows.NewLazySystemDLL("userenv.dll")
	create, destroy := dll.NewProc("CreateEnvironmentBlock"), dll.NewProc("DestroyEnvironmentBlock")
	if create.Find() != nil || destroy.Find() != nil {
		return candidateEnvironmentAPI{}, errors.New("required environment API unavailable")
	}
	return candidateEnvironmentAPI{
		root: windows.GetSystemWindowsDirectory, lookup: os.LookupEnv,
		create: func(out **uint16, token windows.Token, inherit bool) error {
			if inherit {
				return errors.New("environment inheritance refused")
			}
			r, _, _ := create.Call(uintptr(unsafe.Pointer(out)), uintptr(token), 0)
			runtime.KeepAlive(out)
			return candidateEnvironmentBOOL(r)
		},
		destroy: func(block *uint16) error {
			r, _, _ := destroy.Call(uintptr(unsafe.Pointer(block)))
			runtime.KeepAlive(block)
			return candidateEnvironmentBOOL(r)
		},
		selectBlock: candidateSelectNativeEnvironment,
	}, nil
}

func candidateEnvironmentBOOL(result uintptr) error {
	if uint32(result) == 0 {
		return errors.New("environment API returned FALSE")
	}
	return nil // never interpret BOOL as HRESULT or expose a last-error payload
}

// The API documents a well-formed, double-NUL-terminated native allocation but
// supplies NO byte length. This cap limits work, not a proof of allocation size.
// Never use this reader for fake/Go storage: those tests use a bounded slice.
func candidateSelectNativeEnvironment(block *uint16) (candidateEnvironmentSelection, error) {
	if block == nil {
		return candidateEnvironmentSelection{}, errors.New("nil environment block")
	}
	defer runtime.KeepAlive(block)
	return candidateSelectEnvironment(func(i int) (uint16, bool) {
		if i < 0 || i >= candidateEnvironmentUnits {
			return 0, false
		}
		return *(*uint16)(unsafe.Add(unsafe.Pointer(block), uintptr(i)*2)), true
	})
}

// Only selected names/values are copied. Unknown values are scanned in place,
// never converted to strings, accumulated in a map, logged or returned.
func candidateSelectEnvironment(read func(int) (uint16, bool)) (candidateEnvironmentSelection, error) {
	var selected candidateEnvironmentSelection
	fail := func() (candidateEnvironmentSelection, error) {
		return candidateEnvironmentSelection{}, errors.New("environment block malformed, incomplete or oversized")
	}
	at := func(i int) (uint16, bool) {
		if i < 0 || i >= candidateEnvironmentUnits {
			return 0, false
		}
		return read(i)
	}
	nameEqual := func(start, end int, name string) bool {
		if end-start != len(name) {
			return false
		}
		for j := range len(name) {
			c, ok := at(start + j)
			if c >= 'a' && c <= 'z' {
				c -= 'a' - 'A'
			}
			if !ok || c != uint16(name[j]) {
				return false
			}
		}
		return true
	}
	start := 0
	for count := 0; count <= candidateEnvironmentEntries; count++ {
		first, ok := at(start)
		if !ok {
			return fail()
		}
		if first == 0 {
			// A nonempty entry's terminator was consumed by the previous pass.
			// Empty blocks still need both NULs (and will fail selected checks).
			if start == 0 {
				if next, ok := at(1); !ok || next != 0 {
					return fail()
				}
			}
			if selected.root == "" || selected.local == "" {
				return fail()
			}
			return selected, nil
		}
		if count == candidateEnvironmentEntries {
			return fail()
		}
		separator, end, high := -1, start, false
		for ; ; end++ {
			if end-start >= candidateEnvironmentEntryUnits {
				return fail()
			}
			c, ok := at(end)
			if !ok {
				return fail()
			}
			if c == 0 {
				if high {
					return fail()
				}
				break
			}
			if high {
				if c < 0xdc00 || c > 0xdfff {
					return fail()
				}
				high = false
			} else if c >= 0xd800 && c <= 0xdbff {
				high = true
			} else if c >= 0xdc00 && c <= 0xdfff {
				return fail()
			}
			// Windows may include hidden drive entries such as =Z:=Z:\\.
			if c == '=' && end > start && separator < 0 {
				separator = end
			}
		}
		if separator < 0 {
			return fail()
		}
		var out *string
		switch {
		case nameEqual(start, separator, "SYSTEMROOT"):
			out = &selected.root
		case nameEqual(start, separator, "LOCALAPPDATA"):
			out = &selected.local
		}
		if out != nil {
			if *out != "" || separator+1 == end {
				return fail()
			}
			value := make([]uint16, end-separator-1)
			for i := range value {
				c, ok := at(separator + 1 + i)
				if !ok {
					return fail()
				}
				value[i] = c
			}
			*out = string(utf16.Decode(value))
		}
		start = end + 1
	}
	return fail()
}

// Conservative local, fully qualified DOS paths only; no UNC/device namespace,
// expansion placeholders, drive-relative paths or ambiguous dot components.
// This inspects metadata strings, never filesystem contents or registry data.
func candidateEnvironmentPath(value string) (string, bool) {
	if len(value) > candidateEnvironmentEntryUnits || !utf8.ValidString(value) {
		return "", false
	}
	value = strings.ReplaceAll(value, "/", "\\")
	if len(value) <= 3 || !filepath.IsAbs(value) || len(filepath.VolumeName(value)) != 2 || value[1] != ':' || value[2] != '\\' || !((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) {
		return "", false
	}
	if !filepath.IsLocal(value[3:]) || strings.ContainsAny(value[2:], ":<>\"|?*%") {
		return "", false
	}
	for _, c := range value {
		if c < 32 {
			return "", false
		}
	}
	for _, part := range strings.Split(value[3:], "\\") {
		if part == "" || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return "", false
		}
		// IsLocal delegates device names with extensions to a native query
		// whose answer varies by Windows version. Keep this conservative
		// metadata policy independent of that answer, including spaced bases.
		base, _, _ := strings.Cut(strings.ToUpper(part), ".")
		base = strings.TrimRight(base, " ")
		switch base {
		case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
			return "", false
		}
		letters := []rune(base)
		if len(letters) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && strings.ContainsRune("123456789¹²³", letters[3]) {
			return "", false
		}
	}
	return filepath.Clean(value), true
}

type candidateEnvironmentOwner struct {
	block    *uint16
	destroy  func(*uint16) error
	released bool
	err      error
}

func (o *candidateEnvironmentOwner) close() error {
	if !o.released {
		o.released = true // no retry of a possibly recycled allocation
		if o.block != nil && o.destroy(o.block) != nil {
			o.err = errors.New("environment block destruction failed")
		}
		o.block = nil
	}
	return o.err // sticky and redacted
}

// Must finish successfully, including destruction, BEFORE provisioning profiles.
// The derived token remains borrowed and live throughout; bInherit is FALSE.
func candidatePrepareEnvironment(token windows.Token, api candidateEnvironmentAPI) (selected candidateEnvironmentSelection, legacy candidateEnvironmentLegacy, err error) {
	if !candidateRealToken(token) || api.root == nil || api.lookup == nil || api.create == nil || api.destroy == nil || api.selectBlock == nil {
		return selected, legacy, errors.New("environment dependencies/token refused")
	}
	root, rootErr := api.root()
	root, valid := candidateEnvironmentPath(root)
	if rootErr != nil || !valid {
		return selected, legacy, errors.New("authoritative OS root unavailable or invalid")
	}
	old, present := api.lookup("SystemRoot") // one legacy variable, never GetAll
	oldAbsolute := filepath.IsAbs(old)       // observation, not selected-path validation
	oldPath := filepath.Clean(strings.ReplaceAll(old, "/", "\\"))
	legacy = candidateEnvironmentLegacy{present, present && old != "", oldAbsolute, oldAbsolute && strings.EqualFold(oldPath, root)}
	o := candidateEnvironmentOwner{destroy: api.destroy}
	defer func() {
		err = errors.Join(err, o.close())
		if err != nil {
			selected = candidateEnvironmentSelection{}
		}
	}()
	createErr := api.create(&o.block, token, false)
	// Even a nonnil partial out pointer is owned and released once, never parsed
	// on failure. API errors are deliberately not formatted (may contain data).
	if createErr != nil || o.block == nil {
		return selected, legacy, errors.New("derived environment creation failed")
	}
	parsed, parseErr := api.selectBlock(o.block)
	if parseErr != nil {
		return selected, legacy, errors.New("derived environment selection refused")
	}
	blockRoot, rootOK := candidateEnvironmentPath(parsed.root)
	local, localOK := candidateEnvironmentPath(parsed.local)
	if !rootOK || !localOK || !strings.EqualFold(blockRoot, root) {
		return selected, legacy, errors.New("selected OS environment paths refused")
	}
	return candidateEnvironmentSelection{root: root, local: local}, legacy, nil
}

func (s candidateEnvironmentSelection) target(dir string) ([]string, error) {
	if _, ok := candidateEnvironmentPath(s.root); !ok {
		return nil, errors.New("target root refused")
	}
	if _, ok := candidateEnvironmentPath(s.local); !ok {
		return nil, errors.New("target local metadata refused")
	}
	if _, ok := candidateEnvironmentPath(dir); !ok {
		return nil, errors.New("synthetic job directory refused")
	}
	return []string{"SystemRoot=" + s.root, "LOCALAPPDATA=" + s.local, "PL_WINDOWS_JOB_HELPER=1", "PL_WINDOWS_JOB_MODE=hold", "PL_WINDOWS_JOB_DIR=" + dir}, nil
}
