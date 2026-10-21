package mcp

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"runtime"
	"strings"
)

// Sources checked 2026-10-21 (official service docs, not a third-party endpoint directory):
// Notion: https://developers.notion.com/guides/mcp/build-mcp-client (HTTP, OAuth PKCE + DCR).
// Linear: https://linear.app/docs/mcp (HTTP, OAuth 2.1 + DCR; /sse is legacy).
// Atlassian: https://support.atlassian.com/atlassian-ai-gateway/docs/how-to-upgrade-from-atlassian-mcp-v1-to-atlassian-mcp-v2/
// and https://support.atlassian.com/atlassian-ai-gateway/docs/configure-oauth-2-1/
// (v2 HTTP, OAuth; tools=all gives flat tools rather than opaque execute calls).
// GitHub: https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md
// and docs/remote-server.md (HTTP; OAuth needs pre-registration, NO DCR; PAT is a separate option).
// Asana: https://developers.asana.com/docs/integrating-with-asanas-mcp-server
// (v2 HTTP, pre-registered MCP OAuth app + secret; NO DCR; old /sse retired August 2026).
// Microsoft community option: https://github.com/Softeria/ms-365-mcp-server
// (stdio/device login or self-hosted HTTP/OAuth; shared app available for some scopes, custom Entra app
// recommended for production; its own token store is not Pi Local's secrets.Store, so no automatic install).
// Microsoft first-party alternative: https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/mcp-authentication
// (Agent 365 MCP requires a Frontier tenant, own Entra app and admin consent; not a general consumer endpoint).
// Google first-party: https://developers.google.com/workspace/guides/configure-mcp-servers
// (updated 2026-10-19; HTTP, own Google OAuth client ID/secret + consent screen/MCP API setup).
// Considered https://github.com/taylorwilsdon/google_workspace_mcp, but prefer Google's hosted servers.
// Apple: bundled first-party code, no downloaded package or credentials. Automation permissions are
// requested only when a tool is called, NOT by connecting/testing tools/list. Mutations elicit confirmation.
const ConnectionsChecked = "2026-10-21"

type Preset struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Icon        string   `json:"icon"`
	Group       string   `json:"group"`
	Description string   `json:"description"`
	Transport   string   `json:"transport"`
	URL         string   `json:"url,omitempty"`
	Command     string   `json:"command,omitempty"`
	Auth        string   `json:"auth"`
	DocsURL     string   `json:"docsUrl"`
	Advanced    bool     `json:"advanced"`
	Setup       []string `json:"setup"`
	// Automatic is deliberately false for flows the runtime cannot perform.
	Automatic bool `json:"automatic"`
}

func ConnectionPresets() []Preset {
	return []Preset{
		{ID: "notion", Name: "Notion", Icon: "notebook", Group: "apps", Description: "Find, read and update pages in your Notion workspace.", Transport: "http", URL: "https://mcp.notion.com/mcp", Auth: "oauth", DocsURL: "https://developers.notion.com/guides/mcp/build-mcp-client", Automatic: true, Setup: []string{"Sign in in your browser and choose a workspace."}},
		{ID: "github", Name: "GitHub", Icon: "github", Group: "apps", Description: "Work with repositories, issues and pull requests.", Transport: "http", URL: "https://api.githubcopilot.com/mcp/", Auth: "oauth-app-or-token", DocsURL: "https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md", Advanced: true, Setup: []string{"GitHub does not support dynamic client registration. Pi Local cannot yet use a pre-registered OAuth app.", "For now, use Custom connections: HTTP, this endpoint, OAuth off, Authorization: Bearer <a fine-grained PAT>. Choose only the repository permissions you need. This is token authentication, not OAuth sign-in."}},
		{ID: "linear", Name: "Linear", Icon: "layers", Group: "apps", Description: "Find and manage issues, projects and teams.", Transport: "http", URL: "https://mcp.linear.app/mcp", Auth: "oauth", DocsURL: "https://linear.app/docs/mcp", Automatic: true, Setup: []string{"Sign in in your browser and choose your Linear workspace."}},
		{ID: "atlassian", Name: "Atlassian", Icon: "workflow", Group: "apps", Description: "Work with Jira issues and Confluence pages.", Transport: "http", URL: "https://mcp.atlassian.com/v2/mcp?tools=all", Auth: "oauth", DocsURL: "https://support.atlassian.com/atlassian-ai-gateway/docs/how-to-upgrade-from-atlassian-mcp-v1-to-atlassian-mcp-v2/", Automatic: true, Setup: []string{"Sign in in your browser. Your organization may need to allow this client. Rovo credit limits may apply."}},
		{ID: "asana", Name: "Asana", Icon: "list-checks", Group: "apps", Description: "Work with tasks, projects and teams in Asana.", Transport: "http", URL: "https://mcp.asana.com/v2/mcp", Auth: "oauth-app", DocsURL: "https://developers.asana.com/docs/integrating-with-asanas-mcp-server", Advanced: true, Setup: []string{"Create an MCP OAuth app in Asana's developer console; configure redirects and workspace access.", "Asana v2 requires a client ID and secret and does not support dynamic registration. Pi Local does not yet support this flow. Do not use the retired /sse endpoint."}},
		{ID: "microsoft365", Name: "Microsoft 365", Icon: "mail", Group: "mail", Description: "Outlook mail and calendar, and OneDrive files.", Transport: "stdio", Command: "npx @softeria/ms-365-mcp-server", Auth: "external-oauth", DocsURL: "https://github.com/Softeria/ms-365-mcp-server", Advanced: true, Setup: []string{"Community server, not a Microsoft-hosted endpoint. Install and review it yourself; it manages its own tokens outside Pi Local.", "For production, register an Entra OAuth app, choose Graph scopes and arrange admin consent. A shared app/device login is available for some accounts and scopes.", "Follow its setup guide, then add a custom stdio connection or your own Streamable HTTP server. Pi Local does not install it or sign you in automatically.", "Microsoft also offers Agent 365 MCP for Frontier tenants, requiring an Entra app and admin consent: https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/mcp-authentication"}},
		googlePreset("google", "Gmail", "mail", "Read and work with Gmail messages through Google's first-party server.", "https://gmailmcp.googleapis.com/mcp/v1"),
		googlePreset("google_calendar", "Google Calendar", "calendar", "Work with calendar events through Google's first-party server.", "https://calendarmcp.googleapis.com/mcp/v1"),
		googlePreset("google_drive", "Google Drive", "notebook", "Find and work with files through Google's first-party server.", "https://drivemcp.googleapis.com/mcp/v1"),
		applePreset("calendar", "Apple Calendar", "calendar", "Read a bounded date range and create events after confirmation."),
		applePreset("reminders", "Apple Reminders", "list-checks", "Read reminders and create reminders after confirmation."),
		applePreset("notes", "Apple Notes", "notebook", "Search note titles and read short plain-text excerpts."),
	}
}
func googlePreset(id, name, icon, description, endpoint string) Preset {
	return Preset{ID: id, Name: name, Icon: icon, Group: "mail", Description: description, Transport: "http", URL: endpoint, Auth: "oauth-app", DocsURL: "https://developers.google.com/workspace/guides/configure-mcp-servers", Advanced: true, Setup: []string{
		"Google's official hosted server. Create a Google Cloud project, enable the corresponding Workspace MCP API and configure the OAuth consent screen.",
		"Create an OAuth client for an AI-powered agent, with the correct redirect URI, client ID and client secret. See Google's guide for scopes and offline access.",
		"Pi Local cannot yet configure pre-registered OAuth app credentials. Use a client or trusted gateway that supports them; add a custom connection only after its authentication is configured. Do not paste a client secret as a bearer token.",
	}}
}
func applePreset(id, name, icon, description string) Preset {
	return Preset{ID: "apple_" + id, Name: name, Icon: icon, Group: "computer", Description: description, Transport: "stdio", Command: "bundled runtime: apple-mcp " + id, Auth: "macos-permission", DocsURL: "https://support.apple.com/guide/mac-help/allow-apps-to-control-other-apps-mchl108e1718/mac", Automatic: runtime.GOOS == "darwin", Setup: []string{"macOS only. No download or account sign-in. The first tool call may open the app and ask for Automation permission in System Settings → Privacy & Security.", "Connecting lists tools only; it does not read personal data or verify app permissions. Event and reminder creation always asks for confirmation. Disconnect removes Pi Local access, not macOS permissions."}}
}

type Connection struct {
	Preset
	CheckedAt string  `json:"checkedAt"`
	State     string  `json:"state"`
	Server    *Server `json:"server"`
	UsedBy    []Ref   `json:"usedBy"`
	Problem   string  `json:"problem,omitempty"`
}

func (c *Catalog) presets() []Preset {
	if c.Presets != nil {
		return c.Presets()
	}
	return ConnectionPresets()
}
func (c *Catalog) preset(id string) (Preset, error) {
	for _, p := range c.presets() {
		if p.ID == id {
			return p, nil
		}
	}
	return Preset{}, ErrNotFound
}
func (c *Catalog) presetInput(p Preset) (Input, error) {
	in := Input{Slug: &p.ID, Name: &p.Name, Description: &p.Description, Transport: &p.Transport}
	oauth := p.Auth == "oauth"
	in.OAuth = &oauth
	if p.Transport == "http" {
		in.URL = &p.URL
		return in, nil
	}
	if !strings.HasPrefix(p.ID, "apple_") || c.prober == nil {
		return Input{}, bad("setup_required", "Follow the setup guide in Custom connections.")
	}
	command := c.prober.Runtime.Node
	args := append(append([]string{}, c.prober.Runtime.Args...), c.prober.Runtime.Script, "apple-mcp", strings.TrimPrefix(p.ID, "apple_"))
	in.Command = &command
	in.Args = &args
	// Source/dev runtimes use a relative script and --import tsx. Resolve both from the runtime,
	// not from the MCP probe's scratch folder or an agent's workspace.
	in.Cwd = &c.prober.Runtime.Dir
	return in, nil
}

// A slug alone never makes an unrelated custom server a curated connection.
func (c *Catalog) matches(p Preset, s *Server) bool {
	if p.Transport != s.Transport {
		return false
	}
	if p.Transport == "http" {
		return s.URL != nil && *s.URL == p.URL && (p.Auth != "oauth" || s.OAuth)
	}
	in, err := c.presetInput(p)
	return err == nil && s.Command != nil && *s.Command == *in.Command && s.Cwd != nil && *s.Cwd == *in.Cwd && reflect.DeepEqual(s.Args, *in.Args)
}
func (c *Catalog) connection(p Preset, servers []*Server) Connection {
	out := Connection{Preset: p, CheckedAt: ConnectionsChecked, State: "not_connected", UsedBy: []Ref{}}
	for i := range servers {
		s := servers[i]
		if !c.matches(p, s) {
			continue
		}
		out.Server = s
		out.UsedBy = s.UsedBy
		if out.UsedBy == nil {
			out.UsedBy = []Ref{}
		}
		switch {
		case !s.Enabled:
			out.State = "error"
			out.Problem = "This connection is disabled. Enable it in Custom connections."
		case s.LastError != nil && !strings.Contains(*s.LastError, "needs_sign_in"):
			out.State = "error"
			out.Problem = *s.LastError
		case s.OAuth && (!s.SignedIn || s.LastError != nil && strings.Contains(*s.LastError, "needs_sign_in")):
			out.State = "needs_sign_in"
		case s.LastError != nil:
			out.State = "error"
			out.Problem = *s.LastError
		case s.TestedAt == nil:
			out.State = "error"
			out.Problem = "Test this connection in Custom connections."
		default:
			out.State = "connected"
		}
		return out
	}
	return out
}
func (c *Catalog) Connections(ctx context.Context) ([]Connection, error) {
	servers, err := c.List(ctx)
	if err != nil {
		return nil, err
	}
	out := []Connection{}
	for _, p := range c.presets() {
		out = append(out, c.connection(p, servers))
	}
	return out, nil
}

type ConnectResult struct {
	Connection   Connection `json:"connection"`
	AuthorizeURL string     `json:"authorizeUrl,omitempty"`
}

// Connect reuses server creation, testing and OAuth. A failed probe remains an error, never a fake success.
func (c *Catalog) Connect(ctx context.Context, id string) (*ConnectResult, error) {
	p, err := c.preset(id)
	if err != nil {
		return nil, err
	}
	if !p.Automatic {
		return nil, &Error{Status: http.StatusConflict, Code: "setup_required", Message: "This connection needs advanced setup. Follow its setup guide."}
	}
	servers, err := c.List(ctx)
	if err != nil {
		return nil, err
	}
	state := c.connection(p, servers)
	s := state.Server
	if s == nil {
		in, err := c.presetInput(p)
		if err != nil {
			return nil, err
		}
		s, err = c.Create(ctx, in, "")
		if err != nil {
			return nil, err
		}
	} else if !s.Enabled {
		enabled := true
		s, err = c.Update(ctx, s.Slug, Input{Enabled: &enabled})
		if err != nil {
			return nil, err
		}
	}
	authorize := ""
	if s.OAuth && (!s.SignedIn || s.LastError != nil && strings.Contains(*s.LastError, "needs_sign_in")) {
		authorize, err = c.SignIn(ctx, s.Slug)
	} else {
		s, err = c.Test(ctx, s.Slug)
	}
	if err != nil {
		return nil, err
	}
	s, err = c.Get(ctx, s.Slug)
	if err != nil {
		return nil, err
	}
	return &ConnectResult{Connection: c.connection(p, []*Server{s}), AuthorizeURL: authorize}, nil
}

// Disconnect uses the existing in-use guard: detach agents first, then remove secrets and the server.
func (c *Catalog) Disconnect(ctx context.Context, id string) error {
	p, err := c.preset(id)
	if err != nil {
		return err
	}
	servers, err := c.List(ctx)
	if err != nil {
		return err
	}
	state := c.connection(p, servers)
	if state.Server == nil {
		return nil
	}
	// Do not delete a connection while an OAuth callback can still save fresh tokens.
	if _, busy := c.signings.Load(state.Server.Slug); busy {
		return &Error{Status: 409, Code: "signing_in", Message: "Finish the sign-in or wait for it to expire before disconnecting."}
	}
	err = c.Delete(ctx, state.Server.Slug)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}
