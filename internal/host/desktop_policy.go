package host

import "runtime"

// DesktopHumanConfirmationPolicy selects policy for the current default Wails
// entrypoint, without initializing Wails or inspecting requests. Build identity
// must deny SDK server/mcp modes before selecting embedded-native compatibility.
// A dev-server override always denies, including in builds that ignore the URL.
// This assumes no custom Options.Transport: adding one must explicitly deny this
// selection until its isolation is independently verified. This is not request
// authorization, native attestation, or proof of a physical human gesture.
func DesktopHumanConfirmationPolicy(devServerURL string) HumanPolicy {
	transport := Unknown
	if nativeConfirmationBuild {
		transport = EmbeddedNative
	}
	if devServerURL != "" {
		transport = DevHTTP
	}
	return HumanConfirmationPolicy(runtime.GOOS, transport)
}
