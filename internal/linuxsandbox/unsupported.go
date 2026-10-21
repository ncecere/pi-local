//go:build !linux || !amd64

package linuxsandbox

func launch(Policy, []string, []string) error {
	return fail("platform_unsupported", "helper requires Linux amd64; no target was executed")
}
func guard([]string) error {
	return fail("platform_unsupported", "helper guard requires Linux amd64; no target was executed")
}
