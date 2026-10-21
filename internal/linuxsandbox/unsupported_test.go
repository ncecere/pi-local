//go:build !linux || !amd64

package linuxsandbox

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUnsupportedNeverExecutes(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "must-not-exist")
	err := Main([]string{"run", "--policy", policyJSON(fixturePolicy()), "--", "/bin/sh", "-c", "touch " + marker}, []string{"TOKEN=fixture-only"})
	errorCode(t, err, "platform_unsupported")
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("unsupported helper executed a target")
	}
	errorCode(t, Main([]string{"guard"}, nil), "platform_unsupported")
}
