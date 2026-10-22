// Package host provides explicit, narrowly scoped desktop capabilities. Construction
// does not probe the desktop, start commands, or access the person's files.
package host

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode"
)

// Opener keeps external URLs separate from local filesystem paths.
type Opener interface {
	OpenURL(string) error
	OpenPath(string) error
	RevealFile(string) error
}

type Capability string

const (
	OpenURL    Capability = "open-url"
	OpenPath   Capability = "open-path"
	RevealFile Capability = "reveal-file"
)

// Availability describes an implemented contract, not a runtime desktop probe.
// An available operation can still fail (for example, xdg-open is not installed).
type Availability struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
}

var ErrUnsupported = errors.New("host operation unsupported")

// UnavailableError is returned before executing anything for unsupported operations.
type UnavailableError struct {
	Platform  string
	Operation Capability
	Reason    string
}

func (e *UnavailableError) Error() string {
	return fmt.Sprintf("%s on %s: %s: %v", e.Operation, e.Platform, e.Reason, ErrUnsupported)
}
func (e *UnavailableError) Unwrap() error { return ErrUnsupported }

// Runner must wait/reap any helper it starts and honor context cancellation.
// It never invokes a shell. Tests inject a fake instead of desktop utilities.
type Runner interface {
	Run(context.Context, string, ...string) error
}

// Host implements only opener capabilities at this stage. It makes no claims
// about notifications, login startup, restart, or native transport isolation.
type Host struct {
	platform string
	runner   Runner
}

var _ Opener = (*Host)(nil)

// New is side-effect free; capabilities reflect the actual runtime OS.
func New() *Host { return NewWithRunner(runtime.GOOS, commandRunner{}) }

// NewWithRunner selects an explicit adapter and runner, primarily for isolated
// testing. A nil runner uses the bounded, owned command runner.
func NewWithRunner(platform string, runner Runner) *Host {
	if runner == nil {
		runner = commandRunner{}
	}
	return &Host{platform: platform, runner: runner}
}

func (h *Host) Capability(operation Capability) Availability {
	switch operation {
	case OpenURL, OpenPath, RevealFile:
		if h.platform == "darwin" || h.platform == "linux" {
			return Availability{true, "argv opener implemented; desktop utility availability is checked only on use"}
		}
		return Availability{false, "no safe opener adapter implemented for this platform"}
	default:
		return Availability{false, "unknown host capability"}
	}
}

func (h *Host) require(operation Capability) error {
	availability := h.Capability(operation)
	if !availability.Available {
		return &UnavailableError{h.platform, operation, availability.Reason}
	}
	return nil
}

// OpenURL accepts only the external protocols already allowed by the UI API and
// MCP sign-in flow: http and https. Files must go through OpenPath/RevealFile.
func (h *Host) OpenURL(raw string) error {
	if err := h.require(OpenURL); err != nil {
		return err
	}
	u, err := url.Parse(raw)
	decoded, decodeErr := url.PathUnescape(raw)
	if err != nil || decodeErr != nil || len(raw) > 8192 || hasControl(decoded) ||
		(u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.Opaque != "" {
		return errors.New("only valid http and https URLs without control characters may be opened")
	}
	return h.open(OpenURL, raw)
}

func hasControl(s string) bool { return strings.ContainsFunc(s, unicode.IsControl) }

func (h *Host) OpenPath(path string) error   { return h.openPath(OpenPath, path) }
func (h *Host) RevealFile(path string) error { return h.openPath(RevealFile, path) }

func (h *Host) openPath(operation Capability, path string) error {
	if err := h.require(operation); err != nil {
		return err
	}
	if path == "" || strings.ContainsRune(path, '\x00') {
		return errors.New("a nonempty local path without NUL is required")
	}
	// Absolute local paths cannot be interpreted as options or URL protocols by
	// either utility, even for relative filenames such as -report or https:notes.
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolving local path: %w", err)
	}
	return h.open(operation, absolute)
}

const helperTimeout = 15 * time.Second

func (h *Host) open(operation Capability, target string) error {
	var name string
	var args []string
	switch h.platform {
	case "darwin":
		name = "/usr/bin/open"
		if operation == RevealFile {
			args = append(args, "-R")
		}
		args = append(args, "--", target)
	case "linux":
		name = "xdg-open"
		if operation == RevealFile {
			target = filepath.Dir(target)
		}
		// xdg-open has no portable -- support; paths are made absolute above.
		args = []string{target}
	default:
		return &UnavailableError{h.platform, operation, "no safe opener adapter implemented for this platform"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), helperTimeout)
	defer cancel()
	if err := h.runner.Run(ctx, name, args...); err != nil {
		return fmt.Errorf("%s helper: %w", operation, err)
	}
	return nil
}
