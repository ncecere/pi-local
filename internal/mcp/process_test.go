//go:build darwin || linux

package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/appdb"
	"github.com/ncecere/pi-local/internal/secrets"
	"github.com/ncecere/pi-local/internal/supervisor"
)

func TestMCPProcessHelper(t *testing.T) {
	if os.Getenv("MCP_PROCESS_HELPER") != "1" {
		return
	}
	args := os.Args
	mode := args[len(args)-1]
	if mode == "mcp-probe" {
		mode = args[len(args)-2]
	}
	if mode == "probe-result" {
		var req map[string]any
		if json.NewDecoder(os.Stdin).Decode(&req) != nil || req["fixture"] != "json-stdin" {
			os.Exit(8)
		}
		fmt.Println(`{"type":"result","tools":[]}`)
		os.Exit(0)
	}
	if mode == "login-fail" {
		fmt.Println("fixture failed")
		os.Exit(7)
	}
	signal.Ignore(syscall.SIGTERM)
	if mode == "probe-hang" {
		fmt.Println(`{"type":"progress"}`)
	} else {
		fmt.Println("fixture ready")
	}
	for {
		time.Sleep(time.Hour)
	}
}

func fixtureProber(t *testing.T, mode string) *Prober {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	return &Prober{Runtime: supervisor.Runtime{Node: exe, Args: []string{"-test.run=^TestMCPProcessHelper$", "--"}, Script: mode, Dir: dir}, Env: map[string]string{"MCP_PROCESS_HELPER": "1", "HOME": dir, "GORACE": "atexit_sleep_ms=0"}}
}

func TestProbeProcessPolicies(t *testing.T) {
	t.Run("json stdin", func(t *testing.T) {
		p := fixtureProber(t, "probe-result")
		ev, err := p.run(context.Background(), map[string]any{"fixture": "json-stdin"}, nil)
		if err != nil || ev.Type != "result" {
			t.Fatalf("event=%+v error=%v", ev, err)
		}
	})
	t.Run("cancel before start", func(t *testing.T) {
		p := fixtureProber(t, "probe-hang")
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := p.run(ctx, nil, nil); err == nil {
			t.Fatal("expected cancelled launch")
		}
	})
	t.Run("bounded cancellation escalation", func(t *testing.T) {
		p := fixtureProber(t, "probe-hang")
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan probeEvent, 1)
		go func() {
			ev, err := p.run(ctx, nil, func(ev probeEvent) {
				if ev.Type == "progress" {
					cancel()
				}
			})
			if err != nil {
				ev.Code = err.Error()
			}
			done <- ev
		}()
		select {
		case ev := <-done:
			if ev.Code != "timeout" {
				t.Fatalf("event=%+v", ev)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("probe cancellation hung")
		}
	})
	t.Run("failed launch", func(t *testing.T) {
		p := fixtureProber(t, "unused")
		p.Runtime.Node = filepath.Join(p.Runtime.Dir, "missing")
		if _, err := p.run(context.Background(), nil, nil); err == nil {
			t.Fatal("wanted exec failure")
		}
	})
}

func fixtureLogin(t *testing.T, mode string) (*Catalog, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := appdb.Open(context.Background(), filepath.Join(dir, "fixture.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	c := New(db, secrets.NewMemory())
	t.Cleanup(c.Close)
	name, transport := "Fixture login", "stdio"
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if mode == "missing" {
		exe = filepath.Join(dir, "missing")
	}
	args := []string{"-test.run=^TestMCPProcessHelper$", "--", mode}
	env := map[string]string{"MCP_PROCESS_HELPER": "1", "HOME": dir, "GORACE": "atexit_sleep_ms=0"}
	s, err := c.Create(context.Background(), Input{Name: &name, Transport: &transport, Command: &exe, LoginArgs: &args, Cwd: &dir, Env: &env}, "")
	if err != nil {
		t.Fatal(err)
	}
	return c, s.Slug
}

func TestLoginFakeCommands(t *testing.T) {
	for _, mode := range []string{"missing", "login-fail", "login-hang"} {
		t.Run(mode, func(t *testing.T) {
			c, slug := fixtureLogin(t, mode)
			events := make(chan LoginStatus, 32)
			c.OnLogin = func(s LoginStatus) {
				select {
				case events <- s:
				default:
				}
			}
			st, err := c.Login(context.Background(), slug)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "missing" {
				if st.State != "failed" {
					t.Fatal(st.State)
				}
				return
			}
			deadline := time.After(5 * time.Second)
			cancelled := false
			for {
				select {
				case st = <-events:
					if mode == "login-hang" && strings.Contains(st.Output, "fixture ready") && !cancelled {
						if _, err := c.CancelLogin(context.Background(), slug); err != nil {
							t.Fatal(err)
						}
						cancelled = true
					}
					if st.State != "running" {
						want := "failed"
						if mode == "login-hang" {
							want = "cancelled"
						}
						if st.State != want {
							t.Fatalf("state=%s want=%s", st.State, want)
						}
						c.Close()
						return
					}
				case <-deadline:
					t.Fatal("login did not stop")
				}
			}
		})
	}
}
