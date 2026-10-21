package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestReadableKeepsTheArticleAsMarkdown(t *testing.T) {
	page := `<!doctype html><html><head><title> The Title </title><script>evil()</script></head><body>
<nav><a href="/home">Home</a></nav>
<div class="cookie-banner">We use cookies</div>
<article>
<h1>Big news</h1>
<p>First <strong>bold</strong> paragraph with a <a href="/more">link</a>.</p>
<ul><li>one</li><li>two</li></ul>
<ol><li>a</li><li>b</li><li>c</li><li>d</li><li>e</li><li>f</li><li>g</li><li>h</li><li>i</li><li>j</li><li>k</li></ol>
<pre><code>x := 1
y := 2</code></pre>
<table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>
</article>
<footer>Copyright</footer></body></html>`
	base, _ := url.Parse("https://example.com/news/item")
	title, md := Readable(page, base)
	if title != "The Title" {
		t.Errorf("title %q", title)
	}
	for _, want := range []string{"# Big news", "First **bold** paragraph with a [link](https://example.com/more).", "- one\n- two", "11. k", "```\nx := 1\ny := 2\n```", "| Name | Value |\n| --- | --- |\n| a | 1 |"} {
		if !strings.Contains(md, want) {
			t.Errorf("missing %q in:\n%s", want, md)
		}
	}
	for _, unwanted := range []string{"evil", "Home", "cookies", "Copyright"} {
		if strings.Contains(md, unwanted) {
			t.Errorf("kept %q", unwanted)
		}
	}
}

func TestFetchRefusesThisComputerAndPrivateNetworks(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("secret")) }))
	defer srv.Close()
	f := NewFetcher(false)
	for _, u := range []string{srv.URL, "http://localhost:" + strings.Split(srv.URL, ":")[2], "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]:1/"} {
		if _, err := f.Fetch(context.Background(), u, 0, 0); err == nil || !strings.Contains(err.Error(), "private network") {
			t.Errorf("%s: %v", u, err)
		}
	}
	for _, u := range []string{"file:///etc/passwd", "ftp://example.com", "not a url"} {
		if _, err := f.Fetch(context.Background(), u, 0, 0); err == nil {
			t.Errorf("%s was accepted", u)
		}
	}
}

func TestFetchReadsAPageAndCutsItInParts(t *testing.T) {
	long := "<html><head><title>T</title></head><body><article><p>" + strings.Repeat("word ", 3000) + "</p></article></body></html>"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/go":
			http.Redirect(w, r, "/page", http.StatusFound)
		case "/page":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte(long))
		case "/bin":
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write([]byte{0, 1, 2})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	f := NewFetcher(true)
	p, err := f.Fetch(context.Background(), srv.URL+"/go", 0, 1000)
	if err != nil || p.Title != "T" || !strings.HasSuffix(p.URL, "/page") || !p.Truncated || !strings.Contains(p.Text, "Read on with offset 1000") {
		t.Fatalf("%+v %v", p, err)
	}
	next, _ := f.Fetch(context.Background(), srv.URL+"/page", 1000, 1000)
	if next.Offset != 1000 || !strings.HasPrefix(next.Text, "word") && !strings.HasPrefix(next.Text, "ord") && !strings.HasPrefix(next.Text, " ") {
		t.Fatalf("second part: %q", next.Text[:20])
	}
	if _, err := f.Fetch(context.Background(), srv.URL+"/bin", 0, 0); err == nil || !strings.Contains(err.Error(), "not a page") {
		t.Fatalf("binary: %v", err)
	}
	if _, err := f.Fetch(context.Background(), srv.URL+"/missing", 0, 0); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("404: %v", err)
	}
}

func TestEachSearchServiceIsParsed(t *testing.T) {
	cases := map[string]string{
		"brave":   `{"web":{"results":[{"title":"A <strong>b</strong>","url":"https://a.example","description":"snip &amp; more","age":"2 days"}]}}`,
		"tavily":  `{"results":[{"title":"A b","url":"https://a.example","content":"snip & more"}]}`,
		"serpapi": `{"organic_results":[{"title":"A b","link":"https://a.example","snippet":"snip & more"}]}`,
		"searxng": `{"results":[{"title":"A b","url":"https://a.example","content":"snip & more"}]}`,
	}
	for provider, raw := range cases {
		got, err := parse(provider, []byte(raw))
		if err != nil || len(got) != 1 || got[0].Title != "A b" || got[0].URL != "https://a.example" || got[0].Snippet != "snip & more" {
			t.Errorf("%s: %+v %v", provider, got, err)
		}
	}
}
