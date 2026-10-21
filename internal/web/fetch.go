package web

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

// Page is a fetched page, as an agent reads it.
type Page struct {
	URL         string `json:"url"` // after redirects
	Title       string `json:"title"`
	ContentType string `json:"contentType"`
	Text        string `json:"text"` // Markdown for HTML; the body for text; cut at maxChars
	Truncated   bool   `json:"truncated"`
	Offset      int    `json:"offset"`
	Chars       int    `json:"chars"` // the whole readable length before cutting
}

const (
	maxBody         = 5 << 20
	defaultMaxChars = 40_000
	fetchTimeout    = 25 * time.Second
	userAgent       = "Mozilla/5.0 (compatible; PiLocal/1.0; +https://github.com/ncecere/pi-local)"
)

// Fetcher reads web pages for agents. It refuses addresses on this computer and private networks unless allowed, and
// checks them when it connects (after DNS, on every redirect), so a name that resolves to 127.0.0.1 is refused too.
type Fetcher struct {
	client *http.Client
}

var errPrivate = errors.New("private address")

// NewFetcher makes a fetcher; allowPrivate is for tests.
func NewFetcher(allowPrivate bool) *Fetcher {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	if !allowPrivate {
		dialer.Control = func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip, err := netip.ParseAddr(host)
			if err != nil || !public(ip) {
				return errPrivate
			}
			return nil
		}
	}
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		MaxIdleConns:          10,
		IdleConnTimeout:       30 * time.Second,
	}
	return &Fetcher{client: &http.Client{
		Transport: transport,
		Timeout:   fetchTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errors.New("redirect to a non-web address")
			}
			return nil
		},
	}}
}

// public reports whether an address is on the public internet.
func public(ip netip.Addr) bool {
	ip = ip.Unmap()
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() ||
		ip.IsUnspecified() || ip.IsInterfaceLocalMulticast() {
		return false
	}
	for _, p := range []string{"100.64.0.0/10", "192.0.0.0/24", "198.18.0.0/15", "0.0.0.0/8", "240.0.0.0/4", "64:ff9b::/96"} {
		if netip.MustParsePrefix(p).Contains(ip) {
			return false
		}
	}
	return true
}

func fetchFailed(format string, args ...any) error {
	return &Error{Status: http.StatusBadGateway, Code: "fetch_failed", Message: fmt.Sprintf(format, args...)}
}

// Fetch reads one page, from character offset on (a long page is read in parts).
func (f *Fetcher) Fetch(ctx context.Context, raw string, offset, maxChars int) (*Page, error) {
	if maxChars <= 0 || maxChars > 200_000 {
		maxChars = defaultMaxChars
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || len(raw) > 4096 {
		return nil, bad("invalid_url", "Give a full web address starting with https://.")
	}
	u.Fragment = ""
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, bad("invalid_url", "That address can't be used.")
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5")
	req.Header.Set("Accept-Language", "en;q=0.9,*;q=0.5")
	resp, err := f.client.Do(req)
	if err != nil {
		switch {
		case errors.Is(err, errPrivate):
			return nil, fetchFailed("%s is on this computer or a private network: agents may only read public web pages.", u.Host)
		case errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "Timeout"):
			return nil, fetchFailed("%s took too long to answer.", u.Host)
		default:
			var dns *net.DNSError
			if errors.As(err, &dns) {
				return nil, fetchFailed("Can't find %s: check the address.", u.Host)
			}
			return nil, fetchFailed("Could not read %s (%s).", u.Host, shortErr(err))
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fetchFailed("%s answered %d %s.", u.Host, resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	ctype, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, fetchFailed("Reading %s failed (%s).", u.Host, shortErr(err))
	}
	cut := len(body) > maxBody
	if cut {
		body = body[:maxBody]
	}
	page := &Page{URL: resp.Request.URL.String(), ContentType: ctype}
	switch {
	case ctype == "text/html" || ctype == "application/xhtml+xml" || (ctype == "" && looksHTML(body)):
		page.Title, page.Text = Readable(string(body), resp.Request.URL)
	case strings.HasPrefix(ctype, "text/") || ctype == "application/json" || strings.HasSuffix(ctype, "+json") || ctype == "application/xml":
		page.Text = strings.ToValidUTF8(string(body), "\uFFFD")
	case ctype == "application/pdf":
		return nil, fetchFailed("%s is a PDF; reading PDFs from the web isn't supported yet.", u.Host)
	default:
		return nil, fetchFailed("%s is a %s file, not a page that can be read as text.", u.Host, ctype)
	}
	page.Chars = utf8.RuneCountInString(page.Text)
	runes := []rune(page.Text)
	offset = min(max(offset, 0), len(runes))
	end := min(offset+maxChars, len(runes))
	page.Text = string(runes[offset:end])
	page.Offset = offset
	if end < len(runes) {
		page.Text += fmt.Sprintf("\n\n[… cut here at character %d of %d. Read on with offset %d.]", end, len(runes), end)
		page.Truncated = true
	}
	page.Truncated = page.Truncated || cut
	return page, nil
}

func looksHTML(b []byte) bool {
	head := strings.ToLower(string(b[:min(len(b), 512)]))
	return strings.Contains(head, "<html") || strings.Contains(head, "<!doctype html")
}

func shortErr(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 {
		msg = msg[i+2:]
	}
	return clip(msg, 120)
}

func htmlUnescape(s string) string { return html.UnescapeString(s) }
