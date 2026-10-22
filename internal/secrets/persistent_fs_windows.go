//go:build windows

package secrets

// Native ACL creation/verification and directory durability are a future gate.
// Refuse before creating directories or calling the injected vault.
func preparePrivateDir(string, persistentDeps) (string, error) { return "", ErrUnsupported }
func privateFile(string) error                                 { return ErrUnsupported }
func syncDirectory(string) error                               { return ErrUnsupported }
