package app

import (
	"archive/zip"
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/url"
	"strings"
	"testing"
)

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{40, 120, 200, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func docxBytes(t *testing.T, paragraphs ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	f, _ := z.Create("word/document.xml")
	body := `<w:document xmlns:w="w"><w:body>`
	for _, p := range paragraphs {
		body += `<w:p><w:r><w:t>` + p + `</w:t></w:r></w:p>`
	}
	f.Write([]byte(body + `</w:body></w:document>`))
	z.Close()
	return buf.Bytes()
}

// Files sent with a message: the conversation shows them as attachments (not text), the model reads the list (and
// sees the images, when it can), and the agent reads Word files as text.
func TestMessagesCarryAttachments(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	fake := newFakeProvider(t, "openai", "plain reply")
	h.mustDo("POST", "/api/providers", map[string]any{"id": "script", "name": "Script", "kind": "openai-compatible", "baseUrl": fake.URL + "/v1"}, 201)
	h.mustDo("PUT", "/api/providers/script/models/s1", map[string]any{"name": "Text only"}, 200)
	h.mustDo("PUT", "/api/providers/script/models/eyes", map[string]any{"name": "Sees", "images": true}, 200)
	agent := h.agentOn("Reader", "script/s1", map[string]any{"workspace": map[string]any{"tools": []string{"read"}}})
	upload := func(name string, content []byte) map[string]any {
		code, _, body := h.raw("POST", "/api/agents/"+agent+"/attachments?name="+url.QueryEscape(name), "application/octet-stream", content)
		if code != 201 {
			t.Fatalf("upload %q: %d %s", name, code, body)
		}
		return decodeInto[struct{ Data map[string]any }](t, body).Data
	}
	pic := upload("screen.png", pngBytes(t, 3000, 40))
	doc := upload("report.docx", docxBytes(t, "Quarterly report", "Sales grew 12%"))
	files := []map[string]any{pic, doc}
	last := func() string {
		chats := fake.chats()
		return string(chats[len(chats)-1].Body)
	}

	// A model without image input: the files are named, and it is told it can't see the image.
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]any{"text": "What's in these?", "requestId": "r1", "attachments": files}, 202)
	v := h.waitReply(agent, "t1")
	body := last()
	if !strings.Contains(body, "Attached files (in your workspace):") || !strings.Contains(body, doc["path"].(string)) || !strings.Contains(body, "can't see images") || strings.Contains(body, "image_url") {
		t.Fatalf("text-only model's message: %s", body)
	}
	first := v.Messages[0]
	if first.Text != "What's in these?" || len(first.Attachments) != 2 || first.Attachments[0].Name != "screen.png" || first.Attachments[1].Path != doc["path"] {
		t.Fatalf("the transcript's message: %+v", first)
	}

	// A model that sees: the image goes in the message, resized to fit.
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t2/messages", map[string]any{"text": "And now?", "requestId": "r1", "attachments": []map[string]any{pic}, "modelId": "script/eyes"}, 202)
	h.waitReply(agent, "t2")
	if body := last(); !strings.Contains(body, `"image_url"`) || !strings.Contains(body, "data:image/") {
		t.Fatalf("the image isn't in the message: %.600s", body)
	}

	// Files alone are a message too; the conversation is named after them.
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t3/messages", map[string]any{"text": "", "requestId": "r1", "attachments": []map[string]any{doc}}, 202)
	h.waitReply(agent, "t3")
	if th := decodeInto[[]struct{ ThreadID, Title string }](t, h.mustDo("GET", "/api/agents/"+agent+"/threads", nil, 200)); !hasThreadTitled(th, "t3", "report.docx") {
		t.Fatalf("an attachments-only conversation's title: %+v", th)
	}

	// Paths outside the workspace, too many files, or nothing at all are refused.
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t4/messages", map[string]any{"text": "x", "attachments": []map[string]any{{"path": "../secret.txt", "name": "s"}}}, 400)
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t4/messages", map[string]any{"text": "x", "attachments": []map[string]any{{"path": "/etc/passwd", "name": "s"}}}, 400)
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t4/messages", map[string]any{"text": ""}, 400)

	// The agent reads the Word file as text.
	v = h.sendAndWait(agent, "t5", "READ:"+doc["path"].(string), "r1")
	if reply := lastReply(v); !strings.Contains(reply, "Quarterly report") || !strings.Contains(reply, "Sales grew 12%") || !strings.Contains(reply, "Word document") {
		t.Fatalf("reading the Word file: %q", reply)
	}
	// And a PDF (pdf.js, inside the runtime bundle).
	paper := upload("paper.pdf", pdfBytes("Findings on page one"))
	v = h.sendAndWait(agent, "t6", "READ:"+paper["path"].(string), "r1")
	if reply := lastReply(v); !strings.Contains(reply, "Findings on page one") || !strings.Contains(reply, "PDF, 1 page") {
		t.Fatalf("reading the PDF: %q", reply)
	}
}

// pdfBytes is a one-page PDF with a line of text (Helvetica), offsets computed.
func pdfBytes(text string) []byte {
	stream := "BT /F1 18 Tf 72 720 Td (" + text + ") Tj ET"
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream),
	}
	out := "%PDF-1.4\n"
	var offsets []int
	for i, o := range objects {
		offsets = append(offsets, len(out))
		out += fmt.Sprintf("%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	xref := len(out)
	out += fmt.Sprintf("xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for _, off := range offsets {
		out += fmt.Sprintf("%010d 00000 n \n", off)
	}
	out += fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xref)
	return []byte(out)
}

func hasThreadTitled(list []struct{ ThreadID, Title string }, id, title string) bool {
	for _, th := range list {
		if th.ThreadID == id {
			return th.Title == title
		}
	}
	return false
}
