//go:build windows

package process

import (
	"encoding/binary"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// No token/profile/process acquisition in fake cases. All SID fixtures are
// invented, Go-owned test data; only bounded SID BOOL/Len/Copy APIs are used.
type diagFake struct {
	t             *testing.T
	api           diagAPI
	tokens        map[windows.Token]diagSnapshot
	closed        map[windows.Handle]int
	levelsClosed  int
	linkedQueries int
	computed      int
	ids           map[windows.LUID]string
}

func newDiagFake(t *testing.T) *diagFake {
	t.Helper()
	user, err := windows.StringToSid("S-1-5-21-111-222-333-444")
	if err != nil {
		t.Fatal("synthetic SID creation failed")
	}
	base := diagSnapshot{elevationType: 2, elevation: 1, tokenType: 1, session: 987654321, il: 0x3000, user: user, complete: true}
	candidate := base
	candidate.elevationType, candidate.elevation, candidate.il = 3, 0, 0x2000
	candidate.groups[0] = diagGroup{true, windows.SE_GROUP_USE_FOR_DENY_ONLY}
	f := &diagFake{t: t, tokens: map[windows.Token]diagSnapshot{10: base, 11: candidate, 12: candidate}, closed: make(map[windows.Handle]int), ids: map[windows.LUID]string{
		{LowPart: 1}: "SeDebugPrivilege", {LowPart: 2}: "SeChangeNotifyPrivilege", {LowPart: 3}: "SeBackupPrivilege",
	}}
	f.api = diagAPI{
		query: f.query,
		open: func(process windows.Handle, access uint32, out *windows.Token) error {
			if process != windows.CurrentProcess() || access != windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE || *out != 0 {
				t.Fatal("not explicit owned process-primary open")
			}
			*out = 10
			return nil
		},
		createLevel: func(scope, level, flags uint32, out *windows.Handle) error {
			if scope != 2 || level != 0x20000 || flags != 1 || *out != 0 {
				t.Fatal("wrong SAFER constants/output")
			}
			*out = 13
			return nil
		},
		compute: func(level windows.Handle, in windows.Token, out *windows.Token, flags uint32) error {
			f.computed++
			if level != 13 || in != 10 || *out != 0 || flags != 0 {
				t.Fatal("SAFER not independent explicit process input / flags=0")
			}
			*out = 12
			return nil
		},
		closeToken: func(h windows.Handle) error {
			if h != 10 && h != 11 && h != 12 {
				t.Fatal("closed unowned/non-token handle")
			}
			f.closed[h]++
			return nil
		},
		closeLevel: func(h windows.Handle) error {
			if h != 13 {
				t.Fatal("closed non-level with SaferCloseLevel")
			}
			f.levelsClosed++
			return nil
		},
		privilegeIDs: func() (map[windows.LUID]string, error) { return f.ids, nil },
	}
	return f
}

func (f *diagFake) query(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
	s, ok := f.tokens[token]
	if !ok {
		f.t.Fatal("queried unowned fake token")
	}
	if class == windows.TokenLinkedToken {
		f.linkedQueries++
		if out == nil || n != uint32(unsafe.Sizeof(windows.Token(0))) {
			f.t.Fatal("linked token must be a single pointer-sized query")
		}
		*(*windows.Token)(unsafe.Pointer(out)) = 11
		*used = n
		return nil
	}
	var value uint32
	fixed := true
	switch class {
	case windows.TokenElevation:
		value = s.elevation
	case windows.TokenElevationType:
		value = s.elevationType
	case windows.TokenType:
		value = s.tokenType
	case windows.TokenSessionId:
		value = s.session
	default:
		fixed = false
	}
	if fixed {
		if out == nil || n != 4 {
			f.t.Fatal("fixed DWORD probe or wrong size")
		}
		binary.LittleEndian.PutUint32(unsafe.Slice(out, 4), value)
		*used = 4
		return nil
	}
	var header, entry uintptr
	var sidBytes []byte
	var count uintptr
	switch class {
	case windows.TokenIntegrityLevel:
		header = unsafe.Sizeof(windows.Tokenmandatorylabel{})
		sidBytes = candidateSIDBytes(16, 1, s.il)
	case windows.TokenUser:
		header = unsafe.Sizeof(windows.Tokenuser{})
		sidBytes = unsafe.Slice((*byte)(unsafe.Pointer(s.user)), s.user.Len())
	case windows.TokenGroups:
		header = unsafe.Offsetof(windows.Tokengroups{}.Groups)
		entry = unsafe.Sizeof(windows.SIDAndAttributes{})
		for _, g := range s.groups {
			if g.present {
				count++
			}
		}
	case windows.TokenPrivileges:
		header = unsafe.Offsetof(windows.Tokenprivileges{}.Privileges)
		entry = unsafe.Sizeof(windows.LUIDAndAttributes{})
		count = uintptr(len(s.privileges))
	default:
		return windows.ERROR_INVALID_PARAMETER
	}
	needed := header + entry*count + uintptr(len(sidBytes))
	if class == windows.TokenGroups {
		needed += count * 16
	} // builtin SID: S-1-5-32-RID
	*used = uint32(needed)
	if out == nil {
		return windows.ERROR_INSUFFICIENT_BUFFER
	}
	if n != uint32(needed) {
		f.t.Fatal("wrong variable fetch size")
	}
	data := unsafe.Slice(out, int(n))
	clear(data)
	switch class {
	case windows.TokenIntegrityLevel, windows.TokenUser:
		copy(data[header:], sidBytes)
		sid := (*windows.SID)(unsafe.Pointer(&data[header]))
		if class == windows.TokenIntegrityLevel {
			label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(out))
			label.Label.Sid, label.Label.Attributes = sid, windows.SE_GROUP_INTEGRITY
		} else {
			(*windows.Tokenuser)(unsafe.Pointer(out)).User.Sid = sid
		}
	case windows.TokenGroups:
		binary.LittleEndian.PutUint32(data, uint32(count))
		index := uintptr(0)
		for i, g := range s.groups {
			if !g.present {
				continue
			}
			offset := header + entry*count + index*16
			sid := candidateSIDBytes(5, 2, 32)
			rid := uint32(544)
			if i == 1 {
				rid = 547
			}
			binary.LittleEndian.PutUint32(sid[12:16], rid)
			copy(data[offset:], sid)
			p := (*windows.SIDAndAttributes)(unsafe.Pointer(&data[header+index*entry]))
			p.Sid, p.Attributes = (*windows.SID)(unsafe.Pointer(&data[offset])), g.attrs
			index++
		}
	case windows.TokenPrivileges:
		binary.LittleEndian.PutUint32(data, uint32(count))
		for i, p := range s.privileges {
			id := windows.LUID{LowPart: 999} // unknown privilege, never dump its LUID
			for candidate, name := range f.ids {
				if name == p.name {
					id = candidate
				}
			}
			entryOut := (*windows.LUIDAndAttributes)(unsafe.Pointer(&data[header+uintptr(i)*entry]))
			entryOut.Luid, entryOut.Attributes = id, p.attrs
		}
	}
	return nil
}

func TestWindowsTokenDiagnosticFakeDWORD(t *testing.T) {
	for _, class := range []uint32{20, 18, 8, 12} {
		for _, used := range []uint32{0, 1, 3, 4, 5, 8, 65537, ^uint32(0)} {
			calls := 0
			value, err := diagDWORD(10, class, func(token windows.Token, c uint32, out *byte, n uint32, ret *uint32) error {
				calls++
				if token != 10 || c != class || out == nil || n != 4 || uintptr(unsafe.Pointer(out))%4 != 0 {
					t.Fatal("not exact aligned DWORD call")
				}
				*(*uint32)(unsafe.Pointer(out)) = 42
				*ret = used
				return nil
			})
			if calls != 1 || (err == nil) != (used == 4) || (err == nil && value != 42) {
				t.Fatalf("DWORD contract class=%d used=%d calls=%d", class, used, calls)
			}
		}
		calls := 0
		_, err := diagDWORD(10, class, func(windows.Token, uint32, *byte, uint32, *uint32) error { calls++; return windows.ERROR_BAD_LENGTH })
		if err == nil || calls != 1 {
			t.Fatal("DWORD failure retried/accepted")
		}
	}
	for _, class := range []uint32{0, 19, 25, 29, 46} {
		_, err := diagDWORD(10, class, func(windows.Token, uint32, *byte, uint32, *uint32) error {
			t.Fatal("expanded diagnostic DWORD allowlist")
			return nil
		})
		if err == nil {
			t.Fatal("non-diagnostic class accepted")
		}
	}
}

func TestWindowsTokenDiagnosticFakeVariable(t *testing.T) {
	for _, mode := range []string{"zero", "oversize", "unexpected-success", "probe-denied", "fetch-denied", "shrink", "overreport", "changed-size", "exact"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			_, err := diagVariable(10, windows.TokenUser, func(_ windows.Token, _ uint32, out *byte, n uint32, used *uint32) error {
				calls++
				if out == nil {
					*used = 16
					switch mode {
					case "zero":
						*used = 0
					case "oversize":
						*used = 65537
					case "unexpected-success":
						return nil
					case "probe-denied":
						return windows.ERROR_ACCESS_DENIED
					}
					return windows.ERROR_INSUFFICIENT_BUFFER
				}
				if calls != 2 || n != 16 || uintptr(unsafe.Pointer(out))%unsafe.Alignof(uintptr(0)) != 0 {
					t.Fatal("variable query extent/alignment/retry")
				}
				*used = n
				switch mode {
				case "fetch-denied":
					return windows.ERROR_ACCESS_DENIED
				case "changed-size":
					return windows.ERROR_INSUFFICIENT_BUFFER
				case "shrink":
					*used--
				case "overreport":
					*used++
				}
				return nil
			})
			if (err == nil) != (mode == "exact") || calls > 2 {
				t.Fatal("variable query did not fail closed")
			}
		})
	}
}

func TestWindowsTokenDiagnosticFakeQualification(t *testing.T) {
	for _, tc := range []struct {
		name   string
		edit   func(*diagSnapshot)
		reason string
	}{
		{"valid", func(*diagSnapshot) {}, ""},
		{"incomplete", func(s *diagSnapshot) { s.complete = false }, "incomplete-inspection"},
		{"impersonation", func(s *diagSnapshot) { s.tokenType = 2 }, "not-primary"},
		{"elevated", func(s *diagSnapshot) { s.elevation = 1 }, "elevation-not-exact-zero"},
		{"noncanonical-elevation", func(s *diagSnapshot) { s.elevation = 2 }, "elevation-not-exact-zero"},
		{"unknown-type", func(s *diagSnapshot) { s.elevationType = 0 }, "invalid-elevation-type"},
		{"linked-full", func(s *diagSnapshot) { s.elevationType = 2 }, "linked-not-limited"},
		{"low-not-medium", func(s *diagSnapshot) { s.il = 0x1000 }, "not-exact-medium-IL"},
		{"high", func(s *diagSnapshot) { s.il = 0x3000 }, "not-exact-medium-IL"},
		{"missing-user", func(s *diagSnapshot) { s.user = nil }, "user-mismatch"},
		{"session", func(s *diagSnapshot) { s.session++ }, "session-mismatch"},
		{"admin-disabled-not-deny-only", func(s *diagSnapshot) { s.groups[0] = diagGroup{true, 0} }, "administrative-SID-not-deny-only"},
		{"power-user-enabled", func(s *diagSnapshot) { s.groups[1] = diagGroup{true, windows.SE_GROUP_ENABLED} }, "administrative-SID-not-deny-only"},
		{"contradictory-deny-enabled", func(s *diagSnapshot) { s.groups[0].attrs |= windows.SE_GROUP_ENABLED }, "administrative-SID-not-deny-only"},
		{"admin-privilege", func(s *diagSnapshot) { s.enabledAdmin = true }, "enabled-administrative-privilege"},
		{"unknown-privilege", func(s *diagSnapshot) { s.unknownEnabled = true }, "unclassified-enabled-privilege"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newDiagFake(t)
			s := f.tokens[11]
			tc.edit(&s)
			why := strings.Join(diagQualify(s, f.tokens[10], true), ",")
			if (tc.reason == "" && why != "") || (tc.reason != "" && !strings.Contains(why, tc.reason)) {
				t.Fatalf("qualification missing expected reason %s", tc.reason)
			}
		})
	}
	f := newDiagFake(t)
	other, err := windows.StringToSid("S-1-5-21-999-888-777-666")
	if err != nil {
		t.Fatal("synthetic SID creation failed")
	}
	s := f.tokens[11]
	s.user = other
	if !strings.Contains(strings.Join(diagQualify(s, f.tokens[10], true), ","), "user-mismatch") {
		t.Fatal("different user passed")
	}
}

func TestWindowsTokenDiagnosticFakeInspect(t *testing.T) {
	for _, mode := range []string{"good", "traverse-enabled", "debug-disabled-backup-enabled", "unknown-enabled", "user-outside", "user-truncated", "user-revision", "groups-count", "groups-overlap", "groups-unaligned", "groups-outside", "priv-count", "priv-duplicate", "IL-authority", "IL-count"} {
		t.Run(mode, func(t *testing.T) {
			f := newDiagFake(t)
			s := f.tokens[11]
			switch mode {
			case "traverse-enabled":
				s.privileges = []diagPrivilege{{"SeChangeNotifyPrivilege", windows.SE_PRIVILEGE_ENABLED}}
			case "debug-disabled-backup-enabled":
				s.privileges = []diagPrivilege{{"SeDebugPrivilege", 0}, {"SeBackupPrivilege", windows.SE_PRIVILEGE_ENABLED}}
			case "unknown-enabled":
				s.privileges = []diagPrivilege{{"unknown", windows.SE_PRIVILEGE_ENABLED}}
			case "priv-duplicate":
				s.privileges = []diagPrivilege{{"SeDebugPrivilege", 0}, {"SeDebugPrivilege", 0}}
			}
			f.tokens[11] = s
			f.api.query = func(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
				err := f.query(token, class, out, n, used)
				if err != nil || out == nil {
					return err
				}
				data := unsafe.Slice(out, int(n))
				if class == windows.TokenUser {
					p := (*windows.Tokenuser)(unsafe.Pointer(out))
					switch mode {
					case "user-outside":
						p.User.Sid = s.user
					case "user-truncated":
						unsafe.Slice((*byte)(unsafe.Pointer(p.User.Sid)), 8)[1] = 15
					case "user-revision":
						*(*byte)(unsafe.Pointer(p.User.Sid)) = 2
					}
				}
				if class == windows.TokenGroups {
					p := (*windows.SIDAndAttributes)(unsafe.Pointer(&data[unsafe.Offsetof(windows.Tokengroups{}.Groups)]))
					switch mode {
					case "groups-count":
						binary.LittleEndian.PutUint32(data, ^uint32(0))
					case "groups-overlap":
						p.Sid = (*windows.SID)(unsafe.Pointer(p))
					case "groups-unaligned":
						p.Sid = (*windows.SID)(unsafe.Add(unsafe.Pointer(p.Sid), 1))
					case "groups-outside":
						p.Sid = s.user
					}
				}
				if class == windows.TokenPrivileges && mode == "priv-count" {
					binary.LittleEndian.PutUint32(data, ^uint32(0))
				}
				if class == windows.TokenIntegrityLevel {
					p := (*windows.Tokenmandatorylabel)(unsafe.Pointer(out))
					raw := unsafe.Slice((*byte)(unsafe.Pointer(p.Label.Sid)), 12)
					if mode == "IL-authority" {
						raw[7] = 5
					}
					if mode == "IL-count" {
						raw[1] = 2
					}
				}
				return nil
			}
			got, err := diagInspect(11, f.api, f.ids)
			expectParse := mode == "good" || mode == "traverse-enabled" || mode == "debug-disabled-backup-enabled" || mode == "unknown-enabled"
			if (err == nil) != expectParse {
				t.Fatalf("parser status wrong for %s", mode)
			}
			if err == nil {
				why := diagQualify(got, f.tokens[10], true)
				wantEligible := mode == "good" || mode == "traverse-enabled"
				if (len(why) == 0) != wantEligible {
					t.Fatal("privilege classification did not fail closed")
				}
				if got.user == s.user || !got.user.Equals(s.user) {
					t.Fatal("user SID not independently copied")
				}
			}
		})
	}
}

func TestWindowsTokenDiagnosticFakeRunOwnershipAndOutput(t *testing.T) {
	for _, mode := range []string{"good", "Default-no-link", "linked-rejected", "safer-rejected", "both-rejected", "linked-query-error", "linked-short", "linked-null", "safer-create-error", "safer-compute-error", "safer-null", "token-close-error", "level-close-error", "open-error-with-output", "current-inspect-error", "linked-inspect-error", "safer-inspect-error"} {
		t.Run(mode, func(t *testing.T) {
			f := newDiagFake(t)
			if mode == "Default-no-link" {
				s := f.tokens[10]
				s.elevationType = 1
				f.tokens[10] = s
			}
			if mode == "linked-rejected" || mode == "both-rejected" {
				s := f.tokens[11]
				s.elevation = 1
				f.tokens[11] = s
			}
			if mode == "safer-rejected" || mode == "both-rejected" {
				s := f.tokens[12]
				s.il = 0x3000
				f.tokens[12] = s
			}
			if strings.HasPrefix(mode, "linked-") && mode != "linked-rejected" {
				f.api.query = func(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
					err := f.query(token, class, out, n, used)
					if class == windows.TokenLinkedToken {
						switch mode {
						case "linked-query-error":
							return windows.ERROR_ACCESS_DENIED // output still owned
						case "linked-short":
							*used--
						case "linked-null":
							*(*windows.Token)(unsafe.Pointer(out)) = 0
						}
					}
					return err
				}
			}
			if strings.HasSuffix(mode, "-inspect-error") {
				target := windows.Token(10)
				if mode == "linked-inspect-error" {
					target = 11
				}
				if mode == "safer-inspect-error" {
					target = 12
				}
				original := f.api.query
				f.api.query = func(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
					if token == target && class == windows.TokenUser {
						return windows.ERROR_ACCESS_DENIED
					}
					return original(token, class, out, n, used)
				}
			}
			if mode == "safer-create-error" {
				original := f.api.createLevel
				f.api.createLevel = func(a, b, c uint32, out *windows.Handle) error {
					_ = original(a, b, c, out)
					return windows.ERROR_ACCESS_DENIED
				}
			}
			if mode == "safer-compute-error" || mode == "safer-null" {
				original := f.api.compute
				f.api.compute = func(level windows.Handle, in windows.Token, out *windows.Token, flags uint32) error {
					_ = original(level, in, out, flags)
					if mode == "safer-null" {
						*out = 0
						return nil
					}
					return windows.ERROR_ACCESS_DENIED // output still owned
				}
			}
			if mode == "token-close-error" {
				original := f.api.closeToken
				f.api.closeToken = func(h windows.Handle) error { _ = original(h); return windows.ERROR_ACCESS_DENIED }
			}
			if mode == "level-close-error" {
				original := f.api.closeLevel
				f.api.closeLevel = func(h windows.Handle) error { _ = original(h); return windows.ERROR_ACCESS_DENIED }
			}
			if mode == "open-error-with-output" {
				original := f.api.open
				f.api.open = func(h windows.Handle, a uint32, out *windows.Token) error {
					_ = original(h, a, out)
					return windows.ERROR_ACCESS_DENIED
				}
			}
			var logs []string
			err := diagRun(f.api, func(line string) { logs = append(logs, line) })
			wantSuccess := mode == "good" || mode == "Default-no-link" || mode == "linked-rejected" || mode == "safer-rejected"
			if (err == nil) != wantSuccess {
				t.Fatalf("run result incorrect for %s", mode)
			}
			if f.closed[10] != 1 {
				t.Fatal("owned process token not closed exactly once")
			}
			if mode == "open-error-with-output" {
				if f.computed != 0 || f.linkedQueries != 0 || f.levelsClosed != 0 {
					t.Fatal("continued after open failure")
				}
				return
			}
			wantLinkedClose := 1
			if mode == "Default-no-link" || mode == "linked-null" {
				wantLinkedClose = 0
			}
			if f.closed[11] != wantLinkedClose {
				t.Fatal("linked token ownership not closed exactly once")
			}
			wantSaferClose := 1
			if mode == "safer-null" || mode == "safer-create-error" {
				wantSaferClose = 0
			}
			if f.closed[12] != wantSaferClose || f.levelsClosed != 1 {
				t.Fatal("SAFER token vs level lifetime incorrect")
			}
			if mode == "Default-no-link" && f.linkedQueries != 0 {
				t.Fatal("queried link for Default source")
			}
			if mode != "safer-create-error" && f.computed != 1 {
				t.Fatal("SAFER candidate not attempted independently")
			}
			joined := strings.Join(logs, "\n")
			if !strings.Contains(joined, "UAC-linked") || !strings.Contains(joined, "SAFER-NORMALUSER") {
				t.Fatal("did not report both candidates")
			}
			for _, secret := range []string{"S-1-5-21-111-222-333-444", "987654321", "111-222", "session=", "sessionId=", "0xc000"} {
				if strings.Contains(joined, secret) {
					t.Fatal("diagnostic leaked identity/session/address")
				}
			}
			if mode == "good" && !strings.Contains(joined, "preferred=verified-UAC-linked") {
				t.Fatal("did not prefer verified linked candidate")
			}
		})
	}
}

func TestWindowsTokenDiagnosticFakeStickyCloseAndBOOL(t *testing.T) {
	calls := 0
	o := diagOwned{h: 10, close: func(windows.Handle) error { calls++; return windows.ERROR_ACCESS_DENIED }}
	first := o.release()
	if first == nil || o.release() != first || calls != 1 {
		t.Fatal("close failure not sticky/idempotent")
	}
	for _, h := range []windows.Handle{0, windows.Handle(^uintptr(0)), windows.Handle(^uintptr(0) - 3)} {
		o := diagOwned{h: h, close: func(windows.Handle) error { t.Fatal("closed null/reserved pseudo handle"); return nil }}
		if err := o.release(); err != nil {
			t.Fatal("unowned release should be inert")
		}
	}
	if diagBOOL("fake", 1, windows.ERROR_ACCESS_DENIED) != nil {
		t.Fatal("BOOL success used stale error")
	}
	if diagBOOL("fake", 0, windows.ERROR_SUCCESS) == nil {
		t.Fatal("BOOL false with LastError zero passed")
	}
	if diagBOOL("fake", 0x80000000, nil) != nil {
		t.Fatal("BOOL was treated as HRESULT")
	}
}

func TestWindowsTokenDiagnosticFakePrerequisitesAndLayouts(t *testing.T) {
	for _, tc := range []struct {
		opt, actions, environment, runnerOS string
		skip, fail                          bool
	}{
		{skip: true},
		{opt: "1", actions: "true", environment: "github-hosted", runnerOS: "Windows"},
		{actions: "true", environment: "github-hosted", runnerOS: "Windows", fail: true},
		{opt: "0", actions: "true", environment: "github-hosted", runnerOS: "Windows", fail: true},
		{opt: "1", fail: true},
		{opt: "1", actions: "true", environment: "self-hosted", runnerOS: "Windows", fail: true},
		{opt: "1", actions: "true", environment: "github-hosted", runnerOS: "Linux", fail: true},
		{opt: "1", actions: "True", environment: "github-hosted", runnerOS: "Windows", fail: true},
		{environment: "github-hosted", runnerOS: "Windows", fail: true},
	} {
		skip, err := diagCIPrerequisite(tc.opt, tc.actions, tc.environment, tc.runnerOS)
		if skip != tc.skip || (err != nil) != tc.fail {
			t.Fatal("CI prerequisite skipped/accepted invalid explicit request")
		}
	}
	if windows.TokenElevation != 20 || windows.TokenElevationType != 18 || windows.TokenType != 8 || windows.TokenSessionId != 12 || windows.TokenLinkedToken != 19 || windows.TokenIntegrityLevel != 25 {
		t.Fatal("TOKEN_INFORMATION_CLASS constants differ from SDK")
	}
	word := unsafe.Sizeof(uintptr(0))
	if unsafe.Sizeof(windows.Token(0)) != word || unsafe.Offsetof(windows.SIDAndAttributes{}.Attributes) != word || unsafe.Sizeof(windows.SIDAndAttributes{}) != 2*word || unsafe.Offsetof(windows.Tokengroups{}.Groups) != word || unsafe.Offsetof(windows.Tokenprivileges{}.Privileges) != 4 || unsafe.Sizeof(windows.LUIDAndAttributes{}) != 12 {
		t.Fatal("SDK token array/pointer layout mismatch")
	}
}
