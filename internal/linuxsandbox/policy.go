// Package linuxsandbox implements the bounded, offline helper contract, not the
// application's SandboxPlatform. Callers must not interpret buildability as support.
package linuxsandbox

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"reflect"
	"strings"
	"unicode/utf8"
)

const (
	Version     = 1
	MaxPolicy   = 16 << 10
	MaxArgs     = 256
	MaxArgBytes = 64 << 10
	MaxEnvBytes = 128 << 10
	MaxEnv      = 512
	MaxEnvJSON  = MaxEnvBytes*6 + MaxEnv*4
	MaxHandoff  = 512 << 10
)

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string        { return e.Code + ": " + e.Message }
func fail(code, message string) error { return &Error{code, message} }

// Policy deliberately differs from the TypeScript interface: only two leaves
// beneath a private managed agent directory are imported. No other agent data is.
type Policy struct {
	Version       int      `json:"version"`
	Workspace     string   `json:"workspace"`
	TempDir       string   `json:"tempDir"`
	Home          string   `json:"home"`
	DataDir       string   `json:"dataDir"`
	AgentDir      string   `json:"agentDir"`
	ProtectedDirs []string `json:"protectedDirs,omitempty"`
	Network       bool     `json:"network"`
}

// strictJSON also rejects duplicate keys: DisallowUnknownFields alone does not.
func strictJSON(raw []byte, limit int, dst any) error {
	if len(raw) == 0 || len(raw) > limit || !utf8.Valid(raw) {
		return fail("policy_invalid", "JSON size outside contract")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	var walk func(int, reflect.Type) error
	walk = func(depth int, typ reflect.Type) error {
		if depth > 8 {
			return fmt.Errorf("JSON nesting exceeds contract")
		}
		t, err := d.Token()
		if err != nil {
			return err
		}
		if t == nil {
			return fmt.Errorf("null fields are not accepted")
		}
		delim, ok := t.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			if typ.Kind() != reflect.Struct && typ.Kind() != reflect.Map {
				return fmt.Errorf("unexpected object")
			}
			fields := map[string]reflect.Type{}
			if typ.Kind() == reflect.Struct {
				for i := 0; i < typ.NumField(); i++ {
					f := typ.Field(i)
					key, _, _ := strings.Cut(f.Tag.Get("json"), ",")
					if key != "" && key != "-" {
						fields[key] = f.Type
					}
				}
			}
			seen := map[string]bool{}
			for d.More() {
				k, err := d.Token()
				if err != nil {
					return err
				}
				s, ok := k.(string)
				if !ok || seen[s] {
					return fmt.Errorf("duplicate or invalid key")
				}
				seen[s] = true
				var child reflect.Type
				if typ.Kind() == reflect.Map {
					child = typ.Elem()
				} else {
					child = fields[s]
					if child == nil {
						return fmt.Errorf("unknown or noncanonical field")
					}
				}
				if err := walk(depth+1, child); err != nil {
					return err
				}
			}
		case '[':
			if typ.Kind() != reflect.Slice {
				return fmt.Errorf("unexpected array")
			}
			for d.More() {
				if err := walk(depth+1, typ.Elem()); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("unexpected delimiter")
		}
		_, err = d.Token()
		return err
	}
	if err := walk(0, reflect.TypeOf(dst).Elem()); err != nil {
		return fail("policy_invalid", "malformed or duplicate JSON fields")
	}
	if _, err := d.Token(); err != io.EOF {
		return fail("policy_invalid", "trailing JSON")
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return fail("policy_invalid", "unknown fields or invalid JSON types")
	}
	return nil
}

func within(root, p string) bool { return p == root || strings.HasPrefix(p, root+"/") }
func overlap(a, b string) bool   { return within(a, b) || within(b, a) }
func cleanAbsolute(p string) bool {
	return utf8.ValidString(p) && len(p) > 1 && len(p) <= 4096 && strings.HasPrefix(p, "/") && path.Clean(p) == p && !strings.ContainsAny(p, "\x00\n\r\\")
}

func protectedRoots(p Policy) []string {
	return append([]string{path.Join(p.Home, ".ssh"), path.Join(p.Home, ".aws"), path.Join(p.Home, ".gnupg"), path.Join(p.Home, ".config"), path.Join(p.Home, ".local/share/keyrings"), path.Join(p.Home, "Library/Keychains")}, p.ProtectedDirs...)
}

func ParsePolicy(raw string) (Policy, error) {
	var p Policy
	if err := strictJSON([]byte(raw), MaxPolicy, &p); err != nil {
		return p, err
	}
	return p, p.Validate()
}
func (p Policy) Validate() error {
	if p.Version != Version {
		return fail("policy_unsupported", "only policy version 1 is supported")
	}
	if p.Network {
		return fail("policy_unsupported", "network=true is not supported; no unsandboxed retry")
	}
	if len(p.ProtectedDirs) > 32 {
		return fail("policy_invalid", "too many protected roots")
	}
	for _, s := range append([]string{p.Workspace, p.TempDir, p.Home, p.DataDir, p.AgentDir}, p.ProtectedDirs...) {
		if !cleanAbsolute(s) {
			return fail("policy_invalid", "roots must be bounded canonical absolute Linux paths")
		}
	}
	for _, secret := range p.ProtectedDirs {
		if !within(p.Home, secret) {
			return fail("policy_unsupported", "supplemental protected roots must be under managed home")
		}
		for _, visible := range []string{"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ld.so.cache", "/proc", "/dev", helperPath} {
			if overlap(secret, visible) {
				return fail("policy_unsupported", "protected roots cannot overlap mandatory runtime imports")
			}
		}
	}
	// First version accepts managed ancestry only, never arbitrary external roots.
	if p.DataDir == p.Home || !within(p.Home, p.DataDir) || p.AgentDir == p.DataDir || !within(p.DataDir, p.AgentDir) {
		return fail("policy_unsupported", "private managed home/data/agent ancestry required")
	}
	if p.Home == "/tmp" || within(p.Home, "/tmp") {
		return fail("policy_invalid", "home cannot contain ephemeral root")
	}
	if overlap(p.Workspace, p.TempDir) {
		return fail("policy_invalid", "writable roots must be disjoint leaves")
	}
	for _, root := range []string{p.Workspace, p.TempDir} {
		if root == p.AgentDir || !within(p.AgentDir, root) {
			return fail("policy_unsupported", "writable leaves must be below agentDir")
		}
		for _, reserved := range []string{"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/dev", "/sys", "/run", "/.pi-local"} {
			if overlap(root, reserved) || overlap(p.Home, reserved) {
				return fail("policy_invalid", "managed paths overlap a reserved sandbox tree")
			}
		}
		for _, secret := range protectedRoots(p) {
			if overlap(root, secret) {
				return fail("policy_invalid", "writable leaf overlaps protected data")
			}
		}
	}
	return nil
}

func validateArgv(argv []string) error {
	if len(argv) == 0 || len(argv) > MaxArgs || !cleanAbsolute(argv[0]) {
		return fail("argv_invalid", "bounded argv with absolute executable required")
	}
	n := 0
	for _, a := range argv {
		n += len(a) + 1
		if !utf8.ValidString(a) || len(a) > 16384 || strings.ContainsRune(a, 0) {
			return fail("argv_invalid", "invalid or oversized argument")
		}
	}
	if n > MaxArgBytes {
		return fail("argv_invalid", "argv exceeds 64 KiB")
	}
	return nil
}

// Main accepts no shell command string and never retries a failed confinement.
// A successful Linux call exec-replaces this process; failure returns an Error.
func Main(args, targetEnv []string) error {
	if len(args) > 0 && args[0] == "guard" {
		return guard(args[1:])
	}
	if len(args) < 5 || args[0] != "run" || args[1] != "--policy" || args[3] != "--" {
		return fail("usage", "run --policy JSON -- /absolute/program [args...]")
	}
	p, err := ParsePolicy(args[2])
	if err != nil {
		return err
	}
	if err := validateArgv(args[4:]); err != nil {
		return err
	}
	env, err := targetEnvironment(targetEnv, p)
	if err != nil {
		return err
	}
	return launch(p, args[4:], env)
}
