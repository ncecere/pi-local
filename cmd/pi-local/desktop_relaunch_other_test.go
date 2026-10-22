//go:build !darwin

package main

import "testing"

func TestDesktopRelaunchUnsupported(t *testing.T) {
	// Deliberately no app.New, native Wails, executable/bundle discovery or
	// command factory. The unsupported adapter has no probe dependencies.
	type fakeUpdater struct{ Relaunch func(string) }
	type fakeAPI struct{ Restart func() }
	type fakeApp struct {
		Updater *fakeUpdater
		API     *fakeAPI
	}
	for _, stale := range []bool{false, true} {
		core := fakeApp{Updater: &fakeUpdater{}, API: &fakeAPI{}}
		if stale {
			core.Updater.Relaunch = func(string) { panic("stale relaunch called") }
			core.API.Restart = func() { panic("stale restart called") }
		}
		wireDesktopRelaunch(&core.Updater.Relaunch, &core.API.Restart, func() { panic("quit called") })
		if core.Updater.Relaunch != nil || core.API.Restart != nil {
			t.Fatal("unsupported platforms must not wire either hook")
		}
	}
}
