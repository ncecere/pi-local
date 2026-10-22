//go:build !darwin

package update

import "context"

const installationAvailable = false

// CurrentBundle returns "": this build has no macOS app-bundle installer. It does
// not look up the executable or inspect the filesystem.
func CurrentBundle() string { return "" }

// BundleOf returns "" on builds without the macOS installer, without inspecting exe.
func BundleOf(exe string) string { return "" }

// Unsupported adapters refuse before inspecting paths, archives, or context.
func unpack(context.Context, string, string, string) (string, error) {
	return "", requireInstallation()
}

func swap(string, string) error { return requireInstallation() }
