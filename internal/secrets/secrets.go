// Package secrets keeps what must not be on disk in the clear (provider API keys, header values, later MCP tokens)
// in the OS keychain: macOS Keychain, Windows Credential Manager, the Secret Service on Linux.
package secrets

import (
	"errors"
	"sync"

	"github.com/zalando/go-keyring"
)

// Service is the keychain service every item is filed under.
const Service = "Pi Local"

// ErrNotFound: nothing is stored under that name.
var ErrNotFound = errors.New("secret not found")

// Store holds secrets by name.
type Store interface {
	Get(name string) (string, error)
	Set(name, value string) error
	Delete(name string) error
}

// Keychain is the OS keychain.
type Keychain struct{}

func (Keychain) Get(name string) (string, error) {
	v, err := keyring.Get(Service, name)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNotFound
	}
	return v, err
}

func (Keychain) Set(name, value string) error { return keyring.Set(Service, name, value) }

func (Keychain) Delete(name string) error {
	err := keyring.Delete(Service, name)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

// Memory is a Store in memory, for tests and a data directory that must not touch the keychain.
type Memory struct {
	mu sync.Mutex
	m  map[string]string
}

// NewMemory makes an empty in-memory store.
func NewMemory() *Memory { return &Memory{m: map[string]string{}} }

func (s *Memory) Get(name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.m[name]
	if !ok {
		return "", ErrNotFound
	}
	return v, nil
}

func (s *Memory) Set(name, value string) error {
	s.mu.Lock()
	s.m[name] = value
	s.mu.Unlock()
	return nil
}

func (s *Memory) Delete(name string) error {
	s.mu.Lock()
	delete(s.m, name)
	s.mu.Unlock()
	return nil
}

// Names lists what is stored (tests).
func (s *Memory) Names() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.m))
	for k := range s.m {
		out = append(out, k)
	}
	return out
}
