//go:build windows

package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/appdb"
	"github.com/ncecere/pi-local/internal/secrets"
	"github.com/ncecere/pi-local/internal/supervisor"
)

func TestWindowsMCPHelper(t *testing.T) {
	if os.Getenv("PL_WIN_MCP_HELPER") != "1" {
		return
	}
	mode := os.Getenv("PL_WIN_MCP_MODE")
	if strings.HasPrefix(mode, "probe-") {
		var request map[string]any
		if json.NewDecoder(os.Stdin).Decode(&request) != nil || request["fixture"] != "json-stdin" {
			os.Exit(8)
		}
		if mode == "probe-hang" {
			fmt.Println(`{"type":"progress"}`)
			for {
				time.Sleep(time.Hour)
			}
		}
		if mode == "probe-burst" {
			for i := 0; i < 200; i++ {
				fmt.Printf("{\"type\":\"progress\",\"message\":\"%s\"}\n", strings.Repeat("x", 1024))
			}
		}
		if mode == "probe-handshake" {
			fmt.Println(`{"type":"progress"}`)
			until := time.Now().Add(8 * time.Second)
			for {
				if _, err := os.Stat("release"); err == nil {
					break
				}
				if time.Now().After(until) {
					os.Exit(9)
				}
				time.Sleep(time.Millisecond)
			}
		}
		message := "complete"
		if mode == "probe-large" {
			message = strings.Repeat("x", 1<<20)
		}
		fmt.Printf("{\"type\":\"result\",\"message\":\"%s\",\"tools\":[]}\n", message)
		os.Exit(0)
	}
	// Sign-in commands must have null stdin, never the runtime EOF watchdog.
	b, err := io.ReadAll(os.Stdin)
	if err != nil || len(b) != 0 {
		os.Exit(10)
	}
	if mode == "login-fail" {
		fmt.Println("fixture failed")
		os.Exit(7)
	}
	fmt.Println("fixture ready")
	for {
		time.Sleep(time.Hour)
	}
}
func windowsProber(t *testing.T, mode string) *Prober {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	return &Prober{Runtime: supervisor.Runtime{Node: exe, Args: []string{"-test.run=^TestWindowsMCPHelper$", "--"}, Script: mode, Dir: dir}, Env: map[string]string{"PL_WIN_MCP_HELPER": "1", "PL_WIN_MCP_MODE": mode, "HOME": dir, "GORACE": "atexit_sleep_ms=0"}}
}
func TestWindowsProbeZeroLossJSONStdout(t *testing.T) {
	for _, mode := range []string{"probe-burst", "probe-large", "probe-handshake"} {
		t.Run(mode, func(t *testing.T) {
			p := windowsProber(t, mode)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			progress := 0
			ev, err := p.run(ctx, map[string]any{"fixture": "json-stdin"}, func(ev probeEvent) {
				if ev.Type != "progress" {
					return
				}
				progress++
				if mode == "probe-burst" {
					time.Sleep(time.Millisecond)
				}
				if mode == "probe-handshake" {
					if err := os.WriteFile(filepath.Join(p.Runtime.Dir, "release"), nil, 0600); err != nil {
						t.Error(err)
					}
					time.Sleep(100 * time.Millisecond)
				}
			})
			if err != nil || ev.Type != "result" {
				t.Fatalf("final result lost: type=%s err=%v", ev.Type, err)
			}
			if mode == "probe-large" {
				if len(ev.Message) != 1<<20 {
					t.Fatalf("truncated final JSON: %d", len(ev.Message))
				}
			} else if ev.Message != "complete" {
				t.Fatal("truncated result")
			}
			if mode == "probe-burst" && progress != 200 {
				t.Fatalf("progress count %d", progress)
			}
		})
	}
}
func TestWindowsProbeCancellation(t *testing.T) {
	p := windowsProber(t, "probe-hang")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ev, err := p.run(ctx, map[string]any{"fixture": "json-stdin"}, func(probeEvent) { cancel() })
	if err != nil || ev.Code != "timeout" {
		t.Fatalf("cancel event=%+v err=%v", ev, err)
	}
}
func TestWindowsLoginNativeExitAndCancel(t *testing.T) {
	for _, mode := range []string{"missing", "login-fail", "login-hang"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			db, err := appdb.Open(context.Background(), filepath.Join(dir, "fixture.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			c := New(db, secrets.NewMemory())
			defer c.Close()
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			if mode == "missing" {
				exe = filepath.Join(dir, "missing.exe")
			}
			name, transport := "Synthetic login", "stdio"
			args := []string{"-test.run=^TestWindowsMCPHelper$", "--"}
			env := map[string]string{"PL_WIN_MCP_HELPER": "1", "PL_WIN_MCP_MODE": mode, "HOME": dir, "GORACE": "atexit_sleep_ms=0"}
			server, err := c.Create(context.Background(), Input{Name: &name, Transport: &transport, Command: &exe, LoginArgs: &args, Cwd: &dir, Env: &env}, "")
			if err != nil {
				t.Fatal(err)
			}
			events := make(chan LoginStatus, 32)
			c.OnLogin = func(s LoginStatus) {
				select {
				case events <- s:
				default:
				}
			}
			status, err := c.Login(context.Background(), server.Slug)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "missing" {
				if status.State != "failed" {
					t.Fatal(status.State)
				}
				return
			}
			timeout := time.After(10 * time.Second)
			cancelled := false
			for {
				select {
				case status = <-events:
					if mode == "login-hang" && status.State == "running" && strings.Contains(status.Output, "fixture ready") && !cancelled {
						if _, err := c.CancelLogin(context.Background(), server.Slug); err != nil {
							t.Fatal(err)
						}
						cancelled = true
					}
					if status.State != "running" {
						want := "failed"
						code := 7
						if mode == "login-hang" {
							want, code = "cancelled", 1
						}
						if status.State != want || status.ExitCode == nil || *status.ExitCode != code {
							t.Fatalf("native login state/status: %+v", status)
						}
						c.Close()
						return
					}
				case <-timeout:
					t.Fatal("synthetic login did not finish")
				}
			}
		})
	}
}
