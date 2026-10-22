package update

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Repo is where releases are published, "owner/name".
const Repo = "ncecere/pi-local"

// PublicKey is the release signing key's public half (release-sign keygen).
var PublicKey = mustKey(releasePublicKey)

func mustKey(b64 string) ed25519.PublicKey {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		panic("update: bad release public key")
	}
	return ed25519.PublicKey(raw)
}

// assetPattern is the archive a release carries for this Mac: Pi-Local-<version>-macos-arm64.zip.
var assetPattern = regexp.MustCompile(`^Pi-Local-[0-9][0-9A-Za-z.+-]*-macos-arm64\.zip$`)

// Release is a published release.
type Release struct {
	Version   string    `json:"version"`
	Notes     string    `json:"notes"`
	URL       string    `json:"url"`
	Published time.Time `json:"published"`
	asset     asset
	signature asset
}

type asset struct {
	name, url string
	size      int64
}

// Status is what the UI shows.
type Status struct {
	Current    string   `json:"current"`
	Latest     *Release `json:"latest"`
	Available  bool     `json:"available"`
	CheckedAt  *int64   `json:"checkedAt"`
	Error      *string  `json:"error"`
	CanInstall bool     `json:"canInstall"`
	// InstallBlocked says why an installed app can't update itself where it is (run from the disk image, or from
	// where macOS put a quarantined copy), or why this build has no installer. On macOS it is nil when installation
	// is possible, or when this isn't an installed app at all.
	InstallBlocked *string `json:"installBlocked"`
	AutoCheck      bool    `json:"autoCheck"`
	// Stage of an install in progress: downloading, verifying, backing-up, installing, restarting, or failed.
	Stage *string `json:"stage"`
}

// Updater checks for and installs updates.
type Updater struct {
	Current string
	Key     ed25519.PublicKey
	APIBase string // https://api.github.com
	Repo    string
	Client  *http.Client
	// Bundle is the installed app (…/Pi Local.app), "" when this isn't one (development): installing needs it.
	Bundle string
	// Relaunch quits the app after a swap so the new one starts (set by the desktop app).
	Relaunch func(bundle string)
	// BeforeInstall runs once the archive is verified and before anything is replaced (the app makes a backup of its
	// data here). An error stops the update: nothing was changed, and it may be tried again.
	BeforeInstall func(ctx context.Context) error
	// OnChange is told whenever the status changes.
	OnChange func(Status)
	// AutoCheck reads and writes the "check automatically" setting.
	LoadAutoCheck func() bool
	SaveAutoCheck func(bool) error

	mu        sync.Mutex
	latest    *Release
	checkedAt time.Time
	lastErr   string
	stage     string
}

// New makes an updater for this build.
func New(current, bundle string) *Updater {
	return &Updater{
		Current: current, Key: PublicKey, APIBase: "https://api.github.com", Repo: Repo, Bundle: bundle,
		Client:        &http.Client{Timeout: 10 * time.Minute},
		OnChange:      func(Status) {},
		LoadAutoCheck: func() bool { return true },
		SaveAutoCheck: func(bool) error { return nil },
	}
}

// Status is the current state.
func (u *Updater) Status() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	s := Status{Current: u.Current, Latest: u.latest, AutoCheck: u.LoadAutoCheck()}
	capability := InstallationCapability()
	if !capability.Available {
		s.InstallBlocked = &capability.Reason
	} else {
		s.CanInstall = u.Bundle != "" && u.Relaunch != nil
		if s.CanInstall {
			if why := installBlocker(u.Bundle); why != "" {
				s.CanInstall, s.InstallBlocked = false, &why
			}
		}
	}
	if u.latest != nil {
		s.Available = Newer(u.latest.Version, u.Current)
	}
	if !u.checkedAt.IsZero() {
		at := u.checkedAt.UnixMilli()
		s.CheckedAt = &at
	}
	if u.lastErr != "" {
		e := u.lastErr
		s.Error = &e
	}
	if u.stage != "" {
		st := u.stage
		s.Stage = &st
	}
	return s
}

func (u *Updater) changed() { u.OnChange(u.Status()) }

// Check asks GitHub for the latest release.
func (u *Updater) Check(ctx context.Context) Status {
	rel, err := u.fetchLatest(ctx)
	u.mu.Lock()
	u.checkedAt = time.Now()
	if err != nil {
		u.lastErr = err.Error()
	} else {
		u.latest, u.lastErr = rel, ""
	}
	u.mu.Unlock()
	u.changed()
	return u.Status()
}

func (u *Updater) fetchLatest(ctx context.Context) (*Release, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u.APIBase+"/repos/"+u.Repo+"/releases/latest", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Pi-Local/"+u.Current)
	resp, err := u.Client.Do(req)
	if err != nil {
		return nil, errors.New("couldn't reach GitHub to check for updates")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, errors.New("no releases have been published yet")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub answered %d", resp.StatusCode)
	}
	var body struct {
		TagName     string    `json:"tag_name"`
		Body        string    `json:"body"`
		HTMLURL     string    `json:"html_url"`
		Draft       bool      `json:"draft"`
		Prerelease  bool      `json:"prerelease"`
		PublishedAt time.Time `json:"published_at"`
		Assets      []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
			Size int64  `json:"size"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&body); err != nil {
		return nil, errors.New("GitHub's answer couldn't be read")
	}
	rel := &Release{Version: strings.TrimPrefix(body.TagName, "v"), Notes: body.Body, URL: body.HTMLURL, Published: body.PublishedAt}
	for _, a := range body.Assets {
		if assetPattern.MatchString(a.Name) {
			rel.asset = asset{a.Name, a.URL, a.Size}
		}
	}
	for _, a := range body.Assets {
		if rel.asset.name != "" && a.Name == rel.asset.name+".sig" {
			rel.signature = asset{a.Name, a.URL, a.Size}
		}
	}
	if rel.Version == "" {
		return nil, errors.New("the latest release has no version")
	}
	return rel, nil
}

// Newer reports whether version a is newer than b (semantic versions; a pre-release is older than its release; a
// development build "x-dev" or a commit hash is older than any release).
func Newer(a, b string) bool {
	pa, okA := parse(a)
	pb, okB := parse(b)
	if !okA {
		return false
	}
	if !okB {
		return true
	}
	for i := 0; i < 3; i++ {
		if pa.n[i] != pb.n[i] {
			return pa.n[i] > pb.n[i]
		}
	}
	switch {
	case pa.pre == pb.pre:
		return false
	case pa.pre == "":
		return true
	case pb.pre == "":
		return false
	default:
		return pa.pre > pb.pre
	}
}

type semver struct {
	n   [3]int
	pre string
}

func parse(v string) (semver, bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	core, pre, _ := strings.Cut(v, "-")
	core, _, _ = strings.Cut(core, "+")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return semver{}, false
	}
	var s semver
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return semver{}, false
		}
		s.n[i] = n
	}
	s.pre = pre
	return s, true
}

func (u *Updater) setStage(stage, errText string) {
	u.mu.Lock()
	u.stage, u.lastErr = stage, errText
	u.mu.Unlock()
	u.changed()
}

// Install downloads, verifies and installs the latest release, then relaunches. It runs in the background; the
// status (and OnChange) say how it goes.
func (u *Updater) Install(ctx context.Context) error {
	if err := requireInstallation(); err != nil {
		return err
	}
	st := u.Status()
	if !st.CanInstall {
		return errors.New("updates install into the installed app (Pi Local.app)")
	}
	if !st.Available || st.Latest == nil {
		return errors.New("there is no newer version")
	}
	u.mu.Lock()
	if u.stage != "" && u.stage != "failed" {
		u.mu.Unlock()
		return errors.New("an update is already being installed")
	}
	rel := u.latest
	u.mu.Unlock()
	if rel.asset.name == "" || rel.signature.name == "" {
		return errors.New("the release has no signed archive for this Mac")
	}
	go func() {
		if err := u.install(context.WithoutCancel(ctx), rel); err != nil {
			slog.Warn("installing an update", "version", rel.Version, "err", err)
			u.setStage("failed", err.Error())
		}
	}()
	return nil
}

func (u *Updater) download(ctx context.Context, a asset, path string, limit int64) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, a.url, nil)
	req.Header.Set("User-Agent", "Pi-Local/"+u.Current)
	resp, err := u.Client.Do(req)
	if err != nil {
		return fmt.Errorf("downloading %s: %w", a.name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading %s: status %d", a.name, resp.StatusCode)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, limit+1))
	f.Close()
	if err != nil {
		return err
	}
	if n > limit {
		return fmt.Errorf("%s is larger than expected", a.name)
	}
	return nil
}

func (u *Updater) install(ctx context.Context, rel *Release) error {
	if err := requireInstallation(); err != nil {
		return err
	}
	u.setStage("downloading", "")
	dir, err := os.MkdirTemp(filepath.Dir(u.Bundle), ".pi-local-update-")
	if err != nil {
		// The app's folder isn't writable (an admin-owned /Applications): nowhere to swap it.
		return fmt.Errorf("can't write next to %s; move Pi Local to a folder you can write to (or update it by hand)", u.Bundle)
	}
	defer os.RemoveAll(dir)
	archive := filepath.Join(dir, "update.zip")
	if err := u.download(ctx, rel.asset, archive, 1<<30); err != nil {
		return err
	}
	sigPath := filepath.Join(dir, "update.zip.sig")
	if err := u.download(ctx, rel.signature, sigPath, 4<<10); err != nil {
		return err
	}
	u.setStage("verifying", "")
	sig, err := os.ReadFile(sigPath)
	if err != nil {
		return err
	}
	if err := VerifyNamed(u.Key, archive, rel.asset.name, strings.TrimSpace(string(sig))); err != nil {
		return err
	}
	if u.BeforeInstall != nil {
		u.setStage("backing-up", "")
		if err := u.BeforeInstall(ctx); err != nil {
			return fmt.Errorf("the update wasn't installed, because the backup before it failed: %w", err)
		}
	}
	u.setStage("installing", "")
	staged, err := unpack(ctx, archive, dir, rel.Version)
	if err != nil {
		return err
	}
	if err := swap(u.Bundle, staged); err != nil {
		return err
	}
	// Relaunch may terminate this process without returning. Complete staging
	// cleanup before that handoff, not only in a defer that may never run.
	if err := os.RemoveAll(dir); err != nil {
		return errors.New("the update was installed, but temporary update files could not be removed; quit and reopen Pi Local")
	}
	u.setStage("restarting", "")
	u.Relaunch(u.Bundle)
	return nil
}

// AutoChecks checks now (after a moment) and every interval while automatic checks are on, until ctx ends.
func (u *Updater) AutoChecks(ctx context.Context, first, every time.Duration) {
	timer := time.NewTimer(first)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if u.LoadAutoCheck() {
			u.Check(ctx)
		}
		timer.Reset(every)
	}
}

// installBlocker is why the app at bundle can't be replaced in place, or "".
func installBlocker(bundle string) string {
	const move = "Move Pi Local to your Applications folder (and open it from there) to update it in place."
	if strings.Contains(bundle, "/AppTranslocation/") || strings.HasPrefix(bundle, "/Volumes/") {
		return move
	}
	// The swap renames the app within its folder, so that folder must be writable.
	probe, err := os.CreateTemp(filepath.Dir(bundle), ".pi-local-write-check-*")
	if err != nil {
		return move
	}
	probe.Close()
	os.Remove(probe.Name())
	return ""
}
