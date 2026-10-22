package main

import "github.com/ncecere/pi-local/internal/api"

// desktop is the desktop app's own settings, for the API. Startup methods are
// selected at build time; unsupported platforms never probe macOS paths.
type desktop struct{ dataDir string }

var _ api.Desktop = desktop{}
