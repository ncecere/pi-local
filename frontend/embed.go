// Package frontend embeds the built UI (frontend/dist: run `pnpm build` here, or `make frontend`) into the app.
package frontend

import "embed"

// Dist is the built UI.
//
//go:embed all:dist
var Dist embed.FS
