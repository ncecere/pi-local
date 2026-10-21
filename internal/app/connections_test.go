package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/mcp"
	"github.com/ncecere/pi-local/internal/secrets"
)

func TestConnectionsCatalogAndUnsupportedSetup(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	list := decodeInto[[]mcp.Connection](t, h.mustDo("GET", "/api/connections", nil, 200))
	if len(list) != 12 {
		t.Fatalf("catalog: %d", len(list))
	}
	for _, c := range list {
		if c.State != "not_connected" || c.Server != nil || c.UsedBy == nil {
			t.Fatalf("new catalog: %+v", c)
		}
	}
	for _, id := range []string{"github", "asana", "microsoft365", "google", "google_calendar", "google_drive"} {
		body := h.mustDo("POST", "/api/connections/"+id+"/connect", nil, 409)
		if !strings.Contains(string(body), "setup_required") {
			t.Fatal(string(body))
		}
	}
	if len(decodeInto[[]mcp.Server](t, h.mustDo("GET", "/api/mcp/servers", nil, 200))) != 0 {
		t.Fatal("unsupported setup created a server")
	}
	h.mustDo("POST", "/api/connections/unknown/connect", nil, 404)
	h.mustDo("DELETE", "/api/connections/notion", nil, 200)
	h.mustDo("POST", "/api/agents", map[string]any{"name": "Meeting", "templateId": "meeting-helper"}, 409)
}

func TestConnectOAuthConnection(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	endpoint := startOAuthFixture(t)
	p := mcp.ConnectionPresets()[0]
	p.URL = endpoint
	h.app.MCP.Presets = func() []mcp.Preset { return []mcp.Preset{p} }
	// Only the local fake provider is ever opened. It completes its callback without accounts or internet.
	h.app.MCP.SetProber(withBrowser(h.app, func(u string) error {
		if !strings.HasPrefix(u, strings.TrimSuffix(endpoint, "/mcp")) {
			t.Errorf("unexpected browser URL: %s", u)
			return nil
		}
		go func() {
			client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			resp, err := client.Get(u)
			if err != nil {
				return
			}
			resp.Body.Close()
			if loc := resp.Header.Get("Location"); loc != "" {
				if r, err := http.Get(loc); err == nil {
					r.Body.Close()
				}
			}
		}()
		return nil
	}))
	result := decodeInto[mcp.ConnectResult](t, h.mustDo("POST", "/api/connections/notion/connect", nil, 200))
	if !strings.Contains(result.AuthorizeURL, "/authorize?") {
		t.Fatalf("missing OAuth: %+v", result)
	}
	eventually(t, 30*time.Second, "connection sign-in", func() bool {
		list := decodeInto[[]mcp.Connection](t, h.mustDo("GET", "/api/connections", nil, 200))
		return list[0].State == "connected" && list[0].Server.SignedIn
	})
	// Connect again reuses the same server, not another registration or another database entry.
	again := decodeInto[mcp.ConnectResult](t, h.mustDo("POST", "/api/connections/notion/connect", nil, 200))
	if again.Connection.State != "connected" || again.AuthorizeURL != "" {
		t.Fatalf("reuse: %+v", again)
	}
	if n := len(decodeInto[[]mcp.Server](t, h.mustDo("GET", "/api/mcp/servers", nil, 200))); n != 1 {
		t.Fatalf("servers: %d", n)
	}
	scripted(t, h)
	agent := h.agentOn("Reader", "script/s1", map[string]any{"mcp": []map[string]any{{"server": "notion"}}})
	if reply := lastReply(h.sendAndWait(agent, "t1", "CALL:mcp__notion__whoami:{}", "r1")); !strings.Contains(reply, "signed-in person") {
		t.Fatal(reply)
	}
	list := decodeInto[[]mcp.Connection](t, h.mustDo("GET", "/api/connections", nil, 200))
	if len(list[0].UsedBy) != 1 || list[0].UsedBy[0].ID != agent {
		t.Fatal(list)
	}
	h.mustDo("DELETE", "/api/connections/notion", nil, 409)
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"mcp": []any{}}, 200)
	h.mustDo("DELETE", "/api/connections/notion", nil, 200)
	for _, name := range h.app.cfg.Secrets.(*secrets.Memory).Names() {
		if strings.HasPrefix(name, "mcp:notion:") {
			t.Fatal("secret left: " + name)
		}
	}
}

func TestAppleConnectListsToolsWithoutReadingApps(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS stdio integration")
	}
	h := start(t, t.TempDir(), Config{})
	result := decodeInto[mcp.ConnectResult](t, h.mustDo("POST", "/api/connections/apple_calendar/connect", nil, 200))
	if result.Connection.State != "connected" || len(result.Connection.Server.Tools) != 1 {
		t.Fatalf("Apple tools: %+v", result)
	}
	if !strings.Contains(result.Connection.Description, "Creation is unavailable") {
		t.Fatal("headless UI must explain that creation is unavailable")
	}
	// Startup and tools/list run no Apple script, so this test never reads real events or triggers permissions.
	list := string(h.mustDo("GET", "/api/templates", nil, 200))
	if !strings.Contains(list, "meeting-helper") {
		t.Fatal("missing capability-gated template")
	}
	agent := decodeInto[struct{ ID string }](t, h.mustDo("POST", "/api/agents", map[string]any{"name": "Meeting", "templateId": "meeting-helper"}, 201))
	ag, _ := h.app.Agents.Get(agent.ID)
	if len(ag.Config.MCP) != 1 || ag.Config.MCP[0].Server != "apple_calendar" || ag.Config.Approvals.Profile != "careful" {
		t.Fatal(ag.Config)
	}
	h.mustDo("PATCH", "/api/agents/"+agent.ID, map[string]any{"mcp": []any{}}, 200)
	h.mustDo("DELETE", "/api/connections/apple_calendar", nil, 200)
	if strings.Contains(string(h.mustDo("GET", "/api/templates", nil, 200)), "meeting-helper") {
		t.Fatal("template offered without capability")
	}
	for _, id := range []string{"apple_reminders", "apple_notes"} {
		c := decodeInto[mcp.ConnectResult](t, h.mustDo("POST", "/api/connections/"+id+"/connect", nil, 200))
		if c.Connection.State != "connected" || len(c.Connection.Server.Tools) == 0 {
			t.Fatalf("tool listing: %+v", c)
		}
		h.mustDo("DELETE", "/api/connections/"+id, nil, 200)
	}
}

func TestAppleHostCapabilityIsNotAnAgentOrServerPreference(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS stdio tool listing only")
	}
	for _, trusted := range []bool{false, true} {
		name := "headless"
		if trusted {
			name = "native-desktop"
		}
		t.Run(name, func(t *testing.T) {
			h := start(t, t.TempDir(), Config{TrustedHumanConfirmations: trusted})
			result := decodeInto[mcp.ConnectResult](t, h.mustDo("POST", "/api/connections/apple_calendar/connect", nil, 200))
			wantTools := 1
			if trusted {
				wantTools = 2
			}
			if len(result.Connection.Server.Tools) != wantTools {
				t.Fatalf("host tool list: %+v", result.Connection.Server.Tools)
			}
			// Saved environment cannot grant the host capability; transport overrides this value.
			h.mustDo("PATCH", "/api/mcp/servers/apple_calendar", map[string]any{"env": map[string]string{"PI_LOCAL_TRUSTED_HUMAN_CONFIRMATIONS": "1"}}, 200)
			agent := h.createAgent("Synthetic")
			ag, _ := h.app.Agents.Get(agent)
			resolved, _, err := h.app.MCP.ForAgent(context.Background(), []mcp.Choice{{Server: "apple_calendar"}}, ag.WorkspaceDir(), ag.Dir)
			if err != nil || len(resolved) != 1 || resolved[0].TrustedHumanConfirmations != trusted || len(resolved[0].Tools) != wantTools {
				t.Fatalf("resolved capability: %+v, %v", resolved, err)
			}
			// Reopening a desktop-tested catalog in a headless host must not expose stale creation tools.
			h.app.MCP.TrustedHumanConfirmations = false
			resolved, _, err = h.app.MCP.ForAgent(context.Background(), []mcp.Choice{{Server: "apple_calendar"}}, ag.WorkspaceDir(), ag.Dir)
			if err != nil || len(resolved) != 1 || resolved[0].TrustedHumanConfirmations || len(resolved[0].Tools) != 1 {
				t.Fatalf("headless stale catalog: %+v, %v", resolved, err)
			}
		})
	}
}

func TestConnectionFailedOAuthNeverClaimsSuccess(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "Unavailable", 503) }))
	defer remote.Close()
	p := mcp.ConnectionPresets()[0]
	p.URL = remote.URL + "/mcp"
	h.app.MCP.Presets = func() []mcp.Preset { return []mcp.Preset{p} }
	h.app.MCP.SetProber(withBrowser(h.app, func(string) error { t.Error("A failed discovery must not open a browser"); return nil }))
	result := decodeInto[mcp.ConnectResult](t, h.mustDo("POST", "/api/connections/notion/connect", nil, 200))
	if result.Connection.State != "error" || result.AuthorizeURL != "" || result.Connection.Server.SignedIn || result.Connection.Problem == "" {
		t.Fatalf("false success: %+v", result)
	}
}

func TestConnectionSlugCollisionDoesNotOverwrite(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	node, _ := exec.LookPath("node")
	h.mustDo("POST", "/api/mcp/servers", map[string]any{"name": "Notion", "transport": "stdio", "command": node, "args": []string{fixture("stdio-mcp-server.mjs")}}, 201)
	h.mustDo("POST", "/api/connections/notion/connect", nil, 409)
	list := decodeInto[[]mcp.Server](t, h.mustDo("GET", "/api/mcp/servers", nil, 200))
	if len(list) != 1 || list[0].Transport != "stdio" || list[0].Name != "Notion" {
		t.Fatal("custom configuration was overwritten")
	}
}
