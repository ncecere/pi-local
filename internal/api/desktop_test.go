package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ncecere/pi-local/internal/host"
)

// Pure API consumer: no app, providers, vaults, notifications, or real desktop.
type fakeDesktop struct {
	capabilities DesktopCapabilities
	get          func() (bool, error)
	set          func(bool) error
}

func (d fakeDesktop) Capabilities() DesktopCapabilities { return d.capabilities }
func (d fakeDesktop) LaunchAtLogin() (bool, error)      { return d.get() }
func (d fakeDesktop) SetLaunchAtLogin(on bool) error    { return d.set(on) }

func desktopRequest(d Desktop, method string, body io.Reader) *httptest.ResponseRecorder {
	a := &API{Desktop: d}
	mux := http.NewServeMux()
	a.alwaysRoutes(mux)
	r := httptest.NewRequest(method, "/api/settings/desktop", body)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

func readDesktop(t *testing.T, w *httptest.ResponseRecorder) desktopSettings {
	t.Helper()
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	// Go struct decoding is case-insensitive; assert the actual wire contract
	// first so uppercase field/tag regressions cannot pass silently.
	var wire map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &wire); err != nil {
		t.Fatal(err)
	}
	data, ok := wire["data"].(map[string]any)
	if !ok || len(data) != 3 {
		t.Fatal("desktop data must expose exactly the known lower-case keys")
	}
	if _, ok := data["available"].(bool); !ok {
		t.Fatal("available must be a lower-case boolean field")
	}
	if _, ok := data["launchAtLogin"].(bool); !ok {
		t.Fatal("launchAtLogin must be a boolean field")
	}
	capabilities, ok := data["capabilities"].(map[string]any)
	if !ok || len(capabilities) != 1 {
		t.Fatal("capabilities must contain only the known operation")
	}
	startup, ok := capabilities["launchAtLogin"].(map[string]any)
	if !ok || len(startup) != 2 {
		t.Fatal("startup availability must expose exactly available/reason")
	}
	if _, ok := startup["available"].(bool); !ok {
		t.Fatal("startup available must be a lower-case boolean field")
	}
	if _, ok := startup["reason"].(string); !ok {
		t.Fatal("startup reason must be a lower-case string field")
	}
	var envelope struct {
		Data desktopSettings `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}

type unreadableBody struct{ t *testing.T }

func (b unreadableBody) Read([]byte) (int, error) {
	b.t.Fatal("unsupported PUT must not read/decode the body")
	return 0, io.ErrUnexpectedEOF
}

func TestDesktopUnsupported(t *testing.T) {
	for _, tc := range []struct {
		name           string
		desktopPresent bool
		capabilities   DesktopCapabilities
	}{
		{name: "absent"},
		{name: "unsupported", desktopPresent: true, capabilities: DesktopCapabilities{
			DesktopLaunchAtLogin: {Available: false, Reason: "No startup adapter."},
		}},
		{name: "missing capabilities", desktopPresent: true},
		{name: "missing operation", desktopPresent: true, capabilities: DesktopCapabilities{}},
		{name: "unknown capability", desktopPresent: true, capabilities: DesktopCapabilities{
			"launchAtLogIn": {Available: true, Reason: "Unknown spelling must not grant access."},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var d Desktop
			if tc.desktopPresent {
				d = fakeDesktop{
					capabilities: tc.capabilities,
					get:          func() (bool, error) { t.Fatal("unsupported getter touched"); return false, nil },
					set:          func(bool) error { t.Fatal("unsupported setter touched"); return nil },
				}
			}
			settings := readDesktop(t, desktopRequest(d, http.MethodGet, nil))
			capability := settings.Capabilities[DesktopLaunchAtLogin]
			if settings.Available != tc.desktopPresent || settings.LaunchAtLogin || capability.Available || capability.Reason == "" {
				t.Fatalf("unexpected unsupported settings: %+v", settings)
			}
			if len(settings.Capabilities) != 1 {
				t.Fatalf("unknown capabilities leaked: %+v", settings.Capabilities)
			}
			for _, body := range []io.Reader{unreadableBody{t}, strings.NewReader("not JSON"), strings.NewReader(`{"launchAtLogin":true}`)} {
				w := desktopRequest(d, http.MethodPut, body)
				if w.Code != http.StatusNotImplemented || !strings.Contains(w.Body.String(), `"code":"not_supported"`) || !strings.Contains(w.Body.String(), capability.Reason) {
					t.Fatalf("unsupported PUT: %d %s", w.Code, w.Body)
				}
			}
		})
	}
}

func TestDesktopSupported(t *testing.T) {
	capabilities := DesktopCapabilities{DesktopLaunchAtLogin: host.Availability{Available: true, Reason: "Fake startup adapter."}}
	on, gets, sets := false, 0, 0
	d := fakeDesktop{
		capabilities: capabilities,
		get:          func() (bool, error) { gets++; return on, nil },
		set:          func(value bool) error { sets++; on = value; return nil },
	}
	for _, want := range []bool{false, true, false} {
		if want || sets > 0 {
			body, _ := json.Marshal(map[string]bool{"launchAtLogin": want})
			settings := readDesktop(t, desktopRequest(d, http.MethodPut, strings.NewReader(string(body))))
			if settings.LaunchAtLogin != want || !settings.Available || !settings.Capabilities[DesktopLaunchAtLogin].Available {
				t.Fatalf("PUT: %+v", settings)
			}
		}
		settings := readDesktop(t, desktopRequest(d, http.MethodGet, nil))
		if settings.LaunchAtLogin != want || !settings.Available || settings.Capabilities[DesktopLaunchAtLogin] != capabilities[DesktopLaunchAtLogin] {
			t.Fatalf("GET: %+v", settings)
		}
	}
	if gets != 3 || sets != 2 {
		t.Fatalf("getter/setter calls = %d/%d", gets, sets)
	}
	w := desktopRequest(d, http.MethodPut, strings.NewReader("not JSON"))
	if w.Code != http.StatusBadRequest || sets != 2 {
		t.Fatalf("bad supported body mutated settings: %d %s", w.Code, w.Body)
	}
}

func TestDesktopSupportedErrors(t *testing.T) {
	d := fakeDesktop{
		capabilities: DesktopCapabilities{DesktopLaunchAtLogin: {Available: true, Reason: "Fake adapter."}},
		get:          func() (bool, error) { return false, errors.New("fake read failed") },
		set:          func(bool) error { return errors.New("fake write failed") },
	}
	for _, tc := range []struct{ method, body, message string }{
		{http.MethodGet, "", "fake read failed"},
		{http.MethodPut, `{"launchAtLogin":true}`, "Could not change launching at login: fake write failed"},
	} {
		w := desktopRequest(d, tc.method, strings.NewReader(tc.body))
		if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), tc.message) {
			t.Fatalf("supported error: %d %s", w.Code, w.Body)
		}
	}
}
