package models

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// Discovered is a model a provider lists.
type Discovered struct {
	ModelID       string `json:"modelId"`
	Name          string `json:"name"`
	ContextWindow *int   `json:"contextWindow"`
	Added         bool   `json:"added"`
}

func authenticate(req *http.Request, kind Kind, key string, headers map[string]string) {
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if key == "" {
		return
	}
	if kind.authHeader == "x-api-key" {
		req.Header.Set("x-api-key", key)
		return
	}
	req.Header.Set("Authorization", "Bearer "+key)
}

func discoveryFailed(format string, args ...any) error {
	return &Error{Status: http.StatusBadGateway, Code: "discovery_failed", Message: fmt.Sprintf(format, args...)}
}

// Discover lists a provider's models from its own API (OpenAI-style `GET /models`, Anthropic's `GET /v1/models`).
// Errors are for people and never echo what the provider answered.
func (c *Catalog) Discover(ctx context.Context, providerID string) ([]Discovered, error) {
	p, err := c.Provider(ctx, providerID)
	if err != nil {
		return nil, err
	}
	kind, ok := KindByID(p.Kind)
	if !ok {
		return nil, discoveryFailed("%s uses an unknown API.", p.Name)
	}
	key, headers, err := c.credentials(p.ID)
	if err != nil {
		return nil, err
	}
	target := p.BaseURL + kind.modelsPath
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, discoveryFailed("The base URL can't be used: %s", p.BaseURL)
	}
	req.Header.Set("Accept", "application/json")
	if kind.authHeader == "x-api-key" {
		req.Header.Set("anthropic-version", "2023-06-01")
	}
	authenticate(req, kind, key, headers)
	resp, err := c.client.Do(req)
	if err != nil {
		var urlErr *url.Error
		var opErr *net.OpError
		switch {
		case errors.As(err, &opErr) && opErr.Op == "dial":
			return nil, discoveryFailed("Nothing is answering at %s. Is the server running?", hostOf(p.BaseURL))
		case errors.As(err, &urlErr) && urlErr.Timeout():
			return nil, discoveryFailed("%s took too long to answer.", hostOf(p.BaseURL))
		default:
			return nil, discoveryFailed("Could not reach %s (connection or TLS failed).", hostOf(p.BaseURL))
		}
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return nil, discoveryFailed("%s refused the key (status %d). Check the API key.", p.Name, resp.StatusCode)
	case resp.StatusCode == http.StatusNotFound:
		return nil, discoveryFailed("%s has no model list at %s. Check the base URL (it often ends in /v1).", p.Name, strings.SplitN(kind.modelsPath, "?", 2)[0])
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		return nil, discoveryFailed("%s redirected the request; use the URL it redirects to.", p.Name)
	case resp.StatusCode != http.StatusOK:
		return nil, discoveryFailed("%s answered status %d.", p.Name, resp.StatusCode)
	}
	var body struct {
		Data []struct {
			ID               string `json:"id"`
			Name             string `json:"name"`
			DisplayName      string `json:"display_name"`
			ContextLength    int    `json:"context_length"`
			ContextWindow    int    `json:"context_window"`
			MaxContextLength int    `json:"max_context_length"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&body); err != nil {
		return nil, discoveryFailed("%s's model list could not be read.", p.Name)
	}
	added := map[string]bool{}
	for _, m := range p.Models {
		added[m.ModelID] = true
	}
	out := []Discovered{}
	seen := map[string]bool{}
	for _, d := range body.Data {
		if d.ID == "" || !modelIDPattern.MatchString(d.ID) || seen[d.ID] {
			continue
		}
		seen[d.ID] = true
		name := d.DisplayName
		if name == "" {
			name = d.Name
		}
		if name == "" || len([]rune(name)) > 100 {
			name = d.ID
		}
		item := Discovered{ModelID: d.ID, Name: name, Added: added[d.ID]}
		for _, n := range []int{d.ContextWindow, d.ContextLength, d.MaxContextLength} {
			if n >= 1024 && n <= 10_000_000 {
				v := n
				item.ContextWindow = &v
				break
			}
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

func hostOf(base string) string {
	if u, err := url.Parse(base); err == nil && u.Host != "" {
		return u.Host
	}
	return base
}
