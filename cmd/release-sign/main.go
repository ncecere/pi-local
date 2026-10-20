// release-sign makes and uses the key Pi Local's releases are signed with (ed25519). The app has the public key built
// in (internal/update) and installs an update only when its archive's signature checks out.
//
//	release-sign keygen <private-key-file>      writes a new key (0600) and prints the public key (base64)
//	release-sign sign <archive>                 signs with RELEASE_SIGNING_KEY (base64 private key) → <archive>.sig
//	release-sign verify <archive> <public-key>  checks <archive>.sig
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ncecere/pi-local/internal/update"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: release-sign keygen <file> | sign <archive> | verify <archive> <public-key>")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "keygen":
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		check(err)
		if _, err := os.Stat(os.Args[2]); err == nil {
			fail("%s exists: not overwriting a signing key", os.Args[2])
		}
		check(os.MkdirAll(filepath.Dir(os.Args[2]), 0o700))
		check(os.WriteFile(os.Args[2], []byte(base64.StdEncoding.EncodeToString(priv)+"\n"), 0o600))
		fmt.Println(base64.StdEncoding.EncodeToString(pub))
	case "sign":
		raw := strings.TrimSpace(os.Getenv("RELEASE_SIGNING_KEY"))
		if raw == "" {
			fail("RELEASE_SIGNING_KEY is not set")
		}
		key, err := base64.StdEncoding.DecodeString(raw)
		if err != nil || len(key) != ed25519.PrivateKeySize {
			fail("RELEASE_SIGNING_KEY isn't a base64 ed25519 private key")
		}
		sig, err := update.Sign(ed25519.PrivateKey(key), os.Args[2])
		check(err)
		check(os.WriteFile(os.Args[2]+".sig", []byte(sig+"\n"), 0o644))
		fmt.Println("signed", os.Args[2])
	case "verify":
		if len(os.Args) < 4 {
			fail("verify <archive> <public-key>")
		}
		pub, err := base64.StdEncoding.DecodeString(os.Args[3])
		if err != nil || len(pub) != ed25519.PublicKeySize {
			fail("not a base64 ed25519 public key")
		}
		sig, err := os.ReadFile(os.Args[2] + ".sig")
		check(err)
		check(update.Verify(ed25519.PublicKey(pub), os.Args[2], strings.TrimSpace(string(sig))))
		fmt.Println("ok")
	default:
		fail("unknown command %q", os.Args[1])
	}
}

func check(err error) {
	if err != nil {
		fail("%v", err)
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "release-sign: "+format+"\n", args...)
	os.Exit(1)
}
