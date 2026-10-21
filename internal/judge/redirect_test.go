package judge

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/ncecere/pi-local/internal/secrets"
)

type redirectTransport func(*http.Request) (*http.Response, error)

func (f redirectTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestJudgmentRedirectsStayAtTheOriginalOrigin(t *testing.T) {
	for _, tc := range []struct {
		name, from, to string
		allowed        bool
	}{
		{"same origin path", "https://judge.example/v1/models", "https://judge.example/models", true},
		{"explicit default port", "https://judge.example/v1/models", "https://judge.example:443/models", true},
		{"host case", "https://JUDGE.example/v1/models", "https://judge.example/models", true},
		{"different port", "http://127.0.0.1:1234/v1/models", "http://127.0.0.1:4321/models", false},
		{"subdomain", "https://judge.example/v1/models", "https://other.judge.example/models", false},
		{"other host", "https://judge.example/v1/models", "https://other.example/models", false},
		{"TLS downgrade", "https://judge.example/v1/models", "http://judge.example/models", false},
		{"URL credentials", "https://judge.example/v1/models", "https://user:password@judge.example/models", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := New(nil, secrets.NewMemory())
			var seen []*http.Request
			s.client.Transport = redirectTransport(func(r *http.Request) (*http.Response, error) {
				seen = append(seen, r)
				header, status := http.Header{}, http.StatusOK
				if len(seen) == 1 {
					header.Set("Location", tc.to)
					status = http.StatusTemporaryRedirect
				}
				return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader("{}")), Request: r}, nil
			})
			req, err := http.NewRequest(http.MethodPost, tc.from, strings.NewReader(`{"state":"private text"}`))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer dummy-fixture-key")
			resp, err := s.client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if !tc.allowed {
				if len(seen) != 1 || resp.StatusCode != http.StatusTemporaryRedirect {
					t.Fatalf("request escaped original origin: requests=%d status=%d", len(seen), resp.StatusCode)
				}
			} else {
				if len(seen) != 2 || resp.StatusCode != http.StatusOK {
					t.Fatal("same-origin redirect was refused")
				}
				// Go may strip the header when the host's letter case changes; our policy must not weaken that.
				if tc.name != "host case" && seen[1].Header.Get("Authorization") != "Bearer dummy-fixture-key" {
					t.Fatal("same-origin redirect failed to retain its credential")
				}
			}
		})
	}
}

func TestJudgmentRedirectLimit(t *testing.T) {
	u, _ := url.Parse("https://judge.example/models")
	req := &http.Request{URL: u}
	via := make([]*http.Request, 10)
	for i := range via {
		via[i] = req
	}
	if err := sameOriginRedirect(req, via); err == nil {
		t.Fatal("redirect limit was removed")
	}
}
