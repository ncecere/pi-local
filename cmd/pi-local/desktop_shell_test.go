package main

import "testing"

func TestDesktopShellURL(t *testing.T) {
	for _, platform := range []string{"darwin", "windows", "linux", "", "unknown", "Darwin"} {
		t.Run(platform, func(t *testing.T) {
			want := "/?shell=desktop"
			if platform == "darwin" {
				want = "/?shell=desktop-mac"
			}
			if got := desktopShellURL(platform); got != want {
				t.Fatalf("desktopShellURL(%q) = %q, want %q", platform, got, want)
			}
		})
	}
}
