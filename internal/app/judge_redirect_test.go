package app

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestFastJudgmentsRefuseCrossOriginRedirects(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	var escaped atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		escaped.Add(1)
		w.Write([]byte(`{"models":[{"name":"unexpected"}]}`))
	}))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	h.mustDo("PUT", "/api/settings/judgments", map[string]any{"url": source.URL, "apiKey": "dummy-fixture-key"}, 200)
	// Both saved-key model discovery and judgment requests must refuse the redirect. Same hostname, different port.
	h.mustDo("GET", "/api/settings/judgments/models", nil, 502)
	h.mustDo("POST", "/api/settings/judgments/models", map[string]string{"url": source.URL}, 502)
	h.mustDo("POST", "/api/settings/judgments/test", nil, 502)
	if escaped.Load() != 0 {
		t.Fatal("a request reached the other origin")
	}
}
