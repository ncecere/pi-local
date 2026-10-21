// Package models is the model catalog: providers (an account at a model service), the models agents may use, the
// default model, discovering a provider's models, and what an agent's runtime needs to reach its model. Keys and
// header values are kept in the OS keychain (internal/secrets).
package models

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

// Kind is an API a provider speaks.
type Kind struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	API            string  `json:"api"` // the runtime's MODEL_API
	DefaultBaseURL *string `json:"defaultBaseUrl"`
	authHeader     string
	modelsPath     string
}

func ptr(s string) *string { return &s }

// Kinds are the APIs the runtime can use (runtime/src/lib/models.ts).
var Kinds = []Kind{
	{ID: "openai", Name: "OpenAI", API: "openai-responses", DefaultBaseURL: ptr("https://api.openai.com/v1"), authHeader: "authorization", modelsPath: "/models"},
	{ID: "anthropic", Name: "Anthropic", API: "anthropic-messages", DefaultBaseURL: ptr("https://api.anthropic.com"), authHeader: "x-api-key", modelsPath: "/v1/models?limit=1000"},
	{ID: "openai-compatible", Name: "OpenAI-compatible (chat completions)", API: "openai-completions", authHeader: "authorization", modelsPath: "/models"},
	{ID: "openai-responses", Name: "OpenAI Responses-compatible", API: "openai-responses", authHeader: "authorization", modelsPath: "/models"},
	{ID: "anthropic-compatible", Name: "Anthropic-compatible", API: "anthropic-messages", authHeader: "x-api-key", modelsPath: "/v1/models?limit=1000"},
}

// KindByID finds a kind.
func KindByID(id string) (Kind, bool) {
	for _, k := range Kinds {
		if k.ID == id {
			return k, true
		}
	}
	return Kind{}, false
}

// Preset is a starting point for adding a provider.
type Preset struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	BaseURL  string `json:"baseUrl"`
	NeedsKey bool   `json:"needsKey"`
	Note     string `json:"note"`
	// SignupURL is where a newcomer gets a key (or the software), for the first-run flow.
	SignupURL string `json:"signupUrl,omitempty"`
	// Local: runs on this computer; the first run looks for it (Detect).
	Local bool `json:"local,omitempty"`
	// KeyCheckPath: an endpoint (after the base URL) that needs a valid key, for a service whose model list is public,
	// so a wrong key is caught when it is set up.
	KeyCheckPath string `json:"-"`
}

// Presets are the services people use most.
var Presets = []Preset{
	{ID: "openai", Name: "OpenAI", Kind: "openai", BaseURL: "https://api.openai.com/v1", NeedsKey: true, Note: "An API key from platform.openai.com.", SignupURL: "https://platform.openai.com/api-keys"},
	{ID: "anthropic", Name: "Anthropic", Kind: "anthropic", BaseURL: "https://api.anthropic.com", NeedsKey: true, Note: "An API key from console.anthropic.com.", SignupURL: "https://console.anthropic.com/settings/keys"},
	{ID: "ollama", Name: "Ollama", Kind: "openai-compatible", BaseURL: "http://localhost:11434/v1", NeedsKey: false, Note: "Models running on this computer with Ollama. Pull a model first (ollama pull …).", SignupURL: "https://ollama.com/download", Local: true},
	{ID: "lm-studio", Name: "LM Studio", Kind: "openai-compatible", BaseURL: "http://localhost:1234/v1", NeedsKey: false, Note: "LM Studio's local server (Developer → Start server).", SignupURL: "https://lmstudio.ai", Local: true},
	{ID: "openrouter", Name: "OpenRouter", Kind: "openai-compatible", BaseURL: "https://openrouter.ai/api/v1", NeedsKey: true, Note: "Many providers' models through one key from openrouter.ai.", SignupURL: "https://openrouter.ai/keys", KeyCheckPath: "/key"},
	{ID: "cliproxyapi", Name: "CLIProxyAPI", Kind: "anthropic-compatible", BaseURL: "http://127.0.0.1:8317", NeedsKey: true, Note: "CLIProxyAPI on this computer: Claude (and other CLI subscriptions) through one local endpoint. The key is one of the api-keys in its config.yaml."},
	{ID: "litellm", Name: "LiteLLM", Kind: "openai-compatible", BaseURL: "http://localhost:4000/v1", NeedsKey: true, Note: "A LiteLLM proxy: its URL and a virtual key."},
	{ID: "other", Name: "OpenAI-compatible", Kind: "openai-compatible", BaseURL: "", NeedsKey: false, Note: "Any server with an OpenAI- or Anthropic-compatible API (vLLM, Together, Groq …). A key if the server needs one."},
}

// Provider is an account at a model service.
type Provider struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Kind        string    `json:"kind"`
	BaseURL     string    `json:"baseUrl"`
	HasKey      bool      `json:"hasKey"`
	HeaderNames []string  `json:"headerNames"`
	Enabled     bool      `json:"enabled"`
	Models      []*Model  `json:"models"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// Model is one model agents may use.
type Model struct {
	ID            string   `json:"id"` // provider/modelId
	Provider      string   `json:"provider"`
	ModelID       string   `json:"modelId"`
	Name          string   `json:"name"`
	ContextWindow int      `json:"contextWindow"`
	MaxTokens     int      `json:"maxTokens"`
	Reasoning     bool     `json:"reasoning"`
	Images        bool     `json:"images"`
	InputPrice    *float64 `json:"inputPrice"`
	OutputPrice   *float64 `json:"outputPrice"`
	Enabled       bool     `json:"enabled"`
	UsedBy        int      `json:"usedBy"`
}

// DemoModelID is the runtime's scripted model, always available.
const DemoModelID = "demo/demo-1"

// DemoModelName is how the demo model is called.
const DemoModelName = "Demo (scripted)"

// SplitModelID splits "provider/modelId" at the first slash.
func SplitModelID(id string) (provider, model string, ok bool) {
	provider, model, ok = strings.Cut(id, "/")
	return provider, model, ok && provider != "" && model != ""
}

// Error is a failure with a code and a message for people.
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

// ErrNotFound: no such provider or model.
var ErrNotFound = &Error{Status: http.StatusNotFound, Code: "not_found", Message: "Not found"}

// AgentRef names an agent (for "in use" answers).
type AgentRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Catalog is the model catalog.
type Catalog struct {
	db      *sql.DB
	secrets secrets.Store
	client  *http.Client
	// presetURLs replaces presets' base URLs (tests point Ollama at a fake server).
	presetURLs map[string]string

	// UsedBy lists the agents on a model ("provider/modelId"); set by the app.
	UsedBy func(modelID string) []AgentRef
	// OnChange is called after a provider or model changes (agents using it restart); set by the app.
	OnChange func(providerID string)

	mu sync.Mutex // serializes writes that touch the keychain and the database together
}

// New makes the catalog.
func New(db *sql.DB, store secrets.Store) *Catalog {
	return &Catalog{
		db:      db,
		secrets: store,
		client: &http.Client{
			Timeout: 20 * time.Second,
			// A provider's key goes to the host it was entered for, never one a redirect names.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		UsedBy:   func(string) []AgentRef { return nil },
		OnChange: func(string) {},
	}
}

func keyName(provider string) string     { return "provider:" + provider + ":key" }
func headersName(provider string) string { return "provider:" + provider + ":headers" }

var slugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`)

// Slug makes a provider ID from a name.
func Slug(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case !dash && b.Len() > 0:
			b.WriteByte('-')
			dash = true
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > 32 {
		s = strings.Trim(s[:32], "-")
	}
	return s
}

// reservedHeaders may not be set on a provider: the runtime and the HTTP client own them.
var reservedHeaders = map[string]bool{
	"host": true, "content-type": true, "content-length": true, "content-encoding": true, "transfer-encoding": true,
	"connection": true, "accept-encoding": true, "authorization": true, "x-api-key": true, "proxy-authorization": true,
}

var headerName = regexp.MustCompile(`^[A-Za-z0-9!#$%&'*+.^_|~-]{1,64}$`)

func checkHeaders(h map[string]string) error {
	if len(h) > 20 {
		return bad("invalid_headers", "At most 20 extra headers.")
	}
	for k, v := range h {
		if !headerName.MatchString(k) || reservedHeaders[strings.ToLower(k)] {
			return bad("invalid_headers", "%q can't be used as an extra header.", k)
		}
		if len(v) > 4096 || strings.ContainsAny(v, "\r\n") {
			return bad("invalid_headers", "The value of %s must be one line of at most 4,096 characters.", k)
		}
	}
	return nil
}

// checkBaseURL accepts https anywhere and http for servers on this computer or the local network (Ollama, LM Studio).
func checkBaseURL(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", bad("invalid_base_url", "Give the provider's base URL, like https://api.example.com/v1.")
	}
	if u.Scheme == "http" && !localHost(u.Hostname()) {
		return "", bad("invalid_base_url", "Use https for a provider on the internet (http is only for servers on this computer or your network).")
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

// --- reading --------------------------------------------------------------------------------------------------

const providerCols = `id, name, kind, base_url, has_key, header_names, enabled, created_at, updated_at`

func scanProvider(row interface{ Scan(...any) error }) (*Provider, error) {
	var p Provider
	var hasKey, enabled int
	var headers string
	var created, updated int64
	if err := row.Scan(&p.ID, &p.Name, &p.Kind, &p.BaseURL, &hasKey, &headers, &enabled, &created, &updated); err != nil {
		return nil, err
	}
	p.HasKey, p.Enabled = hasKey != 0, enabled != 0
	p.CreatedAt, p.UpdatedAt = time.UnixMilli(created), time.UnixMilli(updated)
	json.Unmarshal([]byte(headers), &p.HeaderNames)
	if p.HeaderNames == nil {
		p.HeaderNames = []string{}
	}
	p.Models = []*Model{}
	return &p, nil
}

const modelCols = `provider_id, model_id, name, context_window, max_tokens, reasoning, images, input_price, output_price, enabled`

func (c *Catalog) scanModel(row interface{ Scan(...any) error }) (*Model, error) {
	var m Model
	var reasoning, images, enabled int
	var in, out sql.NullFloat64
	if err := row.Scan(&m.Provider, &m.ModelID, &m.Name, &m.ContextWindow, &m.MaxTokens, &reasoning, &images, &in, &out, &enabled); err != nil {
		return nil, err
	}
	m.ID = m.Provider + "/" + m.ModelID
	m.Reasoning, m.Images, m.Enabled = reasoning != 0, images != 0, enabled != 0
	if in.Valid {
		m.InputPrice = &in.Float64
	}
	if out.Valid {
		m.OutputPrice = &out.Float64
	}
	return &m, nil
}

// Providers lists every provider with its models.
func (c *Catalog) Providers(ctx context.Context) ([]*Provider, error) {
	rows, err := c.db.QueryContext(ctx, `SELECT `+providerCols+` FROM providers ORDER BY name COLLATE NOCASE, id`)
	if err != nil {
		return nil, err
	}
	var list []*Provider
	byID := map[string]*Provider{}
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, p)
		byID[p.ID] = p
	}
	rows.Close()
	mrows, err := c.db.QueryContext(ctx, `SELECT `+modelCols+` FROM models ORDER BY name COLLATE NOCASE, model_id`)
	if err != nil {
		return nil, err
	}
	defer mrows.Close()
	for mrows.Next() {
		m, err := c.scanModel(mrows)
		if err != nil {
			return nil, err
		}
		if p := byID[m.Provider]; p != nil {
			p.Models = append(p.Models, m)
		}
	}
	if list == nil {
		list = []*Provider{}
	}
	return list, mrows.Err()
}

// WithUsage fills in each model's UsedBy (for the UI).
func (c *Catalog) WithUsage(list []*Provider) []*Provider {
	for _, p := range list {
		for _, m := range p.Models {
			m.UsedBy = len(c.UsedBy(m.ID))
		}
	}
	return list
}

// Provider returns one provider with its models.
func (c *Catalog) Provider(ctx context.Context, id string) (*Provider, error) {
	list, err := c.Providers(ctx)
	if err != nil {
		return nil, err
	}
	for _, p := range list {
		if p.ID == id {
			return p, nil
		}
	}
	return nil, ErrNotFound
}

// Model returns one model (its provider may be off).
func (c *Catalog) Model(ctx context.Context, id string) (*Model, error) {
	provider, modelID, ok := SplitModelID(id)
	if !ok {
		return nil, ErrNotFound
	}
	m, err := c.scanModel(c.db.QueryRowContext(ctx, `SELECT `+modelCols+` FROM models WHERE provider_id = ? AND model_id = ?`, provider, modelID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return m, err
}

// Choice is a model as the agent catalog offers it.
type Choice struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Provider     string `json:"provider"`
	ProviderName string `json:"providerName"`
	// Reasoning: the model can think (a conversation may choose its thinking level).
	Reasoning bool `json:"reasoning"`
}

// Choices lists the models agents may be given: every enabled model of every enabled provider, then the demo model.
func (c *Catalog) Choices(ctx context.Context) ([]Choice, error) {
	list, err := c.Providers(ctx)
	if err != nil {
		return nil, err
	}
	var out []Choice
	for _, p := range list {
		if !p.Enabled {
			continue
		}
		for _, m := range p.Models {
			if m.Enabled {
				out = append(out, Choice{ID: m.ID, Name: m.Name, Provider: p.ID, ProviderName: p.Name, Reasoning: m.Reasoning})
			}
		}
	}
	out = append(out, Choice{ID: DemoModelID, Name: DemoModelName, Provider: "demo", ProviderName: "Demo"})
	return out, nil
}

// Available reports whether agents may use a model now (it exists and it and its provider are on).
func (c *Catalog) Available(ctx context.Context, id string) bool {
	if id == DemoModelID {
		return true
	}
	choices, err := c.Choices(ctx)
	if err != nil {
		return false
	}
	for _, ch := range choices {
		if ch.ID == id {
			return true
		}
	}
	return false
}

// ModelName is a model's name, or its ID when the catalog no longer has it.
func (c *Catalog) ModelName(ctx context.Context, id string) string {
	if id == DemoModelID {
		return DemoModelName
	}
	if m, err := c.Model(ctx, id); err == nil {
		return m.Name
	}
	return id
}

// DefaultModel is the model new agents get: the chosen one while available, else the first available, else demo.
func (c *Catalog) DefaultModel(ctx context.Context) string {
	var chosen string
	c.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = 'default_model'`).Scan(&chosen)
	if chosen != "" && c.Available(ctx, chosen) {
		return chosen
	}
	if choices, err := c.Choices(ctx); err == nil && len(choices) > 0 {
		return choices[0].ID
	}
	return DemoModelID
}

// SetDefaultModel chooses the model new agents get.
func (c *Catalog) SetDefaultModel(ctx context.Context, id string) error {
	if !c.Available(ctx, id) {
		return bad("invalid_model", "Choose one of the models offered.")
	}
	_, err := c.db.ExecContext(ctx, `INSERT INTO settings (key, value) VALUES ('default_model', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, id)
	return err
}

// --- changing providers ---------------------------------------------------------------------------------------

// ProviderInput is a provider to add or the changes to one.
type ProviderInput struct {
	ID      *string            `json:"id"`
	Name    *string            `json:"name"`
	Kind    *string            `json:"kind"`
	BaseURL *string            `json:"baseUrl"`
	APIKey  *string            `json:"apiKey"`
	Headers *map[string]string `json:"headers"`
	Enabled *bool              `json:"enabled"`
}

func checkName(name string, max int) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > max || strings.ContainsAny(name, "\r\n") {
		return "", bad("invalid_name", "A name of 1 to %d characters, on one line.", max)
	}
	return name, nil
}

// CreateProvider adds a provider; its key and headers go to the keychain.
func (c *Catalog) CreateProvider(ctx context.Context, in ProviderInput) (*Provider, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if in.Name == nil {
		return nil, bad("invalid_name", "Give the provider a name.")
	}
	name, err := checkName(*in.Name, 60)
	if err != nil {
		return nil, err
	}
	id := Slug(name)
	if in.ID != nil && *in.ID != "" {
		id = *in.ID
	}
	if !slugPattern.MatchString(id) || id == "demo" {
		return nil, bad("invalid_id", "An ID is 1 to 32 lowercase letters, digits or dashes (and not \"demo\").")
	}
	if in.Kind == nil {
		return nil, bad("invalid_kind", "Choose the provider's API.")
	}
	kind, ok := KindByID(*in.Kind)
	if !ok {
		return nil, bad("invalid_kind", "Unknown provider API %q.", *in.Kind)
	}
	base := ""
	if in.BaseURL != nil {
		base = *in.BaseURL
	}
	if strings.TrimSpace(base) == "" && kind.DefaultBaseURL != nil {
		base = *kind.DefaultBaseURL
	}
	if base, err = checkBaseURL(base); err != nil {
		return nil, err
	}
	headers := map[string]string{}
	if in.Headers != nil {
		headers = *in.Headers
	}
	if err := checkHeaders(headers); err != nil {
		return nil, err
	}
	var exists int
	c.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM providers WHERE id = ?`, id).Scan(&exists)
	if exists > 0 {
		return nil, &Error{Status: http.StatusConflict, Code: "id_taken", Message: fmt.Sprintf("There is already a provider %q.", id)}
	}
	key := ""
	if in.APIKey != nil {
		key = strings.TrimSpace(*in.APIKey)
	}
	if key != "" {
		if err := c.secrets.Set(keyName(id), key); err != nil {
			return nil, fmt.Errorf("storing the key in the keychain: %w", err)
		}
	}
	if err := c.storeHeaders(id, headers); err != nil {
		c.secrets.Delete(keyName(id))
		return nil, err
	}
	now := time.Now().UnixMilli()
	if _, err := c.db.ExecContext(ctx, `INSERT INTO providers (id, name, kind, base_url, has_key, header_names, enabled, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`, id, name, kind.ID, base, boolInt(key != ""), headerNamesJSON(headers), now, now); err != nil {
		c.secrets.Delete(keyName(id))
		c.secrets.Delete(headersName(id))
		return nil, err
	}
	return c.Provider(ctx, id)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func headerNamesJSON(h map[string]string) string {
	names := make([]string, 0, len(h))
	for k := range h {
		names = append(names, k)
	}
	sort.Strings(names)
	raw, _ := json.Marshal(names)
	return string(raw)
}

func (c *Catalog) storeHeaders(id string, h map[string]string) error {
	if len(h) == 0 {
		return c.secrets.Delete(headersName(id))
	}
	raw, _ := json.Marshal(h)
	if err := c.secrets.Set(headersName(id), string(raw)); err != nil {
		return fmt.Errorf("storing the headers in the keychain: %w", err)
	}
	return nil
}

// UpdateProvider changes a provider. A key of "" removes the stored key; headers replace all of them.
func (c *Catalog) UpdateProvider(ctx context.Context, id string, in ProviderInput) (*Provider, error) {
	c.mu.Lock()
	p, err := c.Provider(ctx, id)
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	if in.Name != nil {
		if p.Name, err = checkName(*in.Name, 60); err != nil {
			c.mu.Unlock()
			return nil, err
		}
	}
	if in.BaseURL != nil {
		if p.BaseURL, err = checkBaseURL(*in.BaseURL); err != nil {
			c.mu.Unlock()
			return nil, err
		}
	}
	if in.Kind != nil && *in.Kind != p.Kind {
		if _, ok := KindByID(*in.Kind); !ok {
			c.mu.Unlock()
			return nil, bad("invalid_kind", "Unknown provider API %q.", *in.Kind)
		}
		p.Kind = *in.Kind
	}
	if in.Headers != nil {
		if err := checkHeaders(*in.Headers); err != nil {
			c.mu.Unlock()
			return nil, err
		}
		if err := c.storeHeaders(id, *in.Headers); err != nil {
			c.mu.Unlock()
			return nil, err
		}
		names := headerNamesJSON(*in.Headers)
		json.Unmarshal([]byte(names), &p.HeaderNames)
	}
	if in.APIKey != nil {
		key := strings.TrimSpace(*in.APIKey)
		if key == "" {
			if err := c.secrets.Delete(keyName(id)); err != nil {
				c.mu.Unlock()
				return nil, err
			}
		} else if err := c.secrets.Set(keyName(id), key); err != nil {
			c.mu.Unlock()
			return nil, fmt.Errorf("storing the key in the keychain: %w", err)
		}
		p.HasKey = key != ""
	}
	if in.Enabled != nil {
		p.Enabled = *in.Enabled
	}
	raw, _ := json.Marshal(p.HeaderNames)
	_, err = c.db.ExecContext(ctx, `UPDATE providers SET name = ?, kind = ?, base_url = ?, has_key = ?, header_names = ?, enabled = ?, updated_at = ? WHERE id = ?`,
		p.Name, p.Kind, p.BaseURL, boolInt(p.HasKey), string(raw), boolInt(p.Enabled), time.Now().UnixMilli(), id)
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	c.OnChange(id)
	return c.Provider(ctx, id)
}

func inUse(agents []AgentRef, what string) error {
	return &Error{Status: http.StatusConflict, Code: "in_use",
		Message: fmt.Sprintf("%s is used by %d agent(s). Give them another model first.", what, len(agents)),
		Details: map[string]any{"agents": agents}}
}

// DeleteProvider removes a provider, its models and its keychain items. Refused while agents use one of its models.
func (c *Catalog) DeleteProvider(ctx context.Context, id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, err := c.Provider(ctx, id)
	if err != nil {
		return err
	}
	var users []AgentRef
	for _, m := range p.Models {
		users = append(users, c.UsedBy(m.ID)...)
	}
	if len(users) > 0 {
		return inUse(users, p.Name)
	}
	if _, err := c.db.ExecContext(ctx, `DELETE FROM providers WHERE id = ?`, id); err != nil {
		return err
	}
	c.secrets.Delete(keyName(id))
	c.secrets.Delete(headersName(id))
	return nil
}

// --- changing models ------------------------------------------------------------------------------------------

// ModelInput is a model to add or the changes to one. Prices may be set to null with a JSON null.
type ModelInput struct {
	Name          *string         `json:"name"`
	ContextWindow *int            `json:"contextWindow"`
	MaxTokens     *int            `json:"maxTokens"`
	Reasoning     *bool           `json:"reasoning"`
	Images        *bool           `json:"images"`
	InputPrice    json.RawMessage `json:"inputPrice"`
	OutputPrice   json.RawMessage `json:"outputPrice"`
	Enabled       *bool           `json:"enabled"`
}

var modelIDPattern = regexp.MustCompile(`^[^\s\x00-\x1f]{1,200}$`)

func price(raw json.RawMessage, current *float64) (*float64, error) {
	if len(raw) == 0 {
		return current, nil
	}
	if string(raw) == "null" {
		return nil, nil
	}
	var v float64
	if err := json.Unmarshal(raw, &v); err != nil || v < 0 || v > 10_000 {
		return nil, bad("invalid_price", "A price is a number of US dollars per million tokens, from 0 to 10,000.")
	}
	return &v, nil
}

// PutModel adds a model to a provider, or changes it.
func (c *Catalog) PutModel(ctx context.Context, providerID, modelID string, in ModelInput) (*Model, error) {
	c.mu.Lock()
	if _, err := c.Provider(ctx, providerID); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	if !modelIDPattern.MatchString(modelID) {
		c.mu.Unlock()
		return nil, bad("invalid_model_id", "A model ID is 1 to 200 characters without spaces.")
	}
	m, err := c.Model(ctx, providerID+"/"+modelID)
	isNew := errors.Is(err, ErrNotFound)
	if err != nil && !isNew {
		c.mu.Unlock()
		return nil, err
	}
	if isNew {
		m = &Model{Provider: providerID, ModelID: modelID, Name: modelID, ContextWindow: 128_000, MaxTokens: 16_000, Enabled: true}
	}
	if in.Name != nil {
		if m.Name, err = checkName(*in.Name, 100); err != nil {
			c.mu.Unlock()
			return nil, err
		}
	}
	if in.ContextWindow != nil {
		if *in.ContextWindow < 1024 || *in.ContextWindow > 10_000_000 {
			c.mu.Unlock()
			return nil, bad("invalid_context_window", "A context window is from 1,024 to 10,000,000 tokens.")
		}
		m.ContextWindow = *in.ContextWindow
	}
	if in.MaxTokens != nil {
		if *in.MaxTokens < 256 || *in.MaxTokens > 1_000_000 {
			c.mu.Unlock()
			return nil, bad("invalid_max_tokens", "Max output tokens are from 256 to 1,000,000.")
		}
		m.MaxTokens = *in.MaxTokens
	}
	if m.MaxTokens > m.ContextWindow {
		m.MaxTokens = m.ContextWindow
	}
	if in.Reasoning != nil {
		m.Reasoning = *in.Reasoning
	}
	if in.Images != nil {
		m.Images = *in.Images
	}
	if in.Enabled != nil {
		m.Enabled = *in.Enabled
	}
	if m.InputPrice, err = price(in.InputPrice, m.InputPrice); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	if m.OutputPrice, err = price(in.OutputPrice, m.OutputPrice); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	now := time.Now().UnixMilli()
	_, err = c.db.ExecContext(ctx, `INSERT INTO models (provider_id, model_id, name, context_window, max_tokens, reasoning, images, input_price, output_price, enabled, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (provider_id, model_id) DO UPDATE SET name = excluded.name, context_window = excluded.context_window, max_tokens = excluded.max_tokens,
			reasoning = excluded.reasoning, images = excluded.images, input_price = excluded.input_price, output_price = excluded.output_price,
			enabled = excluded.enabled, updated_at = excluded.updated_at`,
		providerID, modelID, m.Name, m.ContextWindow, m.MaxTokens, boolInt(m.Reasoning), boolInt(m.Images), m.InputPrice, m.OutputPrice, boolInt(m.Enabled), now, now)
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if !isNew {
		c.OnChange(providerID)
	}
	return c.Model(ctx, providerID+"/"+modelID)
}

// DeleteModel removes a model. Refused while agents use it.
func (c *Catalog) DeleteModel(ctx context.Context, providerID, modelID string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	m, err := c.Model(ctx, providerID+"/"+modelID)
	if err != nil {
		return err
	}
	if users := c.UsedBy(m.ID); len(users) > 0 {
		return inUse(users, m.Name)
	}
	_, err = c.db.ExecContext(ctx, `DELETE FROM models WHERE provider_id = ? AND model_id = ?`, providerID, modelID)
	return err
}

// --- reaching a model -----------------------------------------------------------------------------------------

func (c *Catalog) credentials(id string) (key string, headers map[string]string, err error) {
	key, err = c.secrets.Get(keyName(id))
	if errors.Is(err, secrets.ErrNotFound) {
		key, err = "", nil
	}
	if err != nil {
		return "", nil, fmt.Errorf("reading the key from the keychain: %w", err)
	}
	raw, err := c.secrets.Get(headersName(id))
	if errors.Is(err, secrets.ErrNotFound) {
		return key, nil, nil
	}
	if err != nil {
		return "", nil, fmt.Errorf("reading the headers from the keychain: %w", err)
	}
	json.Unmarshal([]byte(raw), &headers)
	return key, headers, nil
}

// UnavailableError is an agent's model it can't run on now; Message is for people.
type UnavailableError struct{ Message string }

func (e *UnavailableError) Error() string { return e.Message }

// RuntimeEnv is the runtime's MODEL_* variables for a model (docs/runtime-contract.md).
func (c *Catalog) RuntimeEnv(ctx context.Context, id string) (map[string]string, error) {
	if id == DemoModelID {
		return map[string]string{"MODEL_PROVIDER": "demo"}, nil
	}
	providerID, _, _ := SplitModelID(id)
	m, err := c.Model(ctx, id)
	if err != nil {
		return nil, &UnavailableError{Message: fmt.Sprintf("The model %s is no longer available. Choose another in the agent's settings.", id)}
	}
	p, err := c.Provider(ctx, providerID)
	if err != nil {
		return nil, &UnavailableError{Message: fmt.Sprintf("The provider of %s was removed. Choose another model in the agent's settings.", m.Name)}
	}
	if !p.Enabled || !m.Enabled {
		return nil, &UnavailableError{Message: fmt.Sprintf("%s is turned off (Settings → Models). Turn it on or choose another model.", m.Name)}
	}
	kind, ok := KindByID(p.Kind)
	if !ok {
		return nil, &UnavailableError{Message: fmt.Sprintf("%s uses an unknown API.", p.Name)}
	}
	key, headers, err := c.credentials(p.ID)
	if err != nil {
		return nil, err
	}
	if key == "" {
		// Keyless local servers (Ollama, LM Studio) ignore it; the runtime needs one to send.
		key = "no-key"
	}
	env := map[string]string{
		"MODEL_PROVIDER":       "catalog",
		"MODEL_API":            kind.API,
		"MODEL_BASE_URL":       p.BaseURL,
		"MODEL_API_KEY":        key,
		"MODEL_ID":             m.ModelID,
		"MODEL_NAME":           m.Name,
		"MODEL_PROVIDER_NAME":  p.Name,
		"MODEL_CONTEXT_WINDOW": fmt.Sprint(m.ContextWindow),
		"MODEL_MAX_TOKENS":     fmt.Sprint(m.MaxTokens),
		"MODEL_REASONING":      fmt.Sprint(m.Reasoning),
		"MODEL_IMAGES":         fmt.Sprint(m.Images),
	}
	if len(headers) > 0 {
		raw, _ := json.Marshal(headers)
		env["MODEL_HEADERS"] = string(raw)
	}
	return env, nil
}
