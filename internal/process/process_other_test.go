//go:build !darwin && !linux

package process

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"testing"
)

func TestUnsupportedBeforeLaunch(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^$")
	if _, err := Start(context.Background(), cmd); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("got %v", err)
	}
	if cmd.Process != nil {
		t.Fatal("unsupported platform launched a child")
	}
}
