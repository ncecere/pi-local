package host

import (
	"net/http/httptest"
	"testing"
)

func TestHumanPolicyOSAndTransportMatrix(t *testing.T) {
	for _, platform := range []string{"darwin", "linux", "windows", "freebsd", "", "Darwin"} {
		for _, transport := range []Transport{EmbeddedNative, Headless, DevHTTP, Unknown, "", "invalid"} {
			policy := HumanConfirmationPolicy(platform, transport)
			want := platform == "darwin" && transport == EmbeddedNative
			if policy.TrustedHumanConfirmations != want || policy.Reason == "" {
				t.Errorf("%q %q: %+v, want trusted=%v", platform, transport, policy, want)
			}
		}
	}
}

func TestRequestHeadersCannotGrantHostTrust(t *testing.T) {
	// Synthetic requests only: no listeners or Wails/app initialization. Policy
	// has deliberately no request/header argument. Headers cannot choose transport.
	for _, platform := range []string{"darwin", "linux", "windows"} {
		for _, transport := range []Transport{Headless, DevHTTP, Unknown} {
			before := HumanConfirmationPolicy(platform, transport)
			for _, origin := range []string{"http://wails.localhost", "wails://wails.localhost", "http://localhost:5190", "https://hostile.example"} {
				r := httptest.NewRequest("POST", "http://localhost/api/approvals/decision", nil)
				r.Host = "wails.localhost"
				r.Header.Set("Origin", origin)
				r.Header.Set("Host", "localhost")
				r.Header.Set("X-Wails-Window-Id", "main")
				r.Header.Set("X-Wails-Window-Name", "main")
				r.Header.Set("X-Trusted-Human-Confirmations", "true")
				r.Header.Set("X-Transport", string(EmbeddedNative))
				if after := HumanConfirmationPolicy(platform, transport); after != before || after.TrustedHumanConfirmations {
					t.Fatalf("request headers changed policy: %+v", after)
				}
			}
		}
	}
}
