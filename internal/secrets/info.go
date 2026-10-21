package secrets

// Location describes where values reside, not where a wrapping key resides.
// An encrypted file with a vault-held key would not be LocationOSVault.
type Location string

const (
	LocationUnknown Location = "unknown"
	LocationOSVault Location = "os-vault"
	LocationMemory  Location = "memory"
)

// Info is optional, static storage metadata. It is not an availability, unlock,
// or successful-persistence assertion. A zero MaxValueBytes means unspecified,
// not unlimited. ValuesProtected means values use the OS vault's protection;
// Memory does not make that claim.
type Info struct {
	Location        Location
	ValuesProtected bool
	MaxValueBytes   int
}

// Describe obtains optional metadata without reading or probing the store.
// Store stays compatible with implementations offering only Get/Set/Delete.
func Describe(s Store) Info {
	if d, ok := s.(interface{ Info() Info }); ok {
		return d.Info()
	}
	return Info{Location: LocationUnknown}
}

func (k Keychain) Info() Info {
	i := Info{Location: LocationOSVault, ValuesProtected: true}
	if k.dependencies().goos == "windows" {
		i.MaxValueBytes = WindowsDirectMaxValueBytes
	}
	return i
}

func (*Memory) Info() Info { return Info{Location: LocationMemory} }
