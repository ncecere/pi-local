// Package knowledgetest builds small documents in code, for tests of the knowledge index and the app (no binary
// fixtures in the repository).
package knowledgetest

import (
	"archive/zip"
	"bytes"
	"fmt"
	"html"
	"strings"
)

// PDF is a PDF with one line of text on each page (Helvetica, no fonts embedded), offsets computed.
func PDF(pages ...string) []byte {
	var objects []string
	var kids []string
	for i := range pages {
		kids = append(kids, fmt.Sprintf("%d 0 R", 4+i*2))
	}
	objects = append(objects, "<< /Type /Catalog /Pages 2 0 R >>")
	objects = append(objects, fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), len(pages)))
	objects = append(objects, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	esc := strings.NewReplacer("(", `\(`, ")", `\)`, `\`, `\\`)
	for i, text := range pages {
		stream := ""
		if text != "" {
			stream = fmt.Sprintf("BT /F1 18 Tf 72 720 Td (%s) Tj ET", esc.Replace(text))
		}
		objects = append(objects, fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>", 5+i*2))
		objects = append(objects, fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream))
	}
	var out bytes.Buffer
	out.WriteString("%PDF-1.4\n")
	var offsets []int
	for i, body := range objects {
		offsets = append(offsets, out.Len())
		fmt.Fprintf(&out, "%d 0 obj\n%s\nendobj\n", i+1, body)
	}
	xref := out.Len()
	fmt.Fprintf(&out, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for _, o := range offsets {
		fmt.Fprintf(&out, "%010d 00000 n \n", o)
	}
	fmt.Fprintf(&out, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xref)
	return out.Bytes()
}

// DOCX is a Word document: a title, a heading, and the paragraphs under it.
func DOCX(title, heading string, paragraphs ...string) []byte {
	var body strings.Builder
	p := func(style, text string) {
		sty := ""
		if style != "" {
			sty = `<w:pPr><w:pStyle w:val="` + style + `"/></w:pPr>`
		}
		fmt.Fprintf(&body, `<w:p>%s<w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>`, sty, html.EscapeString(text))
	}
	p("Title", title)
	p("Heading1", heading)
	for _, t := range paragraphs {
		p("", t)
	}
	doc := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` + body.String() + `</w:body></w:document>`
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range map[string]string{"[Content_Types].xml": "<Types/>", "word/document.xml": doc} {
		w, _ := zw.Create(name)
		w.Write([]byte(content))
	}
	zw.Close()
	return buf.Bytes()
}
