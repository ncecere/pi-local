//go:build darwin && !server && !mcp

package host

// Only the default Darwin Wails build is eligible for legacy native trust.
// SDK server exposes Assets over TCP; SDK mcp adds a js_eval TCP surface.
const nativeConfirmationBuild = true
