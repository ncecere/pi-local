package mcp

import (
	"net/url"
	"runtime"
	"strings"
	"testing"
)

func TestConnectionPresets(t *testing.T) {
	seen := map[string]bool{}
	list := ConnectionPresets()
	if len(list) != 12 {
		t.Fatalf("presets: %d", len(list))
	}
	for _, p := range list {
		if seen[p.ID] || !slugPattern.MatchString(p.ID) {
			t.Fatalf("bad id: %s", p.ID)
		}
		seen[p.ID] = true
		if p.Name == "" || p.Icon == "" || p.Description == "" || len(p.Setup) == 0 {
			t.Fatalf("incomplete: %+v", p)
		}
		u, err := url.Parse(p.DocsURL)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			t.Fatalf("docs: %s", p.DocsURL)
		}
		if p.Transport == "http" {
			if _, err := checkURL(p.URL); err != nil || strings.Contains(p.URL, "/sse") {
				t.Fatalf("unsupported URL: %s", p.URL)
			}
		} else if p.Transport != "stdio" || p.Command == "" {
			t.Fatalf("transport: %+v", p)
		}
		if p.Automatic && p.Auth != "oauth" && p.Auth != "macos-permission" {
			t.Fatalf("unsupported automatic auth: %+v", p)
		}
		if p.ID == "github" || p.ID == "asana" || p.Group == "mail" {
			if !p.Advanced || p.Automatic {
				t.Fatalf("unsupported flow must be advanced: %+v", p)
			}
		}
		if strings.HasPrefix(p.ID, "apple_") && p.Automatic != (runtime.GOOS == "darwin") {
			t.Fatal("platform mismatch")
		}
	}
}

func TestConnectionStates(t *testing.T) {
	c := &Catalog{}
	p := ConnectionPresets()[0]
	s := &Server{Slug: "custom_notion", Transport: "http", URL: &p.URL, OAuth: true}
	if got := c.connection(p, nil); got.State != "not_connected" || got.UsedBy == nil {
		t.Fatalf("empty: %+v", got)
	}
	s.Enabled = true
	if got := c.connection(p, []*Server{s}); got.State != "needs_sign_in" {
		t.Fatalf("sign-in: %+v", got)
	}
	message := "needs_sign_in: sign in"
	s.LastError = &message
	if got := c.connection(p, []*Server{s}); got.State != "needs_sign_in" {
		t.Fatal(got.State)
	}
	message = "Network unavailable"
	if got := c.connection(p, []*Server{s}); got.State != "error" || got.Problem != message {
		t.Fatal(got)
	}
	s.SignedIn = true
	message = "needs_sign_in: the stored token expired"
	if got := c.connection(p, []*Server{s}); got.State != "needs_sign_in" {
		t.Fatal("stored but rejected tokens still need sign-in")
	}
	s.LastError = nil
	if got := c.connection(p, []*Server{s}); got.State != "error" {
		t.Fatal("untested must not claim success")
	}
	now := int64(1)
	s.TestedAt = &now
	if got := c.connection(p, []*Server{s}); got.State != "connected" || got.Server.Slug != "custom_notion" {
		t.Fatal(got)
	}
	s.Enabled = false
	if got := c.connection(p, []*Server{s}); got.State != "error" {
		t.Fatal("disabled")
	}
	s.URL = new(string)
	if got := c.connection(p, []*Server{s}); got.State != "not_connected" {
		t.Fatal("slug alone must not adopt a custom server")
	}
}
