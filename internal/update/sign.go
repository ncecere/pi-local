// Package update keeps Pi Local up to date from its GitHub releases: it checks for a newer release, downloads its
// archive, checks the archive's ed25519 signature against the key built into the app (the releases aren't signed by
// Apple, so this is what says an update is ours), and installs it in place.
package update

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// message is what a signature covers: the archive's name and its SHA-256 (so a signature can't be moved to another
// file, or another release's file).
func message(name, digest string) []byte {
	return []byte("pi-local release v1\n" + name + "\n" + digest + "\n")
}

// Digest is a file's SHA-256, in hex.
func Digest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Sign signs an archive (by its file name and digest); the signature is base64.
func Sign(key ed25519.PrivateKey, path string) (string, error) {
	digest, err := Digest(path)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(ed25519.Sign(key, message(filepath.Base(path), digest))), nil
}

// ErrBadSignature: the archive isn't signed with the release key.
var ErrBadSignature = errors.New("the update's signature doesn't match Pi Local's release key")

// Verify checks an archive's signature.
func Verify(key ed25519.PublicKey, path, signature string) error {
	return VerifyNamed(key, path, filepath.Base(path), signature)
}

// VerifyNamed checks an archive saved under another name, against the name it was published as.
func VerifyNamed(key ed25519.PublicKey, path, name, signature string) error {
	sig, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("%w (malformed)", ErrBadSignature)
	}
	digest, err := Digest(path)
	if err != nil {
		return err
	}
	if !ed25519.Verify(key, message(name, digest), sig) {
		return ErrBadSignature
	}
	return nil
}
