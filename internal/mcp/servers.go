// Package mcp is the app's catalog of MCP servers: their configuration (secrets in the OS keychain), the tools the
// last test found, testing and OAuth sign-in through the runtime's probe (runtime.mjs mcp-probe), each agent's
// resolved MCP_SERVERS, the OAuth state runtimes read and refresh, and importing servers from other apps' configs.
package mcp

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/ncecere/pi-local/internal/secrets"
)

// Tool is one of a server's tools, from its last test.
type Tool struct {
	Name         string          `json:"name"`
	Title        *string         `json:"title"`
	Description  *string         `json:"description"`
	InputSchema  json.RawMessage `json:"inputSchema,omitempty"`
	ModelVisible bool            `json:"modelVisible"`
}

// Ref names an agent using a server.
type Ref struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Server is a server as the UI sees it.
type Server struct {
	Slug         string    `json:"slug"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	Transport    string    `json:"transport"`
	Command      *string   `json:"command"`
	Args         []string  `json:"args"`
	Cwd          *string   `json:"cwd"`
	EnvNames     []string  `json:"envNames"`
	URL          *string   `json:"url"`
	HeaderNames  []string  `json:"headerNames"`
	OAuth        bool      `json:"oauth"`
	SignedIn     bool      `json:"signedIn"`
	Enabled      bool      `json:"enabled"`
	Tools        []Tool    `json:"tools"`
	TestedAt     *int64    `json:"testedAt"`
	LastError    *string   `json:"lastError"`
	UsedBy       []Ref     `json:"usedBy"`
	ImportedFrom *string   `json:"importedFrom"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`

	redirectURL string
}

// Input is a server to add, or changes to one.
type Input struct {
	Slug        *string            `json:"slug"`
	Name        *string            `json:"name"`
	Description *string            `json:"description"`
	Transport   *string            `json:"transport"`
	Command     *string            `json:"command"`
	Args        *[]string          `json:"args"`
	Cwd         *string            `json:"cwd"`
	Env         *map[string]string `json:"env"`
	URL         *string            `json:"url"`
	Headers     *map[string]string `json:"headers"`
	// EnvSet/HeadersSet change or add some values and EnvRemove/HeadersRemove drop some, keeping the rest (Env and
	// Headers replace them all). Applied after Env/Headers: remove, then set.
	EnvSet        map[string]string `json:"envSet"`
	EnvRemove     []string          `json:"envRemove"`
	HeadersSet    map[string]string `json:"headersSet"`
	HeadersRemove []string          `json:"headersRemove"`
	OAuth         *bool             `json:"oauth"`
	Enabled       *bool             `json:"enabled"`
}

// Error is a failure for people.
type Error struct {
	Status  int
	Code    string
	Message string
	Details map[string]any
}

func (e *Error) Error() string { return e.Message }

func bad(code, format string, args ...any) error {
	return &Error{Status: http.StatusBadRequest, Code: code, Message: fmt.Sprintf(format, args...)}
}

// ErrNotFound: no such server.
var ErrNotFound = &Error{Status: http.StatusNotFound, Code: "not_found", Message: "MCP server not found"}

// Catalog keeps the servers.
type Catalog struct {
	db      *sql.DB
	secrets secrets.Store
	// UsedBy lists the agents using a server (set by the app).
	UsedBy func(slug string) []Ref
	// OnChange is told after a server changes (nil: deleted).
	OnChange func(slug string, s *Server)

	mu       sync.Mutex
	oauthMu  sync.Map // slug → *sync.Mutex: OAuth state saves one at a time per server
	prober   *Prober
	signings sync.Map // slug → struct{}: a sign-in in progress
}

// New makes the catalog.
func New(db *sql.DB, store secrets.Store) *Catalog {
	return &Catalog{db: db, secrets: store, UsedBy: func(string) []Ref { return nil }, OnChange: func(string, *Server) {}}
}

// SetProber gives the catalog a way to test servers.
func (c *Catalog) SetProber(p *Prober) { c.prober = p }

func envKey(slug string) string     { return "mcp:" + slug + ":env" }
func headersKey(slug string) string { return "mcp:" + slug + ":headers" }
func oauthKey(slug string) string   { return "mcp:" + slug + ":oauth" }

var slugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_]{0,30}[a-z0-9])?$`)

// Slug makes a server slug from a name.
func Slug(name string) string {
	var b strings.Builder
	under := false
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			under = false
		case !under && b.Len() > 0:
			b.WriteByte('_')
			under = true
		}
	}
	s := strings.Trim(b.String(), "_")
	if len(s) > 32 {
		s = strings.Trim(s[:32], "_")
	}
	return s
}

var nameToken = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
var headerName = regexp.MustCompile(`^[A-Za-z0-9!#$%&'*+.^_|~-]{1,64}$`)

var reservedHeaders = map[string]bool{
	"host": true, "content-type": true, "content-length": true, "content-encoding": true, "transfer-encoding": true,
	"connection": true, "accept": true, "accept-encoding": true, "mcp-session-id": true, "mcp-protocol-version": true,
	"last-event-id": true, "proxy-authorization": true,
}

func checkEnv(env map[string]string) error {
	if len(env) > 50 {
		return bad("invalid_env", "At most 50 environment variables.")
	}
	for k, v := range env {
		if !nameToken.MatchString(k) {
			return bad("invalid_env", "%q isn't an environment variable name.", k)
		}
		if len(v) > 16<<10 || strings.ContainsRune(v, 0) {
			return bad("invalid_env", "The value of %s is too long.", k)
		}
	}
	return nil
}

func checkHeaders(h map[string]string) error {
	if len(h) > 20 {
		return bad("invalid_headers", "At most 20 headers.")
	}
	for k, v := range h {
		if !headerName.MatchString(k) || reservedHeaders[strings.ToLower(k)] {
			return bad("invalid_headers", "%q can't be used as a header.", k)
		}
		if len(v) > 4096 || strings.ContainsAny(v, "\r\n") {
			return bad("invalid_headers", "The value of %s must be one line of at most 4,096 characters.", k)
		}
	}
	return nil
}

func checkURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.Fragment != "" {
		return "", bad("invalid_url", "Give the server's URL, like https://mcp.example.com/mcp.")
	}
	if u.Scheme == "http" && !localHost(u.Hostname()) {
		return "", bad("invalid_url", "Use https for a server on the internet (http is only for servers on this computer or your network).")
	}
	return raw, nil
}

func localHost(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast())
}

func names[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func jsonOf(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

const cols = `slug, name, description, transport, command, args, cwd, env_names, url, header_names, oauth, oauth_redirect_url, enabled, tools, tested_at, last_error, imported_from, created_at, updated_at`

func (c *Catalog) scan(row interface{ Scan(...any) error }) (*Server, error) {
	var s Server
	var command, cwd, url, redirect, lastErr, imported sql.NullString
	var args, envNames, headerNames, tools string
	var oauth, enabled int
	var tested sql.NullInt64
	var created, updated int64
	if err := row.Scan(&s.Slug, &s.Name, &s.Description, &s.Transport, &command, &args, &cwd, &envNames, &url, &headerNames, &oauth, &redirect, &enabled, &tools, &tested, &lastErr, &imported, &created, &updated); err != nil {
		return nil, err
	}
	str := func(n sql.NullString) *string {
		if n.Valid {
			v := n.String
			return &v
		}
		return nil
	}
	s.Command, s.Cwd, s.URL, s.LastError, s.ImportedFrom = str(command), str(cwd), str(url), str(lastErr), str(imported)
	s.redirectURL = redirect.String
	json.Unmarshal([]byte(args), &s.Args)
	json.Unmarshal([]byte(envNames), &s.EnvNames)
	json.Unmarshal([]byte(headerNames), &s.HeaderNames)
	json.Unmarshal([]byte(tools), &s.Tools)
	for _, p := range []*[]string{&s.Args, &s.EnvNames, &s.HeaderNames} {
		if *p == nil {
			*p = []string{}
		}
	}
	if s.Tools == nil {
		s.Tools = []Tool{}
	}
	s.OAuth, s.Enabled = oauth != 0, enabled != 0
	if tested.Valid {
		s.TestedAt = &tested.Int64
	}
	s.CreatedAt, s.UpdatedAt = time.UnixMilli(created), time.UnixMilli(updated)
	return &s, nil
}

// decorate fills in what isn't stored in the row: who uses it, and whether it is signed in.
func (c *Catalog) decorate(s *Server) *Server {
	s.UsedBy = c.UsedBy(s.Slug)
	if s.UsedBy == nil {
		s.UsedBy = []Ref{}
	}
	if s.OAuth {
		s.SignedIn = c.hasTokens(s.Slug)
	}
	return s
}

// List returns every server, by name.
func (c *Catalog) List(ctx context.Context) ([]*Server, error) {
	rows, err := c.db.QueryContext(ctx, `SELECT `+cols+` FROM mcp_servers ORDER BY name COLLATE NOCASE, slug`)
	if err != nil {
		return nil, err
	}
	var out []*Server
	for rows.Next() {
		s, err := c.scan(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, s)
	}
	rows.Close()
	for _, s := range out {
		c.decorate(s)
	}
	if out == nil {
		out = []*Server{}
	}
	return out, rows.Err()
}

// Get returns one server.
func (c *Catalog) Get(ctx context.Context, slug string) (*Server, error) {
	s, err := c.scan(c.db.QueryRowContext(ctx, `SELECT `+cols+` FROM mcp_servers WHERE slug = ?`, slug))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return c.decorate(s), nil
}

// Exists reports whether a server has that slug.
func (c *Catalog) Exists(slug string) bool {
	var n int
	c.db.QueryRow(`SELECT COUNT(*) FROM mcp_servers WHERE slug = ?`, slug).Scan(&n)
	return n > 0
}

func (in Input) envPatched() bool     { return len(in.EnvSet) > 0 || len(in.EnvRemove) > 0 }
func (in Input) headersPatched() bool { return len(in.HeadersSet) > 0 || len(in.HeadersRemove) > 0 }

// patched is m without remove's names and with set's values (a copy; m is left alone).
func patched(m map[string]string, remove []string, set map[string]string) map[string]string {
	if len(remove) == 0 && len(set) == 0 {
		return m
	}
	out := make(map[string]string, len(m)+len(set))
	for k, v := range m {
		out[k] = v
	}
	for _, k := range remove {
		delete(out, k)
	}
	for k, v := range set {
		out[k] = v
	}
	return out
}

// Secret is one stored environment variable's or header's value, for the person who added it to see again.
func (c *Catalog) Secret(ctx context.Context, slug, kind, name string) (string, error) {
	if _, err := c.Get(ctx, slug); err != nil {
		return "", err
	}
	var key string
	switch kind {
	case "env":
		key = envKey(slug)
	case "header":
		key = headersKey(slug)
	default:
		return "", bad("invalid_kind", "Ask for an env value or a header.")
	}
	m, err := c.secretMap(key)
	if err != nil {
		return "", err
	}
	v, ok := m[name]
	if !ok {
		return "", &Error{Status: http.StatusNotFound, Code: "not_found", Message: name + " isn't set."}
	}
	return v, nil
}

func (c *Catalog) secretMap(key string) (map[string]string, error) {
	raw, err := c.secrets.Get(key)
	if errors.Is(err, secrets.ErrNotFound) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	json.Unmarshal([]byte(raw), &out)
	return out, nil
}

func (c *Catalog) storeMap(key string, m map[string]string) error {
	if len(m) == 0 {
		return c.secrets.Delete(key)
	}
	return c.secrets.Set(key, jsonOf(m))
}

type draft struct {
	Server
	env, headers map[string]string
}

func (c *Catalog) validate(d *draft) error {
	d.Name = strings.TrimSpace(d.Name)
	d.Description = strings.TrimSpace(d.Description)
	if d.Name == "" || utf8.RuneCountInString(d.Name) > 60 || strings.ContainsAny(d.Name, "\r\n") {
		return bad("invalid_name", "A name of 1 to 60 characters, on one line.")
	}
	if utf8.RuneCountInString(d.Description) > 500 {
		return bad("invalid_description", "A description is at most 500 characters.")
	}
	switch d.Transport {
	case "stdio":
		if d.Command == nil || strings.TrimSpace(*d.Command) == "" || len(*d.Command) > 1000 {
			return bad("invalid_command", "Give the command that starts the server (for example npx).")
		}
		cmd := strings.TrimSpace(*d.Command)
		d.Command = &cmd
		if len(d.Args) > 100 {
			return bad("invalid_command", "At most 100 arguments.")
		}
		for _, a := range d.Args {
			if len(a) > 4096 || strings.ContainsRune(a, 0) {
				return bad("invalid_command", "An argument is too long.")
			}
		}
		if err := checkEnv(d.env); err != nil {
			return err
		}
		d.URL, d.OAuth, d.headers = nil, false, nil
	case "http":
		if d.URL == nil {
			return bad("invalid_url", "Give the server's URL.")
		}
		u, err := checkURL(*d.URL)
		if err != nil {
			return err
		}
		d.URL = &u
		if err := checkHeaders(d.headers); err != nil {
			return err
		}
		d.Command, d.Args, d.Cwd, d.env = nil, []string{}, nil, nil
	default:
		return bad("invalid_transport", "A server is stdio (a program on this computer) or http (a remote server).")
	}
	return nil
}

func (in Input) apply(d *draft) {
	if in.Name != nil {
		d.Name = *in.Name
	}
	if in.Description != nil {
		d.Description = *in.Description
	}
	if in.Transport != nil {
		d.Transport = *in.Transport
	}
	if in.Command != nil {
		d.Command = in.Command
	}
	if in.Args != nil {
		d.Args = *in.Args
	}
	if in.Cwd != nil {
		if strings.TrimSpace(*in.Cwd) == "" {
			d.Cwd = nil
		} else {
			v := strings.TrimSpace(*in.Cwd)
			d.Cwd = &v
		}
	}
	if in.Env != nil {
		d.env = *in.Env
	}
	d.env = patched(d.env, in.EnvRemove, in.EnvSet)
	if in.URL != nil {
		d.URL = in.URL
	}
	if in.Headers != nil {
		d.headers = *in.Headers
	}
	d.headers = patched(d.headers, in.HeadersRemove, in.HeadersSet)
	if in.OAuth != nil {
		d.OAuth = *in.OAuth
	}
	if in.Enabled != nil {
		d.Enabled = *in.Enabled
	}
}

func nullable(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// Create adds a server (then tests it, when a prober is set).
func (c *Catalog) Create(ctx context.Context, in Input, importedFrom string) (*Server, error) {
	c.mu.Lock()
	d := &draft{Server: Server{Enabled: true, Args: []string{}}}
	in.apply(d)
	slug := Slug(d.Name)
	if in.Slug != nil && *in.Slug != "" {
		slug = *in.Slug
	}
	if !slugPattern.MatchString(slug) {
		c.mu.Unlock()
		return nil, bad("invalid_slug", "A slug is 1 to 32 lowercase letters, digits or _ (not at either end).")
	}
	if err := c.validate(d); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	if c.Exists(slug) {
		c.mu.Unlock()
		return nil, &Error{Status: http.StatusConflict, Code: "slug_taken", Message: fmt.Sprintf("There is already an MCP server %q.", slug)}
	}
	if err := c.storeMap(envKey(slug), d.env); err != nil {
		c.mu.Unlock()
		return nil, fmt.Errorf("storing the environment in the keychain: %w", err)
	}
	if err := c.storeMap(headersKey(slug), d.headers); err != nil {
		c.secrets.Delete(envKey(slug))
		c.mu.Unlock()
		return nil, fmt.Errorf("storing the headers in the keychain: %w", err)
	}
	now := time.Now().UnixMilli()
	var imported any
	if importedFrom != "" {
		imported = importedFrom
	}
	_, err := c.db.ExecContext(ctx, `INSERT INTO mcp_servers (slug, name, description, transport, command, args, cwd, env_names, url, header_names, oauth, enabled, imported_from, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
		slug, d.Name, d.Description, d.Transport, nullable(d.Command), jsonOf(d.Args), nullable(d.Cwd), jsonOf(names(d.env)),
		nullable(d.URL), jsonOf(names(d.headers)), boolInt(d.OAuth), imported, now, now)
	c.mu.Unlock()
	if err != nil {
		c.secrets.Delete(envKey(slug))
		c.secrets.Delete(headersKey(slug))
		return nil, err
	}
	if c.prober != nil {
		return c.Test(ctx, slug)
	}
	return c.Get(ctx, slug)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Update changes a server; env and headers, when given, replace all values. Agents using it restart (OnChange).
func (c *Catalog) Update(ctx context.Context, slug string, in Input) (*Server, error) {
	c.mu.Lock()
	cur, err := c.Get(ctx, slug)
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	d := &draft{Server: *cur}
	if d.env, err = c.secretMap(envKey(slug)); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	if d.headers, err = c.secretMap(headersKey(slug)); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	in.apply(d)
	if err := c.validate(d); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	if in.Env != nil || in.envPatched() || d.Transport != cur.Transport {
		if err := c.storeMap(envKey(slug), d.env); err != nil {
			c.mu.Unlock()
			return nil, err
		}
	}
	if in.Headers != nil || in.headersPatched() || d.Transport != cur.Transport {
		if err := c.storeMap(headersKey(slug), d.headers); err != nil {
			c.mu.Unlock()
			return nil, err
		}
	}
	// What connects to the server changed: what the last test found may not hold any more (tools stay until the
	// next test, which runs below).
	connection := in.Command != nil || in.Args != nil || in.Cwd != nil || in.Env != nil || in.envPatched() || in.URL != nil || in.Headers != nil || in.headersPatched() || in.OAuth != nil || in.Transport != nil
	_, err = c.db.ExecContext(ctx, `UPDATE mcp_servers SET name = ?, description = ?, transport = ?, command = ?, args = ?, cwd = ?, env_names = ?, url = ?, header_names = ?, oauth = ?, enabled = ?, updated_at = ? WHERE slug = ?`,
		d.Name, d.Description, d.Transport, nullable(d.Command), jsonOf(d.Args), nullable(d.Cwd), jsonOf(names(d.env)),
		nullable(d.URL), jsonOf(names(d.headers)), boolInt(d.OAuth), boolInt(d.Enabled), time.Now().UnixMilli(), slug)
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if connection && c.prober != nil {
		return c.Test(ctx, slug)
	}
	s, err := c.Get(ctx, slug)
	if err == nil {
		c.OnChange(slug, s)
	}
	return s, err
}

// Delete removes a server and its keychain items. Refused while agents use it.
func (c *Catalog) Delete(ctx context.Context, slug string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.Exists(slug) {
		return ErrNotFound
	}
	if users := c.UsedBy(slug); len(users) > 0 {
		return &Error{Status: http.StatusConflict, Code: "in_use", Message: fmt.Sprintf("%d agent(s) use this server. Remove it from them first.", len(users)),
			Details: map[string]any{"agents": users}}
	}
	if _, err := c.db.ExecContext(ctx, `DELETE FROM mcp_servers WHERE slug = ?`, slug); err != nil {
		return err
	}
	c.secrets.Delete(envKey(slug))
	c.secrets.Delete(headersKey(slug))
	c.secrets.Delete(oauthKey(slug))
	c.OnChange(slug, nil)
	return nil
}

// recordTest keeps a test's outcome: the tools it found, or its error (the tools of the last good test stay).
func (c *Catalog) recordTest(ctx context.Context, slug string, tools []Tool, testErr string) {
	now := time.Now().UnixMilli()
	if testErr == "" {
		c.db.ExecContext(ctx, `UPDATE mcp_servers SET tools = ?, tested_at = ?, last_error = NULL WHERE slug = ?`, jsonOf(tools), now, slug)
	} else {
		c.db.ExecContext(ctx, `UPDATE mcp_servers SET last_error = ? WHERE slug = ?`, testErr, slug)
	}
}

func (c *Catalog) setRedirect(ctx context.Context, slug, redirect string) {
	c.db.ExecContext(ctx, `UPDATE mcp_servers SET oauth_redirect_url = ? WHERE slug = ?`, redirect, slug)
}

// --- OAuth state ------------------------------------------------------------------------------------------------

func (c *Catalog) lockFor(slug string) *sync.Mutex {
	m, _ := c.oauthMu.LoadOrStore(slug, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// OAuthState is a server's OAuth state as pi-mcp keeps it (opaque JSON), or nil.
func (c *Catalog) OAuthState(slug string) (json.RawMessage, error) {
	raw, err := c.secrets.Get(oauthKey(slug))
	if errors.Is(err, secrets.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// SaveOAuthState stores a server's OAuth state (saves are serialized per server).
func (c *Catalog) SaveOAuthState(slug string, state json.RawMessage) error {
	if len(state) > 64<<10 || !json.Valid(state) {
		return bad("invalid_state", "The sign-in state isn't valid.")
	}
	m := c.lockFor(slug)
	m.Lock()
	defer m.Unlock()
	return c.secrets.Set(oauthKey(slug), string(state))
}

func (c *Catalog) hasTokens(slug string) bool {
	raw, err := c.OAuthState(slug)
	if err != nil || raw == nil {
		return false
	}
	var st struct {
		Tokens *struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
		} `json:"tokens"`
	}
	json.Unmarshal(raw, &st)
	return st.Tokens != nil && (st.Tokens.AccessToken != "" || st.Tokens.RefreshToken != "")
}

// SignOut forgets a server's OAuth tokens (and its registration).
func (c *Catalog) SignOut(ctx context.Context, slug string) (*Server, error) {
	if !c.Exists(slug) {
		return nil, ErrNotFound
	}
	if err := c.secrets.Delete(oauthKey(slug)); err != nil {
		return nil, err
	}
	s, err := c.Get(ctx, slug)
	if err == nil {
		c.OnChange(slug, s)
	}
	return s, err
}

// --- what agents get --------------------------------------------------------------------------------------------

// Expand fills ${workspace} and ${agentDir} in a server's command line.
func Expand(s, workspace, agentDir string) string {
	return strings.NewReplacer("${workspace}", workspace, "${agentDir}", agentDir).Replace(s)
}

// RuntimeServer is one entry of MCP_SERVERS (runtime mcp.ts, McpServerConfig).
type RuntimeServer struct {
	Slug        string            `json:"slug"`
	Name        string            `json:"name"`
	Description string            `json:"description,omitempty"`
	Transport   string            `json:"transport"`
	URL         string            `json:"url,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	OAuth       *RuntimeOAuth     `json:"oauth,omitempty"`
	Command     string            `json:"command,omitempty"`
	Args        []string          `json:"args,omitempty"`
	Cwd         string            `json:"cwd,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	Tools       []RuntimeTool     `json:"tools"`
}

// RuntimeOAuth is how an agent's runtime refreshes a server's tokens.
type RuntimeOAuth struct {
	RedirectURL string `json:"redirectUrl"`
	ClientName  string `json:"clientName"`
}

// RuntimeTool is a tool as the runtime defines it.
type RuntimeTool struct {
	Name        string          `json:"name"`
	Title       string          `json:"title,omitempty"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// Choice is an agent's use of a server: all its tools (nil) or some.
type Choice struct {
	Server string
	Tools  []string
}

// ForAgent resolves an agent's servers into MCP_SERVERS entries (secrets and paths filled in). A server that is off,
// was never tested, or is gone is left out and named in skipped.
func (c *Catalog) ForAgent(ctx context.Context, choices []Choice, workspace, agentDir string) (out []RuntimeServer, skipped []string, err error) {
	for _, ch := range choices {
		s, err := c.Get(ctx, ch.Server)
		if err != nil {
			skipped = append(skipped, ch.Server+" (not found)")
			continue
		}
		if !s.Enabled {
			skipped = append(skipped, s.Slug+" (off)")
			continue
		}
		if s.TestedAt == nil {
			skipped = append(skipped, s.Slug+" (never tested: test it in Settings → MCP)")
			continue
		}
		rs, err := c.runtimeServer(s, ch, workspace, agentDir)
		if err != nil {
			return nil, nil, err
		}
		out = append(out, rs)
	}
	return out, skipped, nil
}

// runtimeServer is one server as an agent's runtime gets it: the chosen model-visible tools, paths expanded, secrets
// filled in.
func (c *Catalog) runtimeServer(s *Server, ch Choice, workspace, agentDir string) (RuntimeServer, error) {
	want := map[string]bool{}
	for _, t := range ch.Tools {
		want[t] = true
	}
	rs := RuntimeServer{Slug: s.Slug, Name: s.Name, Description: s.Description, Transport: s.Transport, Tools: []RuntimeTool{}}
	for _, t := range s.Tools {
		if !t.ModelVisible || (ch.Tools != nil && !want[t.Name]) {
			continue
		}
		rt := RuntimeTool{Name: t.Name, InputSchema: t.InputSchema}
		if t.Title != nil {
			rt.Title = *t.Title
		}
		if t.Description != nil {
			rt.Description = *t.Description
		}
		rs.Tools = append(rs.Tools, rt)
	}
	if s.Transport == "stdio" {
		rs.Command = Expand(*s.Command, workspace, agentDir)
		for _, a := range s.Args {
			rs.Args = append(rs.Args, Expand(a, workspace, agentDir))
		}
		rs.Cwd = workspace
		if s.Cwd != nil {
			rs.Cwd = Expand(*s.Cwd, workspace, agentDir)
		}
		env, err := c.secretMap(envKey(s.Slug))
		if err != nil {
			return RuntimeServer{}, err
		}
		if len(env) > 0 {
			rs.Env = map[string]string{}
			for k, v := range env {
				rs.Env[k] = Expand(v, workspace, agentDir)
			}
		}
	} else {
		rs.URL = *s.URL
		headers, err := c.secretMap(headersKey(s.Slug))
		if err != nil {
			return RuntimeServer{}, err
		}
		if len(headers) > 0 {
			rs.Headers = headers
		}
		if s.OAuth {
			redirect := s.redirectURL
			if redirect == "" {
				redirect = "http://127.0.0.1/pi-local-oauth-callback"
			}
			rs.OAuth = &RuntimeOAuth{RedirectURL: redirect, ClientName: "Pi Local"}
		}
	}
	return rs, nil
}
