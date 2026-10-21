//go:build darwin || linux

package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
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
	if mode == "stdout-holder" {
		os.WriteFile("holder-ready", []byte("yes"), 0600)
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat("release-holder"); err == nil {
				break
			}
			time.Sleep(time.Millisecond)
		}
		os.WriteFile("holder-done", []byte("yes"), 0600)
		os.Exit(0)
	}
	if mode == "probe-retain" {
		child := exec.Command(os.Args[0], "-test.run=^TestMCPProcessHelper$", "--", "stdout-holder")
		child.Env, child.Stdout = os.Environ(), os.Stdout
		child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // deliberately escapes the probe group
		if child.Start() != nil {
			os.Exit(9)
		}
		for {
			if _, err := os.Stat("holder-ready"); err == nil {
				break
			}
			time.Sleep(time.Millisecond)
		}
		fmt.Println(`{"type":"progress"}`)
		os.Exit(0)
	}
	if strings.HasPrefix(mode, "probe-drain-") {
		var req map[string]any
		if json.NewDecoder(os.Stdin).Decode(&req) != nil {
			os.Exit(8)
		}
		switch mode {
		case "probe-drain-burst":
			for i := 0; i < 200; i++ {
				fmt.Printf("{\"type\":\"progress\",\"message\":\"%s\"}\n", strings.Repeat("x", 1024))
			}
		case "probe-drain-handshake":
			fmt.Println(`{"type":"progress"}`)
			for {
				if _, err := os.Stat("release"); err == nil {
					break
				}
				time.Sleep(time.Millisecond)
			}
		}
		message := "complete"
		if mode == "probe-drain-large" {
			message = strings.Repeat("x", 1<<20)
		}
		fmt.Printf("{\"type\":\"result\",\"message\":\"%s\",\"tools\":[]}\n", message)
		os.Exit(0)
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

func TestProbeDrainsSuccessfulExit(t *testing.T) {
	for _, mode := range []string{"burst", "handshake", "large"} {
		t.Run(mode, func(t *testing.T) {
			p := fixtureProber(t, "probe-drain-"+mode)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			progress := 0
			ev, err := p.run(ctx, map[string]any{"fixture": true}, func(ev probeEvent) {
				if ev.Type != "progress" {
					return
				}
				progress++
				if mode == "burst" {
					time.Sleep(time.Millisecond)
				}
				if mode == "handshake" {
					if err := os.WriteFile(filepath.Join(p.Runtime.Dir, "release"), []byte("yes"), 0600); err != nil {
						t.Error(err)
					}
					time.Sleep(100 * time.Millisecond)
				}
			})
			if err != nil || ev.Type != "result" {
				t.Fatalf("lost final result: type=%s err=%v", ev.Type, err)
			}
			if mode == "large" {
				if len(ev.Message) != 1<<20 {
					t.Fatalf("truncated JSON: %d", len(ev.Message))
				}
			} else if ev.Message != "complete" {
				t.Fatal("truncated result")
			}
			if mode == "burst" && progress != 200 {
				t.Fatalf("progress count = %d", progress)
			}
		})
	}
}

func TestProbeEscapedStdout(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelled), func(t *testing.T) {
			p := fixtureProber(t, "probe-retain")
			t.Cleanup(func() {
				os.WriteFile(filepath.Join(p.Runtime.Dir, "release-holder"), []byte("yes"), 0600)
				deadline := time.Now().Add(2 * time.Second)
				for {
					if _, err := os.Stat(filepath.Join(p.Runtime.Dir, "holder-done")); err == nil {
						break
					}
					if time.Now().After(deadline) {
						t.Error("escaped fixture did not finish cooperatively")
						break
					}
					time.Sleep(time.Millisecond)
				}
			})
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			progress := 0
			start := time.Now()
			ev, err := p.run(ctx, nil, func(ev probeEvent) {
				if ev.Type == "progress" {
					progress++
					if cancelled {
						cancel()
					}
				}
			})
			want := "probe_failed"
			if cancelled {
				want = "timeout"
			}
			if err != nil || ev.Code != want || progress != 1 {
				t.Fatalf("event=%+v err=%v progress=%d", ev, err, progress)
			}
			if time.Since(start) > 8*time.Second {
				t.Fatal("retained stdout was not bounded")
			}
			if _, err := os.Stat(filepath.Join(p.Runtime.Dir, "holder-done")); err == nil {
				t.Fatal("fixture stopped before testing escaped retention")
			}
		})
	}
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
