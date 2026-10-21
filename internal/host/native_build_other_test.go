//go:build !darwin || server || mcp

package host

import "testing"

func TestNonNativeBuildCannotClaimHumanCapability(t *testing.T) {
	policy := DesktopHumanConfirmationPolicy("")
	if nativeConfirmationBuild || policy.TrustedHumanConfirmations || policy.Reason == "" {
		t.Fatalf("unsupported OS or SDK server/mcp build claimed native trust: %+v", policy)
	}
}
