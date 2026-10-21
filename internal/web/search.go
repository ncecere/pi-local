// Package web gives agents the web: a search through the service the person chose (Brave, Tavily, SerpApi or a
// SearXNG of their own) and a fetch that returns a page as readable Markdown. Both run in the app, which keeps the
// search key out of the agents and can refuse addresses on this computer or its network at connect time.
package web

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ncecere/pi-local/internal/secrets"
)

// Provider is a search service people can choose.
type Provider struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	NeedsKey  bool   `json:"needsKey"`
	NeedsURL  bool   `json:"needsUrl"`
	SignupURL string `json:"signupUrl"`
	Note      string `json:"note"`
	// base is the service's own endpoint (a URL in settings replaces it: SearXNG, or a test server).
	base string
}

// Providers are the search services, Brave first (the default).
var Providers = []Provider{
	{ID: "brave", Name: "Brave Search", NeedsKey: true, SignupURL: "https://brave.com/search/api/", Note: "An API key from the Brave Search API (it has a free plan).", base: "https://api.search.brave.com/res/v1/web/search"},
	{ID: "tavily", Name: "Tavily", NeedsKey: true, SignupURL: "https://app.tavily.com", Note: "An API key from Tavily, a search API made for agents.", base: "https://api.tavily.com/search"},
	{ID: "serpapi", Name: "SerpApi", NeedsKey: true, SignupURL: "https://serpapi.com/manage-api-key", Note: "An API key from SerpApi (Google results).", base: "https://serpapi.com/search.json"},
	{ID: "searxng", Name: "SearXNG", NeedsURL: true, SignupURL: "https://docs.searxng.org", Note: "Your own SearXNG: its URL, with the JSON format turned on (search.formats: json).", base: ""},
}

func providerByID(id string) (Provider, bool) {
	for _, p := range Providers {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

// Result is one search hit.
type Result struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
	Age     string `json:"age,omitempty"`
}

// Settings is the chosen search service, as the UI sees it (the key never leaves the keychain).
type Settings struct {
	Provider  string     `json:"provider"` // "" means none
	URL       string     `json:"url"`
	HasKey    bool       `json:"hasKey"`
	Providers []Provider `json:"providers"`
}

// Error is a failure for people.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func bad(code, format string, args ...any) error {
	return &Error{Status: http.StatusBadRequest, Code: code, Message: fmt.Sprintf(format, args...)}
}

func failed(format string, args ...any) error {
	return &Error{Status: http.StatusBadGateway, Code: "search_failed", Message: fmt.Sprintf(format, args...)}
}

// ErrNotSetUp: no search service chosen yet.
var ErrNotSetUp = &Error{Status: http.StatusConflict, Code: "not_set_up", Message: "Web search isn't set up yet: choose a search service in Settings → Models → Web search."}

const keyName = "web:search:key"

// Service is the app's web access.
type Service struct {
	db      *sql.DB
	secrets secrets.Store
	client  *http.Client
	fetcher *Fetcher
	mu      sync.Mutex
}

// New makes the service.
func New(db *sql.DB, store secrets.Store) *Service {
	return &Service{db: db, secrets: store, client: &http.Client{Timeout: 20 * time.Second}, fetcher: NewFetcher(false)}
}

// AllowPrivate lets fetches reach this computer and its network (tests; never in the app).
func (s *Service) AllowPrivate() { s.fetcher = NewFetcher(true) }

func (s *Service) setting(key string) string {
	var v string
	s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	return v
}

func (s *Service) put(key, value string) error {
	if value == "" {
		_, err := s.db.Exec(`DELETE FROM settings WHERE key = ?`, key)
		return err
	}
	_, err := s.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// Settings reads the chosen service.
func (s *Service) Settings() Settings {
	key, _ := s.secrets.Get(keyName)
	return Settings{Provider: s.setting("web_search_provider"), URL: s.setting("web_search_url"), HasKey: key != "", Providers: Providers}
}

// SettingsInput changes the search service; a nil key keeps the stored one, "" removes it.
type SettingsInput struct {
	Provider string  `json:"provider"`
	URL      *string `json:"url"`
	APIKey   *string `json:"apiKey"`
}

// Save chooses the search service.
func (s *Service) Save(in SettingsInput) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if in.Provider == "" {
		s.put("web_search_provider", "")
		s.put("web_search_url", "")
		s.secrets.Delete(keyName)
		return s.Settings(), nil
	}
	p, ok := providerByID(in.Provider)
	if !ok {
		return Settings{}, bad("invalid_provider", "Choose one of the search services offered.")
	}
	url := s.setting("web_search_url")
	if in.URL != nil {
		url = strings.TrimRight(strings.TrimSpace(*in.URL), "/")
	}
	if url != "" {
		if err := checkServiceURL(url); err != nil {
			return Settings{}, err
		}
	}
	if p.NeedsURL && url == "" {
		return Settings{}, bad("invalid_url", "Give your %s's address, like https://search.example.com.", p.Name)
	}
	if in.APIKey != nil {
		if k := strings.TrimSpace(*in.APIKey); k != "" {
			if err := s.secrets.Set(keyName, k); err != nil {
				return Settings{}, err
			}
		} else {
			s.secrets.Delete(keyName)
		}
	}
	if p.NeedsKey {
		if k, _ := s.secrets.Get(keyName); k == "" {
			return Settings{}, bad("invalid_key", "Paste the API key from %s.", p.Name)
		}
	}
	if err := s.put("web_search_provider", p.ID); err != nil {
		return Settings{}, err
	}
	if err := s.put("web_search_url", url); err != nil {
		return Settings{}, err
	}
	return s.Settings(), nil
}

func checkServiceURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return bad("invalid_url", "The address must start with https:// (or http:// for a server on this computer or network).")
	}
	return nil
}

// Search asks the chosen service. count is clamped to 1..20.
func (s *Service) Search(ctx context.Context, query string, count int) ([]Result, error) {
	query = strings.TrimSpace(query)
	if query == "" || len(query) > 400 {
		return nil, bad("invalid_query", "A search is 1 to 400 characters.")
	}
	count = min(max(count, 1), 20)
	st := s.Settings()
	p, ok := providerByID(st.Provider)
	if !ok {
		return nil, ErrNotSetUp
	}
	key, _ := s.secrets.Get(keyName)
	base := p.base
	if st.URL != "" {
		base = st.URL
		if p.ID == "searxng" {
			base += "/search"
		}
	}
	var req *http.Request
	var err error
	switch p.ID {
	case "brave":
		q := url.Values{"q": {query}, "count": {fmt.Sprint(count)}}
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, base+"?"+q.Encode(), nil)
		if err == nil {
			req.Header.Set("X-Subscription-Token", key)
		}
	case "tavily":
		body, _ := json.Marshal(map[string]any{"query": query, "max_results": count})
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, base, strings.NewReader(string(body)))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+key)
		}
	case "serpapi":
		q := url.Values{"engine": {"google"}, "q": {query}, "num": {fmt.Sprint(count)}, "api_key": {key}}
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, base+"?"+q.Encode(), nil)
	case "searxng":
		q := url.Values{"q": {query}, "format": {"json"}}
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, base+"?"+q.Encode(), nil)
		if err == nil && key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
	}
	if err != nil {
		return nil, failed("The search address can't be used.")
	}
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, failed("%s took too long to answer.", p.Name)
		}
		return nil, failed("Could not reach %s.", p.Name)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return nil, failed("%s refused the key (status %d). Check it in Settings → Models → Web search.", p.Name, resp.StatusCode)
	case resp.StatusCode == http.StatusTooManyRequests:
		return nil, failed("%s says too many searches for now (your plan's limit). Try again later.", p.Name)
	case resp.StatusCode != http.StatusOK:
		if p.ID == "searxng" && resp.StatusCode == http.StatusForbidden {
			return nil, failed("SearXNG refused the JSON format: turn it on in its settings (search.formats: json).")
		}
		return nil, failed("%s answered status %d.", p.Name, resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, failed("%s's answer could not be read.", p.Name)
	}
	results, err := parse(p.ID, raw)
	if err != nil {
		return nil, failed("%s's answer could not be read.", p.Name)
	}
	if len(results) > count {
		results = results[:count]
	}
	return results, nil
}

func parse(provider string, raw []byte) ([]Result, error) {
	var out []Result
	add := func(title, link, snippet, age string) {
		if link == "" {
			return
		}
		out = append(out, Result{Title: clip(plain(title), 300), URL: link, Snippet: clip(plain(snippet), 600), Age: age})
	}
	switch provider {
	case "brave":
		var b struct {
			Web struct {
				Results []struct{ Title, URL, Description, Age string }
			}
		}
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		for _, r := range b.Web.Results {
			add(r.Title, r.URL, r.Description, r.Age)
		}
	case "tavily":
		var b struct {
			Results []struct{ Title, URL, Content string }
		}
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		for _, r := range b.Results {
			add(r.Title, r.URL, r.Content, "")
		}
	case "serpapi":
		var b struct {
			OrganicResults []struct{ Title, Link, Snippet, Date string } `json:"organic_results"`
		}
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		for _, r := range b.OrganicResults {
			add(r.Title, r.Link, r.Snippet, r.Date)
		}
	case "searxng":
		var b struct {
			Results []struct {
				Title, URL, Content string
				PublishedDate       string `json:"publishedDate"`
			}
		}
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		for _, r := range b.Results {
			add(r.Title, r.URL, r.Content, r.PublishedDate)
		}
	}
	return out, nil
}

// plain drops markup a search API leaves in titles and snippets (Brave's <strong>).
func plain(s string) string {
	var b strings.Builder
	in := false
	for _, r := range s {
		switch {
		case r == '<':
			in = true
		case r == '>' && in:
			in = false
		case !in:
			b.WriteRune(r)
		}
	}
	return strings.Join(strings.Fields(htmlUnescape(b.String())), " ")
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// Fetch reads a page for an agent.
func (s *Service) Fetch(ctx context.Context, raw string, offset, maxChars int) (*Page, error) {
	return s.fetcher.Fetch(ctx, raw, offset, maxChars)
}
