// pi-local-sandbox is an unwired, fail-closed offline Linux helper. Build with
// CGO_ENABLED=0. No application providers, credentials, or native UI are linked.
package main

import (
	"encoding/json"
	"errors"
	"os"

	"github.com/ncecere/pi-local/internal/linuxsandbox"
)

func main() {
	if err := linuxsandbox.Main(os.Args[1:], os.Environ()); err != nil {
		var typed *linuxsandbox.Error
		if !errors.As(err, &typed) {
			typed = &linuxsandbox.Error{Code: "setup_failed", Message: "confinement setup failed; no fallback"}
		}
		// Never print policy, argv, environment, or underlying errors bearing secrets.
		_ = json.NewEncoder(os.Stderr).Encode(typed)
		os.Exit(125)
	}
}
