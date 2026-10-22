package host

import "testing"

func TestDesktopPolicyDevServerAlwaysDenied(t *testing.T) {
	for _, url := range []string{"http://localhost:5173", "wails://localhost", " ", "invalid"} {
		policy := DesktopHumanConfirmationPolicy(url)
		if policy.TrustedHumanConfirmations || policy.Reason == "" {
			t.Fatalf("dev override %q: %+v", url, policy)
		}
	}
}
