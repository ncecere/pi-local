package models

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// SetPresetURL points a preset at another base URL (for tests).
func (c *Catalog) SetPresetURL(preset, base string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.presetURLs == nil {
		c.presetURLs = map[string]string{}
	}
	c.presetURLs[preset] = base
}

func (c *Catalog) baseOf(p Preset) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if u, ok := c.presetURLs[p.ID]; ok {
		return u
	}
	return p.BaseURL
}

// Detected is a model server found running on this computer, for the first run.
type Detected struct {
	Preset  string       `json:"preset"`
	Name    string       `json:"name"`
	BaseURL string       `json:"baseUrl"`
	Models  []Discovered `json:"models"`
	// Provider is the configured provider already using this server, if any.
	Provider *string `json:"provider"`
}

// detectTimeout bounds each look: a local server answers at once or isn't there.
const detectTimeout = 800 * time.Millisecond

// Detect looks for the local presets' servers (Ollama, LM Studio) and lists their models. A server that isn't running
// is left out; nothing is configured.
func (c *Catalog) Detect(ctx context.Context) []Detected {
	providers, _ := c.Providers(ctx)
	type result struct {
		i int
		d *Detected
	}
	var locals []Preset
	for _, p := range Presets {
		if p.Local {
			locals = append(locals, p)
		}
	}
	results := make(chan result, len(locals))
	for i, p := range locals {
		go func() {
			results <- result{i, c.detectOne(ctx, p, providers)}
		}()
	}
	found := make([]*Detected, len(locals))
	for range locals {
		r := <-results
		found[r.i] = r.d
	}
	out := []Detected{}
	for _, d := range found {
		if d != nil {
			out = append(out, *d)
		}
	}
	return out
}

func (c *Catalog) detectOne(ctx context.Context, p Preset, providers []*Provider) *Detected {
	ctx, cancel := context.WithTimeout(ctx, detectTimeout)
	defer cancel()
	base := c.baseOf(p)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/models", nil)
	if err != nil {
		return nil
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&body) != nil {
		return nil
	}
	d := &Detected{Preset: p.ID, Name: p.Name, BaseURL: base, Models: []Discovered{}}
	for _, m := range body.Data {
		if m.ID != "" && modelIDPattern.MatchString(m.ID) && !embeddingModel(m.ID) {
			d.Models = append(d.Models, Discovered{ModelID: m.ID, Name: m.ID})
		}
	}
	sort.Slice(d.Models, func(i, j int) bool { return d.Models[i].ModelID < d.Models[j].ModelID })
	for _, existing := range providers {
		if sameServer(existing.BaseURL, base) {
			id := existing.ID
			d.Provider = &id
		}
	}
	return d
}

// embeddingModel: models that can't chat (Ollama and LM Studio list them with the rest).
func embeddingModel(id string) bool {
	id = strings.ToLower(id)
	return strings.Contains(id, "embed") || strings.Contains(id, "bge-") || strings.Contains(id, "rerank")
}

// sameServer compares base URLs, treating localhost and 127.0.0.1 alike.
func sameServer(a, b string) bool {
	norm := func(s string) string {
		u, err := url.Parse(strings.TrimRight(s, "/"))
		if err != nil {
			return s
		}
		host := u.Hostname()
		if host == "localhost" || host == "::1" {
			host = "127.0.0.1"
		}
		return u.Scheme + "://" + host + ":" + u.Port() + u.Path
	}
	return norm(a) == norm(b)
}

// SetupInput is a one-step provider setup from a preset (the first run, or "Add" on a detected server).
type SetupInput struct {
	Preset string  `json:"preset"`
	APIKey *string `json:"apiKey"`
	// Models to add; absent: every model of a local server (at most maxSetupModels), none of a remote one (the person
	// picks from the list returned).
	Models *[]string `json:"models"`
}

// SetupResult is the provider, what it offers, and the default model now.
type SetupResult struct {
	Provider     *Provider    `json:"provider"`
	Available    []Discovered `json:"available"`
	DefaultModel string       `json:"defaultModelId"`
}

const maxSetupModels = 20

// Setup adds a provider from a preset (or reuses the one already set up for it), lists its models, adds the chosen
// ones, and makes the first of them the default model when the default is still the demo.
func (c *Catalog) Setup(ctx context.Context, in SetupInput) (*SetupResult, error) {
	var preset *Preset
	for i := range Presets {
		if Presets[i].ID == in.Preset {
			preset = &Presets[i]
		}
	}
	if preset == nil || preset.BaseURL == "" {
		return nil, bad("invalid_preset", "Choose one of the providers offered.")
	}
	base := c.baseOf(*preset)
	var provider *Provider
	if list, err := c.Providers(ctx); err == nil {
		for _, p := range list {
			if p.ID == preset.ID || sameServer(p.BaseURL, base) {
				provider = p
			}
		}
	}
	noKey := in.APIKey == nil || strings.TrimSpace(*in.APIKey) == ""
	if preset.NeedsKey && noKey && (provider == nil || !provider.HasKey) {
		return nil, bad("invalid_key", "Paste the API key from %s.", preset.Name)
	}
	if provider == nil {
		id, name, kind := preset.ID, preset.Name, preset.Kind
		created, err := c.CreateProvider(ctx, ProviderInput{ID: &id, Name: &name, Kind: &kind, BaseURL: &base, APIKey: in.APIKey})
		if err != nil {
			return nil, err
		}
		provider = created
	} else if in.APIKey != nil && strings.TrimSpace(*in.APIKey) != "" {
		if _, err := c.UpdateProvider(ctx, provider.ID, ProviderInput{APIKey: in.APIKey}); err != nil {
			return nil, err
		}
	}
	available, err := c.Discover(ctx, provider.ID)
	if err != nil {
		return nil, err
	}
	var chosen []string
	switch {
	case in.Models != nil:
		chosen = *in.Models
	case preset.Local:
		for _, d := range available {
			if len(chosen) < maxSetupModels && !embeddingModel(d.ModelID) {
				chosen = append(chosen, d.ModelID)
			}
		}
	}
	names := map[string]Discovered{}
	for _, d := range available {
		names[d.ModelID] = d
	}
	for _, id := range chosen {
		d, ok := names[id]
		if !ok {
			return nil, bad("invalid_model", "%s doesn't offer %q.", provider.Name, id)
		}
		name := d.Name
		mi := ModelInput{Name: &name}
		if d.ContextWindow != nil {
			mi.ContextWindow = d.ContextWindow
		}
		if _, err := c.PutModel(ctx, provider.ID, id, mi); err != nil {
			return nil, err
		}
	}
	if len(chosen) > 0 && c.DefaultModel(ctx) == DemoModelID {
		c.SetDefaultModel(ctx, provider.ID+"/"+chosen[0])
	}
	provider, err = c.Provider(ctx, provider.ID)
	if err != nil {
		return nil, err
	}
	available, _ = c.Discover(ctx, provider.ID) // with "added" marked
	return &SetupResult{Provider: provider, Available: available, DefaultModel: c.DefaultModel(ctx)}, nil
}
