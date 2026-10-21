package linuxsandbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func fixturePolicy() Policy {
	return Policy{Version: 1, Home: "/tmp/fixture/home", DataDir: "/tmp/fixture/home/data", AgentDir: "/tmp/fixture/home/data/agents/one", Workspace: "/tmp/fixture/home/data/agents/one/workspace", TempDir: "/tmp/fixture/home/data/agents/one/temp"}
}
func policyJSON(p Policy) string {
	b, err := json.Marshal(p)
	if err != nil {
		panic(err)
	}
	return string(b)
}
func errorCode(t *testing.T, err error, want string) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) || e.Code != want {
		t.Fatalf("got %v; want code %s", err, want)
	}
}
func TestPolicy(t *testing.T) {
	p := fixturePolicy()
	if _, err := ParsePolicy(policyJSON(p)); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*Policy){
		"network": func(p *Policy) { p.Network = true }, "version": func(p *Policy) { p.Version = 2 },
		"relative": func(p *Policy) { p.Workspace = "relative" }, "unclean": func(p *Policy) { p.TempDir += "/../temp" },
		"overlap": func(p *Policy) { p.TempDir = p.Workspace + "/temp" }, "home": func(p *Policy) { p.Workspace = p.Home },
		"agentWholesale": func(p *Policy) { p.Workspace = p.AgentDir }, "external": func(p *Policy) { p.Workspace = "/work" },
		"protectedAncestor":      func(p *Policy) { p.ProtectedDirs = []string{p.Workspace + "/credentials"} },
		"protectedDescendant":    func(p *Policy) { p.ProtectedDirs = []string{p.AgentDir} },
		"protectedRuntimeImport": func(p *Policy) { p.ProtectedDirs = []string{"/usr/credentials"} },
		"reserved": func(p *Policy) {
			p.Home = "/usr/home"
			p.DataDir = p.Home + "/data"
			p.AgentDir = p.DataDir + "/a"
			p.Workspace = p.AgentDir + "/w"
			p.TempDir = p.AgentDir + "/t"
		},
		"credential": func(p *Policy) {
			p.DataDir = p.Home + "/.ssh"
			p.AgentDir = p.DataDir + "/agent"
			p.Workspace = p.AgentDir + "/w"
			p.TempDir = p.AgentDir + "/t"
		},
	} {
		t.Run(name, func(t *testing.T) {
			q := p
			change(&q)
			if q.Validate() == nil {
				t.Fatal("accepted unsafe policy")
			}
		})
	}
}
func TestStrictJSON(t *testing.T) {
	raw := policyJSON(fixturePolicy())
	for _, bad := range []string{raw + " {}", strings.Replace(raw, `"network":false`, `"network":false,"network":true`, 1), strings.Replace(raw, `"network":false`, `"Network":false`, 1), strings.Replace(raw, `"network":false`, `"network":null`, 1), strings.Replace(raw, `"version":1`, `"version":1.0`, 1), strings.Replace(raw, `"version":1`, `"version":1,"extra":0`, 1), strings.Repeat(" ", MaxPolicy+1), "[" + strings.Repeat("[", 32) + "]", string([]byte{'{', '"', 0xff, '"', ':', '1', '}'})} {
		if _, err := ParsePolicy(bad); err == nil {
			t.Fatalf("accepted malformed/ambiguous JSON %.80q", bad)
		}
	}
}
func TestArgvBounds(t *testing.T) {
	for _, argv := range [][]string{nil, {"sh"}, {"/bin/sh", string([]byte{0xff})}, {"/bin/sh", "a\x00b"}, {"/bin/sh", strings.Repeat("x", 16385)}, append([]string{"/bin/sh"}, make([]string, MaxArgs)...)} {
		if validateArgv(argv) == nil {
			t.Fatal("accepted invalid argv")
		}
	}
	if err := validateArgv([]string{"/bin/sh", "-c", "printf '%s' 'a;$(literal)'"}); err != nil {
		t.Fatal(err)
	}
}
func TestEnvironmentPoisonIsolation(t *testing.T) {
	p := fixturePolicy()
	secret := "fixture-only-secret"
	poison := []string{"LD_PRELOAD=/tmp/evil.so", "LD_LIBRARY_PATH=/tmp/evil", "NODE_OPTIONS=--require=/tmp/evil.js", "GLIBC_TUNABLES=bad", "GODEBUG=bad", "TOKEN=" + secret, "SSH_AUTH_SOCK=/tmp/host.sock", "DBUS_SESSION_BUS_ADDRESS=unix:abstract=host", "PATH=/tmp/evil"}
	env, err := targetEnvironment(poison, p)
	if err != nil {
		t.Fatal(err)
	}
	engine := strings.Join(engineEnvironment(), "\n")
	for _, entry := range poison {
		if strings.Contains(engine, entry) || strings.Contains(engine, secret) {
			t.Fatal("target poison/secret reached engine")
		}
	}
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "TOKEN="+secret) || !strings.Contains(joined, "LD_PRELOAD=/tmp/evil.so") {
		t.Fatal("target-only environment was lost")
	}
	if strings.Contains(joined, "SSH_AUTH_SOCK=") || strings.Contains(joined, "DBUS_SESSION_BUS_ADDRESS=") {
		t.Fatal("host service discovery retained")
	}
	if !strings.Contains(joined, "PATH=/usr/bin:/bin") || !strings.Contains(joined, "TMPDIR="+p.TempDir) {
		t.Fatal("unsafe defaults")
	}
	for _, bad := range [][]string{{"TOKEN=a", "TOKEN=b"}, {"no-equals"}, {"=bad"}, {"A=a\x00b"}, {"A=" + strings.Repeat("x", MaxEnvBytes)}} {
		if _, err := targetEnvironment(bad, p); err == nil {
			t.Fatal("accepted invalid env")
		}
	}
	// Worst-case JSON expansion remains bounded and round-trips verbatim.
	env, err = targetEnvironment([]string{"CONTROL=" + strings.Repeat("\x01", MaxEnvBytes-4096)}, p)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(env)
	var decoded []string
	if err := strictJSON(raw, MaxEnvJSON, &decoded); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(decoded) != fmt.Sprint(env) {
		t.Fatal("environment round-trip changed bytes")
	}
}
func TestNetworkRefusedBeforePlatformOrTarget(t *testing.T) {
	p := fixturePolicy()
	p.Network = true
	err := Main([]string{"run", "--policy", policyJSON(p), "--", "/bin/sh", "-c", "exit 88"}, []string{"TOKEN=fixture"})
	errorCode(t, err, "policy_unsupported")
}

func fixtureHandoff() handoff {
	p := fixturePolicy()
	h := handoff{Version: Version, Policy: p, Argv: []string{"/bin/sh", "-c", "true"}}
	for i, b := range []binding{{Source: "/usr", Dest: "/usr", Directory: true}, {Source: "/etc/ld.so.cache", Dest: "/etc/ld.so.cache"}, {Source: "/opt/pi-local/helper", Dest: helperPath}, {Source: p.Workspace, Dest: p.Workspace, Writable: true, Directory: true}, {Source: p.TempDir, Dest: p.TempDir, Writable: true, Directory: true}} {
		b.BindFD = 100 + i*2
		b.IdentityFD = 101 + i*2
		b.Identity = identity{Dev: 1, Ino: uint64(i + 1)}
		h.Bindings = append(h.Bindings, b)
	}
	return h
}
func TestPlan(t *testing.T) {
	h := fixtureHandoff()
	args, err := plan(h, 64, 65)
	if err != nil {
		t.Fatal(err)
	}
	firstWrite := -1
	lastRead := -1
	for i, a := range args {
		if a == "--bind" || a == "--ro-bind" || a == "--as-pid-1" || a == "--share-net" {
			t.Fatal("unsafe planner option")
		}
		if a == "--ro-bind-fd" {
			lastRead = i
		}
		if a == "--bind-fd" && firstWrite < 0 {
			firstWrite = i
		}
		if firstWrite >= 0 && i > firstWrite && (a == "--dir" || a == "--symlink" || a == "--tmpfs" || a == "--remount-ro") {
			t.Fatal("setup operation after writable import")
		}
	}
	if firstWrite <= lastRead {
		t.Fatal("writable imports not last")
	}
	joined := strings.Join(args, "\n")
	for _, flag := range []string{"--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net", "--new-session", "--die-with-parent", "--cap-drop"} {
		if !strings.Contains(joined, flag) {
			t.Fatal("missing", flag)
		}
	}
	for _, s := range []string{"LD_PRELOAD", "TOKEN=", "--ro-bind\n/\n/"} {
		if strings.Contains(joined, s) {
			t.Fatal("unsafe plan data")
		}
	}
}
func TestBadBindMapping(t *testing.T) {
	for name, change := range map[string]func(*handoff){"missing": func(h *handoff) { h.Bindings = h.Bindings[:4] }, "duplicate": func(h *handoff) { h.Bindings[4] = h.Bindings[3] }, "fdCollision": func(h *handoff) { h.Bindings[0].BindFD = 64 }, "identityCollision": func(h *handoff) { h.Bindings[0].IdentityFD = h.Bindings[0].BindFD }, "wrongDest": func(h *handoff) { h.Bindings[0].Dest = "/" }, "writableSystem": func(h *handoff) { h.Bindings[0].Writable = true }, "wrongType": func(h *handoff) { h.Bindings[0].Directory = false },
		"sourceRemap":    func(h *handoff) { h.Bindings[3].Source = h.Policy.DataDir },
		"helperWritable": func(h *handoff) { h.Bindings[2].Source = h.Policy.Workspace + "/helper" }} {
		t.Run(name, func(t *testing.T) {
			h := fixtureHandoff()
			change(&h)
			if _, err := plan(h, 64, 65); err == nil {
				t.Fatal("bad bind map accepted")
			}
		})
	}
}
func TestIdentityInjectionRefusesSwaps(t *testing.T) {
	h := fixtureHandoff()
	good := func(b binding) (identity, identity, error) { return b.Identity, b.Identity, nil }
	if err := identityCheck(h.Bindings, good); err != nil {
		t.Fatal(err)
	}
	for _, which := range []string{"source", "destination", "fdClosed"} {
		t.Run(which, func(t *testing.T) {
			err := identityCheck(h.Bindings, func(b binding) (identity, identity, error) {
				a, z, e := good(b)
				if b.Writable {
					switch which {
					case "source":
						a.Ino++
					case "destination":
						z.Dev++
					case "fdClosed":
						e = errors.New("closed")
					}
				}
				return a, z, e
			})
			errorCode(t, err, "guard_failed")
		})
	}
}
func TestScaffoldRejectsOtherAgentAndCredentials(t *testing.T) {
	h := fixtureHandoff()
	dirs := scaffold(h.Bindings)
	list := func(p string) ([]string, error) {
		out := []string{}
		for name := range dirs[p] {
			out = append(out, name)
		}
		return out, nil
	}
	if err := verifyScaffold(h.Bindings, list); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{".ssh", "other-agent", "db.sqlite"} {
		err := verifyScaffold(h.Bindings, func(p string) ([]string, error) {
			names, e := list(p)
			if p == h.Policy.DataDir {
				names = append(names, bad)
			}
			return names, e
		})
		errorCode(t, err, "guard_failed")
	}
}
func FuzzPolicy(f *testing.F) {
	f.Add(policyJSON(fixturePolicy()))
	f.Add(`{"network":true}`)
	f.Fuzz(func(t *testing.T, s string) {
		p, err := ParsePolicy(s)
		if err == nil {
			if err := p.Validate(); err != nil {
				t.Fatal(err)
			}
		}
	})
}
