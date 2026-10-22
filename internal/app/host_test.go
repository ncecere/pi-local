package app

import (
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/ncecere/pi-local/internal/host"
	"github.com/ncecere/pi-local/internal/secrets"
)

type fakeHostOpener struct {
	calls []string
	err   error
}

func (o *fakeHostOpener) OpenURL(s string) error  { o.calls = append(o.calls, "url:"+s); return o.err }
func (o *fakeHostOpener) OpenPath(s string) error { o.calls = append(o.calls, "path:"+s); return o.err }
func (o *fakeHostOpener) RevealFile(s string) error {
	o.calls = append(o.calls, "reveal:"+s)
	return o.err
}

func TestAppHostDispatch(t *testing.T) {
	// Construct only a value; never app.New (which starts services/listeners).
	o := &fakeHostOpener{}
	a := &App{cfg: Config{Opener: o, Secrets: secrets.NewMemory()}}
	path := filepath.Join(t.TempDir(), "-空 résumé.txt")
	for _, tc := range []struct{ input, operation string }{
		{path, "path:"}, {"-local notes", "path:"}, {"folder/no scheme:notes", "path:"},
		{"https://example.test/signin?state=a%26b", "url:"}, {"http://127.0.0.1:5342/callback", "url:"},
		{"https://example.test/%zz", "url:"}, {"file:///tmp/nope", "url:"}, {"javascript:alert(1)", "url:"},
	} {
		o.calls = nil
		if err := a.Reveal(tc.input); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(o.calls, []string{tc.operation + tc.input}) {
			t.Fatalf("wrong reveal dispatch: %+v", o.calls)
		}
	}
	o.calls = nil
	if err := a.RevealFile(path); err != nil {
		t.Fatal(err)
	}
	if err := a.OpenFile(path, false); err != nil {
		t.Fatal(err)
	}
	if err := a.OpenFile(path, true); err != nil {
		t.Fatal(err)
	}
	if err := a.OpenURL("https://example.test/oauth"); err != nil {
		t.Fatal(err)
	}
	want := []string{"reveal:" + path, "path:" + path, "reveal:" + path, "url:https://example.test/oauth"}
	if !reflect.DeepEqual(o.calls, want) {
		t.Fatalf("got %+v want %+v", o.calls, want)
	}
	o.err = errors.New("fake opener failed")
	for _, run := range []func() error{func() error { return a.OpenURL("https://example.test/") }, func() error { return a.Reveal(path) }, func() error { return a.RevealFile(path) }, func() error { return a.OpenFile(path, false) }, func() error { return a.OpenFile(path, true) }} {
		if err := run(); !errors.Is(err, o.err) {
			t.Fatalf("host failure lost: %v", err)
		}
	}
}

func TestAppOpenFileMemoryInjectionPreserved(t *testing.T) {
	o := &fakeHostOpener{err: errors.New("must never reach host")}
	wantErr := errors.New("injected file error")
	var calls []openedFile
	a := &App{cfg: Config{Secrets: secrets.NewMemory(), Opener: o, OpenFile: func(path string, reveal bool) error {
		calls = append(calls, openedFile{path, reveal})
		return wantErr
	}}}
	for _, reveal := range []bool{false, true} {
		if err := a.OpenFile("-résumé 空.txt", reveal); !errors.Is(err, wantErr) {
			t.Fatalf("injected error lost: %v", err)
		}
	}
	if !reflect.DeepEqual(calls, []openedFile{{"-résumé 空.txt", false}, {"-résumé 空.txt", true}}) || len(o.calls) != 0 {
		t.Fatalf("injection not preserved: %+v %+v", calls, o.calls)
	}
	if (Config{}).TrustedHumanConfirmations {
		t.Fatal("headless default unexpectedly trusts decisions")
	}
}

type refusingHostRunner struct{ t *testing.T }

func (r refusingHostRunner) Run(context.Context, string, ...string) error {
	r.t.Fatal("rejected input reached a desktop command")
	return nil
}

func TestAppHostRejectsInvalidURLsAndUnsupportedPlatforms(t *testing.T) {
	for _, platform := range []string{"darwin", "linux", "windows"} {
		a := &App{cfg: Config{Opener: host.NewWithRunner(platform, refusingHostRunner{t})}}
		for _, raw := range []string{"https://example.test/%zz", "https://example.test/?x=%0a", "javascript:alert(1)", "file:///tmp/nope", "mailto:person@example.test"} {
			if err := a.Reveal(raw); err == nil {
				t.Errorf("accepted legacy URL %q on %s", raw, platform)
			}
		}
		if platform == "windows" {
			for _, run := range []func() error{func() error { return a.OpenFile("local", false) }, func() error { return a.OpenFile("local", true) }, func() error { return a.Reveal("local") }} {
				if err := run(); !errors.Is(err, host.ErrUnsupported) {
					t.Fatalf("unsupported host lost: %v", err)
				}
			}
		}
	}
}

// Verify shared entrypoint wiring without importing/initializing Wails, starting
// app.New, or pretending synthetic HTTP requests prove native WebView isolation.
func TestHostEntrypointSourceWiring(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "..", "..")
	parse := func(path string) *ast.File {
		f, err := parser.ParseFile(token.NewFileSet(), filepath.Join(root, path), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		return f
	}
	selector := func(e ast.Expr, pkg, name string) bool {
		s, ok := e.(*ast.SelectorExpr)
		if !ok {
			return false
		}
		i, ok := s.X.(*ast.Ident)
		return ok && i.Name == pkg && s.Sel.Name == name
	}
	policyCall, trustedConfig := false, false
	ast.Inspect(parse("cmd/pi-local/main.go"), func(n ast.Node) bool {
		if options, ok := n.(*ast.CompositeLit); ok && selector(options.Type, "application", "Options") {
			for _, element := range options.Elts {
				if field, ok := element.(*ast.KeyValueExpr); ok {
					if key, ok := field.Key.(*ast.Ident); ok && key.Name == "Transport" {
						t.Error("custom Wails transport must explicitly deny native compatibility before changing this default-transport gate")
					}
				}
			}
		}
		if assignment, ok := n.(*ast.AssignStmt); ok && len(assignment.Lhs) == 1 && len(assignment.Rhs) == 1 {
			id, named := assignment.Lhs[0].(*ast.Ident)
			call, called := assignment.Rhs[0].(*ast.CallExpr)
			if named && id.Name == "policy" && called && selector(call.Fun, "host", "DesktopHumanConfirmationPolicy") && len(call.Args) == 1 {
				env, called := call.Args[0].(*ast.CallExpr)
				if called && selector(env.Fun, "os", "Getenv") && len(env.Args) == 1 {
					key, literal := env.Args[0].(*ast.BasicLit)
					policyCall = literal && key.Value == `"FRONTEND_DEVSERVER_URL"`
				}
			}
		}
		if field, ok := n.(*ast.KeyValueExpr); ok {
			if key, ok := field.Key.(*ast.Ident); ok && key.Name == "TrustedHumanConfirmations" {
				trustedConfig = selector(field.Value, "policy", "TrustedHumanConfirmations")
			}
		}
		return true
	})
	if !policyCall || !trustedConfig {
		t.Fatal("desktop entrypoint must use build-aware policy selection with the dev-server override")
	}
	ast.Inspect(parse("cmd/pi-local-server/main.go"), func(n ast.Node) bool {
		if field, ok := n.(*ast.KeyValueExpr); ok {
			if key, ok := field.Key.(*ast.Ident); ok && key.Name == "TrustedHumanConfirmations" {
				t.Error("headless entrypoint must leave host trust at its false default")
			}
		}
		return true
	})
	browserWired := false
	ast.Inspect(parse("internal/app/app.go"), func(n ast.Node) bool {
		if field, ok := n.(*ast.KeyValueExpr); ok {
			if key, ok := field.Key.(*ast.Ident); ok && key.Name == "OpenBrowser" {
				browserWired = selector(field.Value, "a", "OpenURL")
			}
		}
		return true
	})
	if !browserWired {
		t.Fatal("MCP browser must use explicit URL operation, not local-path reveal")
	}
}
