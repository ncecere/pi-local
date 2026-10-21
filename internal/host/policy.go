package host

// Transport is supplied by a known host entrypoint, never inferred from Host,
// Origin, localhost, window headers, or other request-controlled information.
type Transport string

const (
	Unknown        Transport = "unknown"
	EmbeddedNative Transport = "embedded-native"
	Headless       Transport = "headless"
	DevHTTP        Transport = "dev-http"
)

type HumanPolicy struct {
	TrustedHumanConfirmations bool
	Reason                    string
}

// HumanConfirmationPolicy is pure and preserves only the legacy Darwin embedded
// native decision. This is compatibility policy, NOT proof of native isolation.
// Windows/Linux require private WebView transport verification before enabling
// trusted decisions. Notifications on those platforms must only open the UI
// until activation provenance is separately verified.
func HumanConfirmationPolicy(platform string, transport Transport) HumanPolicy {
	if transport != EmbeddedNative {
		return HumanPolicy{false, "trusted confirmation requires a known embedded native host, not HTTP or request headers"}
	}
	if platform != "darwin" {
		return HumanPolicy{false, "this platform's private native UI transport has not been verified"}
	}
	return HumanPolicy{true, "legacy Darwin embedded native compatibility; native isolation still requires runtime verification"}
}
