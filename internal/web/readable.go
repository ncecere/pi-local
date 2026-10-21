package web

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// Readable turns an HTML page into its title and the main text as Markdown: navigation, scripts, forms and the like
// are left out; the <article> or <main> is preferred when the page has one. Links are made absolute.
func Readable(page string, base *url.URL) (title, markdown string) {
	doc, err := html.Parse(strings.NewReader(page))
	if err != nil {
		return "", ""
	}
	title = strings.Join(strings.Fields(textOf(find(doc, atom.Title))), " ")
	root := find(doc, atom.Article)
	if root == nil {
		root = find(doc, atom.Main)
	}
	if root == nil {
		root = find(doc, atom.Body)
	}
	if root == nil {
		root = doc
	}
	w := &mdWriter{base: base}
	w.node(root)
	return title, w.result()
}

func find(n *html.Node, a atom.Atom) *html.Node {
	if n == nil {
		return nil
	}
	if n.Type == html.ElementNode && n.DataAtom == a {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if f := find(c, a); f != nil {
			return f
		}
	}
	return nil
}

func textOf(n *html.Node) string {
	if n == nil {
		return ""
	}
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

// skipped elements never hold the page's main text.
var skipped = map[atom.Atom]bool{
	atom.Script: true, atom.Style: true, atom.Noscript: true, atom.Svg: true, atom.Nav: true, atom.Footer: true,
	atom.Header: true, atom.Aside: true, atom.Form: true, atom.Button: true, atom.Iframe: true, atom.Template: true,
	atom.Select: true, atom.Input: true, atom.Textarea: true, atom.Canvas: true, atom.Object: true, atom.Embed: true,
	atom.Head: true, atom.Dialog: true, atom.Menu: true,
}

// noise: class or id words that mark page furniture (cookie banners, share bars, comments).
var noise = regexp.MustCompile(`(?i)\b(cookie|consent|banner|share|social|subscribe|newsletter|related|comment|sidebar|breadcrumb|promo|advert|popup|modal)`)

type mdWriter struct {
	base  *url.URL
	b     strings.Builder
	list  []int // ordered list counters; 0 for unordered
	pre   bool
	links int
}

func (w *mdWriter) result() string {
	out := w.b.String()
	// At most one blank line between blocks; trim each line's trailing spaces.
	lines := strings.Split(out, "\n")
	var kept []string
	blank := 0
	for _, l := range lines {
		l = strings.TrimRight(l, " \t")
		if l == "" {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		kept = append(kept, l)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

func (w *mdWriter) block() {
	s := w.b.String()
	if s == "" || strings.HasSuffix(s, "\n\n") {
		return
	}
	if strings.HasSuffix(s, "\n") {
		w.b.WriteString("\n")
		return
	}
	w.b.WriteString("\n\n")
}

func (w *mdWriter) line() {
	if s := w.b.String(); s != "" && !strings.HasSuffix(s, "\n") {
		w.b.WriteString("\n")
	}
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func (w *mdWriter) children(n *html.Node) {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		w.node(c)
	}
}

func (w *mdWriter) node(n *html.Node) {
	switch n.Type {
	case html.TextNode:
		if w.pre {
			w.b.WriteString(n.Data)
			return
		}
		t := strings.Join(strings.Fields(n.Data), " ")
		if t == "" {
			if strings.TrimSpace(n.Data) == "" && n.Data != "" {
				if s := w.b.String(); s != "" && !strings.HasSuffix(s, " ") && !strings.HasSuffix(s, "\n") {
					w.b.WriteString(" ")
				}
			}
			return
		}
		if s := w.b.String(); s != "" && !strings.HasSuffix(s, " ") && !strings.HasSuffix(s, "\n") && (n.Data[0] == ' ' || n.Data[0] == '\n' || n.Data[0] == '\t') {
			w.b.WriteString(" ")
		}
		w.b.WriteString(t)
		if last := n.Data[len(n.Data)-1]; last == ' ' || last == '\n' || last == '\t' {
			w.b.WriteString(" ")
		}
		return
	case html.ElementNode:
	default:
		w.children(n)
		return
	}
	if skipped[n.DataAtom] || attr(n, "hidden") != "" || attr(n, "aria-hidden") == "true" {
		return
	}
	if noise.MatchString(attr(n, "class")+" "+attr(n, "id")) && n.DataAtom != atom.Body && n.DataAtom != atom.Main && n.DataAtom != atom.Article {
		return
	}
	switch n.DataAtom {
	case atom.H1, atom.H2, atom.H3, atom.H4, atom.H5, atom.H6:
		w.block()
		w.b.WriteString(strings.Repeat("#", int(n.Data[1]-'0')) + " ")
		w.b.WriteString(strings.Join(strings.Fields(textOf(n)), " "))
		w.block()
	case atom.P, atom.Div, atom.Section, atom.Figure, atom.Figcaption, atom.Details, atom.Summary, atom.Address:
		w.block()
		w.children(n)
		w.block()
	case atom.Br:
		w.b.WriteString("\n")
	case atom.Hr:
		w.block()
		w.b.WriteString("---")
		w.block()
	case atom.Blockquote:
		w.block()
		inner := &mdWriter{base: w.base}
		inner.children(n)
		for _, l := range strings.Split(inner.result(), "\n") {
			w.b.WriteString("> " + l + "\n")
		}
		w.block()
	case atom.Pre:
		w.block()
		w.b.WriteString("```\n")
		w.pre = true
		w.b.WriteString(strings.TrimRight(textOf(n), "\n"))
		w.pre = false
		w.b.WriteString("\n```")
		w.block()
	case atom.Code:
		if w.pre {
			w.children(n)
			return
		}
		w.b.WriteString("`" + strings.Join(strings.Fields(textOf(n)), " ") + "`")
	case atom.Strong, atom.B:
		if t := strings.Join(strings.Fields(textOf(n)), " "); t != "" {
			w.b.WriteString("**" + t + "**")
		}
	case atom.Em, atom.I:
		if t := strings.Join(strings.Fields(textOf(n)), " "); t != "" {
			w.b.WriteString("_" + t + "_")
		}
	case atom.A:
		text := strings.Join(strings.Fields(textOf(n)), " ")
		href := strings.TrimSpace(attr(n, "href"))
		if text == "" {
			return
		}
		if href == "" || strings.HasPrefix(href, "#") || strings.HasPrefix(strings.ToLower(href), "javascript:") || w.links >= 400 {
			w.b.WriteString(text)
			return
		}
		if u, err := url.Parse(href); err == nil && w.base != nil {
			href = w.base.ResolveReference(u).String()
		}
		w.links++
		w.b.WriteString("[" + text + "](" + href + ")")
	case atom.Img:
		if alt := strings.TrimSpace(attr(n, "alt")); alt != "" {
			w.b.WriteString("[image: " + alt + "]")
		}
	case atom.Ul, atom.Ol:
		w.block()
		start := 0
		if n.DataAtom == atom.Ol {
			start = 1
		}
		w.list = append(w.list, start)
		w.children(n)
		w.list = w.list[:len(w.list)-1]
		w.block()
	case atom.Li:
		w.line()
		depth := max(len(w.list)-1, 0)
		w.b.WriteString(strings.Repeat("  ", depth))
		if len(w.list) > 0 && w.list[len(w.list)-1] > 0 {
			i := len(w.list) - 1
			w.b.WriteString(strconv.Itoa(w.list[i]) + ". ")
			w.list[i]++
		} else {
			w.b.WriteString("- ")
		}
		w.children(n)
		w.line()
	case atom.Table:
		w.block()
		w.table(n)
		w.block()
	case atom.Dt:
		w.line()
		w.b.WriteString("**" + strings.Join(strings.Fields(textOf(n)), " ") + "**")
		w.line()
	case atom.Dd:
		w.line()
		w.b.WriteString(": ")
		w.children(n)
		w.line()
	default:
		w.children(n)
	}
}

// table writes a Markdown table from rows of cells (header row first when there is a <th>).
func (w *mdWriter) table(t *html.Node) {
	var rows [][]string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.DataAtom == atom.Tr {
			var cells []string
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				if c.Type == html.ElementNode && (c.DataAtom == atom.Td || c.DataAtom == atom.Th) {
					cell := strings.Join(strings.Fields(textOf(c)), " ")
					cells = append(cells, strings.ReplaceAll(cell, "|", `\|`))
				}
			}
			if len(cells) > 0 {
				rows = append(rows, cells)
			}
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(t)
	if len(rows) == 0 || len(rows) > 300 {
		w.b.WriteString(strings.Join(strings.Fields(textOf(t)), " "))
		return
	}
	width := 0
	for _, r := range rows {
		width = max(width, len(r))
	}
	for i, r := range rows {
		for len(r) < width {
			r = append(r, "")
		}
		w.b.WriteString("| " + strings.Join(r, " | ") + " |\n")
		if i == 0 {
			w.b.WriteString("|" + strings.Repeat(" --- |", width) + "\n")
		}
	}
}
