// Package runtimebundle embeds the agent runtime bundle (runtime/dist/runtime.mjs: run `pnpm bundle` here, or
// `make runtime`) into the app, which writes it out once per version and runs it on Node.
package runtimebundle

import _ "embed"

// Script is runtime.mjs.
//
//go:embed dist/runtime.mjs
var Script []byte
