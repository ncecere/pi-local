//go:build windows

package process

import (
	"errors"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"testing"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

// All paths, keys and payloads here are synthetic. No native environment API is
// reachable from these fakes, including missing-dependency and malformed tests.
const (
	candidateFakeRoot   = `Z:\SyntheticOS`
	candidateFakeLocal  = `Y:\Fixture\SelectedLocal`
	candidateFakeJob    = `X:\Fixture\Job`
	candidateFakeSecret = "not-forwarded-synthetic-payload"
)

func candidateFakeEnvironment(entries ...string) []uint16 {
	var block []uint16
	for _, entry := range entries {
		block = append(block, utf16.Encode([]rune(entry))...)
		block = append(block, 0)
	}
	if len(block) == 0 {
		block = append(block, 0)
	}
	return append(block, 0)
}
func candidateSelectEnvironmentSlice(block []uint16) (candidateEnvironmentSelection, error) {
	return candidateSelectEnvironment(func(i int) (uint16, bool) {
		// This explicit bound is required: no raw-pointer/slice overread model.
		if i < 0 || i >= len(block) {
			return 0, false
		}
		return block[i], true
	})
}
func candidateFakeEnvironmentAPI(t *testing.T, block []uint16) (candidateEnvironmentAPI, *int) {
	t.Helper()
	deletes := new(int)
	api := candidateEnvironmentAPI{
		root: func() (string, error) { return candidateFakeRoot, nil },
		lookup: func(key string) (string, bool) {
			if key != "SystemRoot" {
				t.Fatal("lookup escaped legacy single-key scope")
			}
			return `z:\syntheticos`, true
		},
		create: func(out **uint16, token windows.Token, inherit bool) error {
			if *out != nil || token != windows.Token(123) || inherit {
				t.Fatal("wrong derived token, nonnull out or inheritance")
			}
			*out = &block[0]
			return nil
		},
		destroy: func(p *uint16) error {
			(*deletes)++
			if p != &block[0] {
				t.Fatal("destroyed different environment allocation")
			}
			clear(block) // selected copies must survive destruction
			return nil
		},
		selectBlock: func(p *uint16) (candidateEnvironmentSelection, error) {
			if p != &block[0] {
				t.Fatal("parsed different environment allocation")
			}
			return candidateSelectEnvironmentSlice(block)
		},
	}
	return api, deletes
}

func TestWindowsAppContainerEnvironmentSelectedOnly(t *testing.T) {
	entries := []string{"sYsTeMrOoT=z:\\syntheticos", "localappdata=" + candidateFakeLocal}
	for _, key := range []string{"FakeSecret", "PATH", "COMSPEC", "TEMP", "TMP", "USERNAME", "USERPROFILE", "APPDATA", "PROVIDER_API_KEY", "GOFLAGS", "__COMPAT_LAYER", "PL_WINDOWS_JOB_MODE"} {
		entries = append(entries, key+"="+candidateFakeSecret)
	}
	entries = append(entries, `=Z:=Z:\SyntheticDrive`)
	block := candidateFakeEnvironment(entries...)
	api, deletes := candidateFakeEnvironmentAPI(t, block)
	selected, legacy, err := candidatePrepareEnvironment(123, api)
	if err != nil || *deletes != 1 {
		t.Fatal("selected preparation/destruction failed")
	}
	if selected.root != candidateFakeRoot || selected.local != candidateFakeLocal {
		t.Fatal("mapping did not use authoritative root and selected OS metadata")
	}
	if legacy != (candidateEnvironmentLegacy{true, true, true, true}) {
		t.Fatal("legacy boolean observation mismatch")
	}
	env, err := selected.target(candidateFakeJob)
	want := []string{"SystemRoot=" + candidateFakeRoot, "LOCALAPPDATA=" + candidateFakeLocal, "PL_WINDOWS_JOB_HELPER=1", "PL_WINDOWS_JOB_MODE=hold", "PL_WINDOWS_JOB_DIR=" + candidateFakeJob}
	if err != nil || !slices.Equal(env, want) || len(env) != 5 {
		t.Fatal("target five-key allowlist mismatch")
	}
	for _, entry := range env {
		if strings.Contains(entry, candidateFakeSecret) {
			t.Fatal("unknown value forwarded")
		}
	}
	// Inspect the existing launch descriptor's exact Unicode payload without
	// starting anything or logging names/values. SystemRoot is explicit, so its
	// production default cannot silently supply a parent value here.
	probe, err := os.Executable() // this test image, no PATH search or execution
	if err != nil {
		t.Fatal("test image unavailable")
	}
	cmd := &exec.Cmd{Path: probe, Args: []string{probe}, Dir: candidateFakeJob, Env: env}
	d, err := windowsDescriptor(cmd)
	if err != nil {
		t.Fatal("five-key descriptor construction failed")
	}
	if len(d.env) < 2 || d.env[len(d.env)-1] != 0 || d.env[len(d.env)-2] != 0 {
		t.Fatal("descriptor lacks double NUL")
	}
	// Only synthetic five-key data reaches this decoding; never an OS block.
	parts := strings.Split(string(utf16.Decode(d.env)), "\x00")
	if len(parts) != 7 || parts[5] != "" || parts[6] != "" {
		t.Fatal("descriptor entry count/termination mismatch")
	}
	got, sortedWant := slices.Clone(parts[:5]), slices.Clone(want)
	slices.Sort(got)
	slices.Sort(sortedWant)
	if !slices.Equal(got, sortedWant) {
		t.Fatal("descriptor changed the allowlist or values")
	}
}

func TestWindowsAppContainerEnvironmentBoundedParser(t *testing.T) {
	valid := func(extra ...string) []uint16 {
		return candidateFakeEnvironment(append([]string{"SystemRoot=" + candidateFakeRoot, "LOCALAPPDATA=" + candidateFakeLocal}, extra...)...)
	}
	tooMany := []string{"SystemRoot=" + candidateFakeRoot, "LOCALAPPDATA=" + candidateFakeLocal}
	for range candidateEnvironmentEntries {
		tooMany = append(tooMany, "Unknown=value")
	}
	oversizedBlock := valid()
	oversizedBlock = oversizedBlock[:len(oversizedBlock)-1]
	for range 8 {
		entry := candidateFakeEnvironment("Unknown=" + strings.Repeat("x", 5000))
		oversizedBlock = append(oversizedBlock, entry[:len(entry)-1]...)
	}
	oversizedBlock = append(oversizedBlock, 0) // well formed, but beyond the scan cap
	for _, tc := range []struct {
		name  string
		block []uint16
		good  bool
	}{
		{"selected", valid(), true},
		{"case", candidateFakeEnvironment("SYSTEMROOT="+candidateFakeRoot, "LocalAppData="+candidateFakeLocal), true},
		{"unknown-excluded", valid("FakeSecret=" + candidateFakeSecret), true},
		{"hidden-drive", valid(`=Z:=Z:\Fixture`), true},
		{"duplicate-root", valid("sYstEmRoot=" + candidateFakeRoot), false},
		{"duplicate-local", valid("localappdata=" + candidateFakeLocal), false},
		{"empty-root", candidateFakeEnvironment("SystemRoot=", "LOCALAPPDATA="+candidateFakeLocal), false},
		{"empty-local", candidateFakeEnvironment("SystemRoot="+candidateFakeRoot, "LOCALAPPDATA="), false},
		{"missing-root", candidateFakeEnvironment("LOCALAPPDATA=" + candidateFakeLocal), false},
		{"missing-local", candidateFakeEnvironment("SystemRoot=" + candidateFakeRoot), false},
		{"no-slice", nil, false}, {"one-nul", []uint16{0}, false}, {"empty", []uint16{0, 0}, false},
		{"missing-second-nul", func() []uint16 { b := valid(); return b[:len(b)-1] }(), false},
		{"missing-entry-nul", utf16.Encode([]rune("SystemRoot=" + candidateFakeRoot)), false},
		{"malformed-unknown", valid("FakeSecret-no-separator"), false},
		{"oversized-entry", valid("Unknown=" + strings.Repeat("x", candidateEnvironmentEntryUnits)), false},
		{"oversized-block", oversizedBlock, false},
		{"entry-count", candidateFakeEnvironment(tooMany...), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			selected, err := candidateSelectEnvironmentSlice(tc.block)
			if (err == nil) != tc.good {
				t.Fatal("bounded parser acceptance mismatch")
			}
			if err != nil && selected != (candidateEnvironmentSelection{}) {
				t.Fatal("partial metadata escaped refusal")
			}
			if err != nil && (strings.Contains(err.Error(), candidateFakeSecret) || strings.Contains(err.Error(), candidateFakeRoot)) {
				t.Fatal("parser error disclosed data")
			}
		})
	}
	// Entry limits count UTF-16 units, not UTF-8 bytes or Unicode runes.
	// The terminating NUL must fit within the unchanged entry cap as well.
	for i, char := range []string{"x", "é", "\U00020000"} {
		units := len(utf16.Encode([]rune(char)))
		remaining := candidateEnvironmentEntryUnits - 1 - len(`LOCALAPPDATA=Z:\`)
		value := `Z:\` + strings.Repeat(char, remaining/units) + strings.Repeat("x", remaining%units)
		t.Run("unicode-entry-limit-"+strconv.Itoa(i), func(t *testing.T) {
			entry := "LOCALAPPDATA=" + value
			if len(utf16.Encode([]rune(entry))) != candidateEnvironmentEntryUnits-1 {
				t.Fatal("invalid synthetic UTF-16 boundary setup")
			}
			selected, err := candidateSelectEnvironmentSlice(candidateFakeEnvironment("SystemRoot="+candidateFakeRoot, entry))
			if err != nil || selected.root != candidateFakeRoot || selected.local != value {
				t.Fatal("UTF-16 entry at limit refused or changed")
			}
			selected, err = candidateSelectEnvironmentSlice(candidateFakeEnvironment("SystemRoot="+candidateFakeRoot, entry+"x"))
			if err == nil || selected != (candidateEnvironmentSelection{}) {
				t.Fatal("UTF-16 entry beyond limit accepted or leaked partial metadata")
			}
		})
	}
	// Every proper prefix must fail, including prefixes after both selected
	// entries but before the unknown entry or final extra NUL.
	complete := valid("FakeSecret=" + candidateFakeSecret)
	for end := range len(complete) {
		if _, err := candidateSelectEnvironmentSlice(complete[:end]); err == nil {
			t.Fatal("truncated slice accepted")
		}
	}
	for _, suffix := range [][]uint16{{'U', '=', 0xd800, 0}, {'U', '=', 0xdc00, 0}, {'U', '=', 0xd800, 'a', 0}} {
		b := valid()
		b = append(b[:len(b)-1], suffix...)
		b = append(b, 0)
		if _, err := candidateSelectEnvironmentSlice(b); err == nil {
			t.Fatal("malformed UTF-16 accepted")
		}
	}
}

func TestWindowsAppContainerEnvironmentFailures(t *testing.T) {
	for _, name := range []string{"root-api", "root-invalid", "create-null", "create-partial", "create-success-null", "parse", "root-mismatch", "missing-local", "invalid-root", "invalid-local", "destroy", "parse-and-destroy"} {
		t.Run(name, func(t *testing.T) {
			block := candidateFakeEnvironment("SystemRoot="+candidateFakeRoot, "LOCALAPPDATA="+candidateFakeLocal)
			api, deletes := candidateFakeEnvironmentAPI(t, block)
			payloadErr := errors.New(candidateFakeSecret + candidateFakeRoot + candidateFakeLocal)
			wantDeletes := 1
			switch name {
			case "root-api":
				api.root = func() (string, error) { return "", payloadErr }
				wantDeletes = 0
			case "root-invalid":
				api.root = func() (string, error) { return "relative", nil }
				wantDeletes = 0
			case "create-null":
				api.create = func(**uint16, windows.Token, bool) error { return payloadErr }
				wantDeletes = 0
			case "create-partial":
				create := api.create
				api.create = func(p **uint16, token windows.Token, inherit bool) error {
					_ = create(p, token, inherit)
					return payloadErr
				}
				api.selectBlock = func(*uint16) (candidateEnvironmentSelection, error) {
					t.Fatal("parsed failed partial output")
					return candidateEnvironmentSelection{}, nil
				}
			case "create-success-null":
				api.create = func(**uint16, windows.Token, bool) error { return nil }
				wantDeletes = 0
			case "parse", "parse-and-destroy":
				api.selectBlock = func(*uint16) (candidateEnvironmentSelection, error) {
					return candidateEnvironmentSelection{}, payloadErr
				}
			case "root-mismatch":
				api.selectBlock = func(*uint16) (candidateEnvironmentSelection, error) {
					return candidateEnvironmentSelection{`Z:\OtherOS`, candidateFakeLocal}, nil
				}
			case "missing-local":
				api.selectBlock = func(*uint16) (candidateEnvironmentSelection, error) {
					return candidateEnvironmentSelection{root: candidateFakeRoot}, nil
				}
			case "invalid-root":
				api.selectBlock = func(*uint16) (candidateEnvironmentSelection, error) {
					return candidateEnvironmentSelection{`Z:relative`, candidateFakeLocal}, nil
				}
			case "invalid-local":
				api.selectBlock = func(*uint16) (candidateEnvironmentSelection, error) {
					return candidateEnvironmentSelection{candidateFakeRoot, `%USERPROFILE%\Local`}, nil
				}
			}
			if name == "destroy" || name == "parse-and-destroy" {
				destroy := api.destroy
				api.destroy = func(p *uint16) error { _ = destroy(p); return payloadErr }
			}
			selected, _, err := candidatePrepareEnvironment(123, api)
			if err == nil || selected != (candidateEnvironmentSelection{}) || *deletes != wantDeletes {
				t.Fatal("failure output/ownership mismatch")
			}
			for _, withheld := range []string{candidateFakeSecret, candidateFakeRoot, candidateFakeLocal} {
				if strings.Contains(err.Error(), withheld) {
					t.Fatal("error disclosed environment data")
				}
			}
		})
	}
	for _, field := range []string{"root", "lookup", "create", "destroy", "select", "token"} {
		t.Run("missing-"+field, func(t *testing.T) {
			api, deletes := candidateFakeEnvironmentAPI(t, candidateFakeEnvironment("Unknown=value"))
			token := windows.Token(123)
			switch field {
			case "root":
				api.root = nil
			case "lookup":
				api.lookup = nil
			case "create":
				api.create = nil
			case "destroy":
				api.destroy = nil
			case "select":
				api.selectBlock = nil
			case "token":
				token = 0
			}
			apiCalls := 0
			if api.root != nil {
				api.root = func() (string, error) { apiCalls++; return candidateFakeRoot, nil }
			}
			if _, _, err := candidatePrepareEnvironment(token, api); err == nil || *deletes != 0 || apiCalls != 0 {
				t.Fatal("missing dependency reached native/fake API")
			}
		})
	}
}

func TestWindowsAppContainerEnvironmentOwnerAndBOOL(t *testing.T) {
	for _, failure := range []bool{false, true} {
		var block uint16
		calls := 0
		o := candidateEnvironmentOwner{block: &block, destroy: func(p *uint16) error {
			calls++
			if p != &block {
				t.Fatal("wrong owned pointer")
			}
			if failure {
				return errors.New(candidateFakeSecret)
			}
			return nil
		}}
		for range 3 {
			if err := o.close(); (err != nil) != failure || calls != 1 {
				t.Fatal("environment close not once/sticky")
			}
		}
	}
	for _, result := range []uintptr{0, 1, 0x80004005} {
		if err := candidateEnvironmentBOOL(result); (err != nil) != (result == 0) {
			t.Fatal("BOOL treated as HRESULT")
		}
	}
}

func TestWindowsAppContainerEnvironmentPathsAndLegacy(t *testing.T) {
	refuse := func(t *testing.T, value string) {
		t.Helper()
		if _, ok := candidateEnvironmentPath(value); ok {
			t.Fatal("invalid selected metadata path accepted")
		}
		for _, selected := range []candidateEnvironmentSelection{{value, candidateFakeLocal}, {candidateFakeRoot, value}} {
			if _, err := selected.target(candidateFakeJob); err == nil {
				t.Fatal("invalid metadata reached target")
			}
		}
		if _, err := (candidateEnvironmentSelection{candidateFakeRoot, candidateFakeLocal}).target(value); err == nil {
			t.Fatal("invalid job directory reached target")
		}
	}
	// Retain the original order: historical native failures had no case label.
	// Index-only labels disclose neither metadata values nor path spellings.
	for i, value := range []string{"", "relative", `Z:relative`, `\rooted`, `\\server\share`, `\\?\Z:\Fixture`, `Z:\`, `Z:\Fixture\..`, `Z:\Fixture\.`, `Z:\Fixture\`, `Z:\Fixture\file.`, `Z:\Fixture\file `, `Z:\Fixture\file:stream`, `Z:\%UNEXPANDED%`, "Z:\\Fixture\x00secret", `Z:\Fixture\*`, `Z:\NUL`, `Z:\Fixture\CON.txt`, "Z:\\bad\xff", "Z:\\" + strings.Repeat("x", candidateEnvironmentEntryUnits)} {
		t.Run("invalid-"+strconv.Itoa(i), func(t *testing.T) { refuse(t, value) })
	}
	for i, value := range []string{`Z:\Fixture\..\Child`, `Z:\Fixture\.\Child`, `Z:\..\Child`, `Z:\.\Child`, `Z:\Fixture\\Child`, `Z:/Fixture/../Child`, `Z:\Fixture\file.\Child`, `Z:\Fixture\file \Child`, `\\.\Z:\Fixture`, `1:\Fixture`, `Z:\Fixture\?`, `Z:\Fixture\<`, `Z:\Fixture\>`, `Z:\Fixture\"`, `Z:\Fixture\|`, "Z:\\Fixture\tChild", "Z:\\Fixture\nChild", "Z:\\Fixture\rChild", "Z:\\Fixture\x1fChild", "Z:\\bad\xc0\xaf", "Z:\\bad\xed\xa0\x80", "Z:\\" + strings.Repeat("é", 4095)} {
		t.Run("additional-invalid-"+strconv.Itoa(i), func(t *testing.T) { refuse(t, value) })
	}
	reserved := []string{"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
	for _, prefix := range []string{"COM", "LPT"} {
		for _, digit := range "123456789¹²³" {
			reserved = append(reserved, prefix+string(digit))
		}
	}
	for i, base := range reserved {
		for j, suffix := range []string{"", ".txt", ".more.txt", " .txt"} {
			part := strings.ToLower(base) + suffix
			for k, value := range []string{`Z:\` + part, `Z:\Fixture\` + part, `Z:\Fixture\` + part + `\Child`} {
				t.Run("reserved-"+strconv.Itoa(i)+"/suffix-"+strconv.Itoa(j)+"/position-"+strconv.Itoa(k), func(t *testing.T) { refuse(t, value) })
			}
		}
	}
	for i, part := range []string{"CONSOLE", "CONIN", "CONOUT", "NULx.txt", "xCON.txt", "COM0", "COM10.txt", "COM1x.txt", "LPT0.txt", "LPT10", "LPT9x", "COM¹0.txt", "LPT²x", "COM⁴.txt", ".hidden", "..hidden", ".NUL", "file..txt", "内部", "Fixture\U00020000"} {
		value := `Z:\Fixture\` + part
		t.Run("ordinary-"+strconv.Itoa(i), func(t *testing.T) {
			if got, ok := candidateEnvironmentPath(value); !ok || got != value {
				t.Fatal("ordinary non-device metadata refused or changed")
			}
			if _, err := (candidateEnvironmentSelection{candidateFakeRoot, value}).target(candidateFakeJob); err != nil {
				t.Fatal("ordinary metadata refused by target")
			}
		})
	}
	t.Run("slash-normalization", func(t *testing.T) {
		if got, ok := candidateEnvironmentPath(`z:/Fixture/Child`); !ok || got != `z:\Fixture\Child` {
			t.Fatal("ordinary slash normalization changed")
		}
	})
	// Preserve the existing conservative byte bound, independently of the
	// parser's UTF-16 entry bound; non-ASCII metadata must not broaden it.
	for i, tail := range []string{strings.Repeat("x", candidateEnvironmentEntryUnits-3), strings.Repeat("é", 4094) + "x", strings.Repeat("\U00020000", 2047) + "x"} {
		value := `Z:\` + tail
		t.Run("path-byte-limit-"+strconv.Itoa(i), func(t *testing.T) {
			if len(value) != candidateEnvironmentEntryUnits {
				t.Fatal("invalid synthetic boundary setup")
			}
			if _, ok := candidateEnvironmentPath(value); !ok {
				t.Fatal("metadata at existing byte limit refused")
			}
			refuse(t, value+"x")
		})
	}
	for i, tc := range []struct {
		value   string
		present bool
		want    candidateEnvironmentLegacy
	}{
		{"", false, candidateEnvironmentLegacy{}},
		{"", true, candidateEnvironmentLegacy{present: true}},
		{"relative", true, candidateEnvironmentLegacy{present: true, nonempty: true}},
		{`z:/syntheticos`, true, candidateEnvironmentLegacy{true, true, true, true}},
		{`Z:\SyntheticOS\`, true, candidateEnvironmentLegacy{true, true, true, true}},
		{`Z:\OtherOS`, true, candidateEnvironmentLegacy{true, true, true, false}},
	} {
		t.Run("legacy-"+strconv.Itoa(i), func(t *testing.T) {
			api, deletes := candidateFakeEnvironmentAPI(t, candidateFakeEnvironment("SystemRoot="+candidateFakeRoot, "LOCALAPPDATA="+candidateFakeLocal))
			api.lookup = func(key string) (string, bool) {
				if key != "SystemRoot" {
					t.Fatal("unexpected legacy key")
				}
				return tc.value, tc.present
			}
			selected, legacy, err := candidatePrepareEnvironment(123, api)
			if err != nil || legacy != tc.want || selected.root != candidateFakeRoot || *deletes != 1 {
				t.Fatal("legacy observation affected authoritative environment")
			}
		})
	}
}
