//go:build darwin && !server && !mcp

package host

import "testing"

func TestDefaultDarwinBuildRetainsCompatibility(t *testing.T) {
	if !nativeConfirmationBuild || !DesktopHumanConfirmationPolicy("").TrustedHumanConfirmations {
		t.Fatal("default Darwin build must retain legacy native compatibility")
	}
}
