package update

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.2.0", "0.1.0", true},
		{"0.1.0", "0.1.0", false},
		{"0.1.10", "0.1.9", true},
		{"1.0.0", "1.0.0-rc.1", true},
		{"1.0.0-rc.2", "1.0.0-rc.1", true},
		{"0.1.0", "0.1.0-dev", true},
		{"0.1.0", "6dc49f2-dirty", true}, // a development build is older than any release
		{"junk", "0.1.0", false},
		{"v0.3.0", "0.2.9", true},
	}
	for _, c := range cases {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

func TestSignatures(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	path := filepath.Join(dir, "Pi-Local-0.2.0-macos-arm64.zip")
	os.WriteFile(path, []byte("archive bytes"), 0o600)
	sig, err := Sign(priv, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(pub, path, sig); err != nil {
		t.Fatalf("a good signature: %v", err)
	}
	// Changed bytes, another name, another key, garbage: all refused.
	os.WriteFile(path, []byte("archive bytes!"), 0o600)
	if err := Verify(pub, path, sig); err == nil {
		t.Fatal("a changed archive passed")
	}
	os.WriteFile(path, []byte("archive bytes"), 0o600)
	if err := VerifyNamed(pub, path, "Pi-Local-0.3.0-macos-arm64.zip", sig); err == nil {
		t.Fatal("a signature moved to another name passed")
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	if err := Verify(other, path, sig); err == nil {
		t.Fatal("another key passed")
	}
	if err := Verify(pub, path, "not base64!"); err == nil {
		t.Fatal("garbage passed")
	}
	// The key built into the app is a real key.
	if len(PublicKey) != ed25519.PublicKeySize {
		t.Fatal("the release public key")
	}
}

// fakeGitHub serves a latest release with an archive and its signature.
func fakeGitHub(t *testing.T, version string, files map[string]string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/ncecere/pi-local/releases/latest" {
			var assets []map[string]any
			for name := range files {
				assets = append(assets, map[string]any{"name": name, "browser_download_url": srv.URL + "/dl/" + name, "size": 1})
			}
			json.NewEncoder(w).Encode(map[string]any{"tag_name": "v" + version, "body": "Notes for " + version, "html_url": "https://example.com/r", "published_at": time.Now(), "assets": assets})
			return
		}
		if name, found := strings.CutPrefix(r.URL.Path, "/dl/"); found {
			if path, ok := files[name]; ok {
				http.ServeFile(w, r, path)
				return
			}
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchLatestSelectsMacArchiveAndSignature(t *testing.T) {
	const archive = "Pi-Local-0.2.0-macos-arm64.zip"
	gh := fakeGitHub(t, "0.2.0", map[string]string{
		archive: "not downloaded", archive + ".sig": "not downloaded",
		"Pi-Local-0.2.0-windows-amd64.zip":  "not downloaded",
		"Pi-Local-0.2.0-linux-amd64.tar.gz": "not downloaded",
	})
	u := New("0.1.0", "")
	u.APIBase = gh.URL
	rel, err := u.fetchLatest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rel.Version != "0.2.0" || rel.Notes != "Notes for 0.2.0" || rel.URL != "https://example.com/r" || rel.Published.IsZero() {
		t.Fatalf("release metadata: %+v", rel)
	}
	if rel.asset != (asset{archive, gh.URL + "/dl/" + archive, 1}) || rel.signature != (asset{archive + ".sig", gh.URL + "/dl/" + archive + ".sig", 1}) {
		t.Fatalf("existing macOS asset selection changed: %+v %+v", rel.asset, rel.signature)
	}
}

func TestNoReleasesYet(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	u := New("0.1.0", "")
	u.APIBase = srv.URL
	st := u.Check(context.Background())
	if st.Available || st.Error == nil || !strings.Contains(*st.Error, "no releases") || st.CanInstall {
		t.Fatalf("%+v", st)
	}
}
