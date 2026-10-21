// Package secrets stores sensitive values through an explicit Store boundary.
// Keychain uses the OS vault; Memory is an explicitly selected in-memory store.
package secrets

import "sync"

// Service is the keychain service every item is filed under.
const Service = "Pi Local"

// Store holds secrets by name.
type Store interface {
	Get(name string) (string, error)
	Set(name, value string) error
	Delete(name string) error
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

// InKeychain reports whether a store keeps secrets in the system keychain (not in memory, as a dev server does).
func InKeychain(s Store) bool {
	_, ok := s.(Keychain)
	if !ok {
		_, ok = s.(*Keychain)
	}
	return ok
}
