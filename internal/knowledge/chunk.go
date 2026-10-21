package knowledge

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// TargetChars is about how long a passage is (the unit the index returns and the model reads).
const TargetChars = 1200

// maxPassagesPerFile bounds one file: a huge spreadsheet or log would otherwise fill the index.
const maxPassagesPerFile = 3000

// Passage is a piece of a document, with where it is from.
type Passage struct {
	// Locator: "page 4", "sheet Budget", "slide 2", or (a Markdown or Word file) the heading it is under. Empty when
	// the file has no such structure.
	Locator string
	Text    string
}

var (
	// The headings the runtime's converters write for a page, a sheet and a slide (runtime/src/lib/documents.ts).
	structuralHeading = regexp.MustCompile(`^## (Page \d+|Sheet: .+|Slide \d+)\s*$`)
	// The line each converted document starts with, saying what it was ("(PDF, 3 pages, as text)").
	descriptorLine = regexp.MustCompile(`^\((PDF|Word document|Excel workbook|PowerPoint presentation)[^)]*\)$`)
	anyHeading     = regexp.MustCompile(`^#{1,6}\s+(.+?)\s*#*\s*$`)
	tableDivider   = regexp.MustCompile(`^\|[\s:|-]+\|$`)
)

// structured says whether the converter's headings (pages, sheets, slides) are the document's own structure.
func structured(kind string) bool { return kind == "pdf" || kind == "xlsx" || kind == "pptx" }

// locatorOf is how a page, sheet or slide heading reads in a citation: "page 4", "sheet Budget", "slide 2".
func locatorOf(heading string) string {
	if name, ok := strings.CutPrefix(heading, "Sheet: "); ok {
		name = strings.TrimSpace(name)
		if r := []rune(name); len(r) > 120 {
			name = string(r[:119]) + "…"
		}
		return "sheet " + name
	}
	return strings.ToLower(heading[:1]) + heading[1:]
}

func headingLocator(text string) string {
	if utf8.RuneCountInString(text) > 60 {
		text = string([]rune(text)[:59]) + "…"
	}
	return `section "` + text + `"`
}

// Split cuts a document's Markdown into passages of about TargetChars: whole paragraphs where they fit, a long
// paragraph at sentence or word breaks, a table by rows (each part with the table's header). kind says what the file
// was ("pdf", "xlsx", "pptx", "docx", "md", "text"): the converters' page, sheet and slide headings become the
// passages' locators, and a passage never spans two of them; in other files a passage is located by the heading
// above it.
func Split(markdown, kind string) []Passage {
	markdown = strings.ReplaceAll(strings.ReplaceAll(markdown, "\r\n", "\n"), "\r", "\n")
	var (
		out     []Passage
		cur     strings.Builder
		curLoc  string
		loc     string
		started bool // the converter's title and description lines are skipped once, at the top
	)
	flush := func() {
		if t := strings.TrimSpace(cur.String()); t != "" && len(out) < maxPassagesPerFile {
			out = append(out, Passage{Locator: curLoc, Text: t})
		}
		cur.Reset()
	}
	add := func(piece string) {
		if cur.Len() > 0 && utf8.RuneCountInString(cur.String())+2+utf8.RuneCountInString(piece) > TargetChars {
			flush()
		}
		if cur.Len() == 0 {
			curLoc = loc
		} else {
			cur.WriteString("\n\n")
		}
		cur.WriteString(piece)
	}

	for _, block := range blocks(markdown) {
		first, rest, _ := strings.Cut(block, "\n")
		first = strings.TrimRight(first, " \t")
		if structured(kind) {
			if m := structuralHeading.FindStringSubmatch(first); m != nil {
				flush()
				loc = locatorOf(m[1])
				block = strings.TrimSpace(rest)
				if block == "" {
					continue
				}
			} else if !started && (strings.HasPrefix(first, "# ") || descriptorLine.MatchString(first)) && rest == "" {
				continue // the converter's title and description
			}
		} else if kind == "docx" && !started && (strings.HasPrefix(first, "# ") || descriptorLine.MatchString(first)) && rest == "" {
			continue
		}
		started = true
		if strings.TrimSpace(block) == "(no text on this page)" || strings.TrimSpace(block) == "(empty)" {
			continue
		}
		if !structured(kind) {
			if m := anyHeading.FindStringSubmatch(first); m != nil {
				// A new section after a passage that has some substance starts a passage of its own, so a passage is
				// located by the section most of it is from; small sections share one.
				if cur.Len() >= 300 {
					flush()
				}
				loc = headingLocator(m[1])
			}
		}
		for _, piece := range pieces(block) {
			add(piece)
		}
		if len(out) >= maxPassagesPerFile {
			break
		}
	}
	flush()
	return out
}

// blocks are the paragraphs of a text: runs of lines between blank lines.
func blocks(text string) []string {
	var out []string
	var cur []string
	flush := func() {
		if len(cur) > 0 {
			out = append(out, strings.Join(cur, "\n"))
			cur = nil
		}
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		cur = append(cur, line)
	}
	flush()
	return out
}

// pieces splits a block that is longer than a passage; a short one is returned as it is.
func pieces(block string) []string {
	if utf8.RuneCountInString(block) <= TargetChars {
		return []string{block}
	}
	lines := strings.Split(block, "\n")
	// A Markdown table: by rows, each part under the table's header.
	header := ""
	if len(lines) > 2 && strings.HasPrefix(lines[0], "|") && tableDivider.MatchString(strings.TrimSpace(lines[1])) &&
		utf8.RuneCountInString(lines[0])+utf8.RuneCountInString(lines[1])+1 <= TargetChars/3 {
		header = lines[0] + "\n" + lines[1]
		lines = lines[2:]
	}
	var out []string
	var cur strings.Builder
	size := 0
	start := func() {
		cur.Reset()
		size = 0
		if header != "" {
			cur.WriteString(header)
			size = utf8.RuneCountInString(header)
		}
	}
	end := func() {
		if cur.Len() > 0 && (header == "" || size > utf8.RuneCountInString(header)) {
			out = append(out, cur.String())
		}
	}
	start()
	lineLimit := TargetChars
	if header != "" {
		lineLimit -= utf8.RuneCountInString(header) + 1
	}
	for _, line := range lines {
		for _, part := range cutLine(line, lineLimit) {
			n := utf8.RuneCountInString(part)
			if size+1+n > TargetChars && cur.Len() > 0 && (header == "" || size > utf8.RuneCountInString(header)) {
				end()
				start()
			}
			if cur.Len() > 0 {
				cur.WriteString("\n")
				size++
			}
			cur.WriteString(part)
			size += n
		}
	}
	end()
	return out
}

// cutLine splits one line longer than max at the last sentence end, else the last space, before max characters.
func cutLine(line string, max int) []string {
	if max < 200 {
		max = 200
	}
	runes := []rune(line)
	if len(runes) <= max {
		return []string{line}
	}
	var out []string
	for len(runes) > max {
		cut := -1
		for i := max - 1; i > max/2; i-- {
			if (runes[i] == ' ' && i > 0 && strings.ContainsRune(".!?;", runes[i-1])) || runes[i] == '\n' {
				cut = i
				break
			}
		}
		if cut < 0 {
			for i := max - 1; i > max/2; i-- {
				if runes[i] == ' ' {
					cut = i
					break
				}
			}
		}
		if cut < 0 {
			cut = max
		}
		out = append(out, strings.TrimSpace(string(runes[:cut])))
		runes = []rune(strings.TrimLeft(string(runes[cut:]), " "))
	}
	if len(runes) > 0 {
		out = append(out, string(runes))
	}
	return out
}
