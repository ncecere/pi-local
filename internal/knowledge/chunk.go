package knowledge

import (
	"context"
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
	Locator string // page 4, sheet Budget, slide 2, or the heading above it
	Text    string
}

var (
	structuralHeading = regexp.MustCompile(`^## (Page \d+|Sheet: .+|Slide \d+)\s*$`)
	descriptorLine    = regexp.MustCompile(`^\((PDF|Word document|Excel workbook|PowerPoint presentation)[^)]*\)$`)
	anyHeading        = regexp.MustCompile(`^#{1,6}\s+(.+?)\s*#*\s*$`)
	tableDivider      = regexp.MustCompile(`^\|[\s:|-]+\|$`)
)

func structured(kind string) bool { return kind == "pdf" || kind == "xlsx" || kind == "pptx" }

// shortLabel traverses only the prefix that can be used, not an arbitrarily large heading's suffix.
func shortLabel(text string, limit int) string {
	count, last := 0, 0
	for pos := range text {
		if count == limit {
			return text[:last] + "…"
		}
		last = pos
		count++
	}
	return text
}

func locatorOf(heading string) string {
	if name, ok := strings.CutPrefix(heading, "Sheet: "); ok {
		return "sheet " + shortLabel(strings.TrimSpace(name), 120)
	}
	return strings.ToLower(heading[:1]) + heading[1:]
}

func headingLocator(text string) string { return `section "` + shortLabel(text, 60) + `"` }

// Split is the non-cancellable convenience form. Indexing uses SplitContext with the service's lifetime context.
func Split(markdown, kind string) []Passage {
	passages, _ := SplitContext(context.Background(), markdown, kind)
	return passages
}

// SplitContext incrementally splits paragraphs, long lines and tables into bounded passages. No document-wide
// line/rune arrays or suffix copies are made. Reading stops as soon as the passage budget is full; every input
// traversal has bounded cancellation checkpoints, including lookahead and whitespace runs. Cancelled partial work
// is discarded, so shutdown cannot store a misleading partial index.
func SplitContext(ctx context.Context, markdown, kind string) ([]Passage, error) {
	return splitContext(ctx, markdown, kind, maxPassagesPerFile)
}

func splitContext(ctx context.Context, markdown, kind string, budget int) ([]Passage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if budget <= 0 {
		return nil, nil
	}
	var out []Passage
	var cur, piece strings.Builder
	var loc, curLoc, header string
	curChars, pieceChars, headerChars := 0, 0, 0
	paragraphStart, started := true, false

	flush := func() bool {
		if t := strings.TrimSpace(cur.String()); t != "" {
			out = append(out, Passage{Locator: curLoc, Text: t})
		}
		cur.Reset()
		curChars = 0
		return len(out) < budget
	}
	add := func(text string) bool {
		// Invalid UTF-8 is repaired only in this bounded piece, not in a second whole-document traversal.
		text = strings.ToValidUTF8(text, "\uFFFD")
		n := utf8.RuneCountInString(text)
		if cur.Len() > 0 && curChars+2+n > TargetChars && !flush() {
			return false
		}
		if cur.Len() == 0 {
			curLoc = loc
		} else {
			cur.WriteString("\n\n")
			curChars += 2
		}
		cur.WriteString(text)
		curChars += n
		return curChars < TargetChars || flush()
	}
	resetPiece := func() {
		piece.Reset()
		piece.WriteString(header)
		pieceChars = headerChars
	}
	emitPiece := func() bool {
		if piece.Len() == 0 || (header != "" && pieceChars == headerChars) {
			return true
		}
		if !add(piece.String()) {
			return false
		}
		resetPiece()
		return true
	}
	push := func(part string) bool {
		n := utf8.RuneCountInString(part)
		if piece.Len() > 0 && pieceChars+1+n > TargetChars && !emitPiece() {
			return false
		}
		if piece.Len() > 0 {
			piece.WriteByte('\n')
			pieceChars++
		}
		piece.WriteString(part)
		pieceChars += n
		return pieceChars < TargetChars || emitPiece()
	}

	input := textCursor{text: markdown}
	for input.pos < len(input.text) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		first, err := input.peekLine(ctx)
		if err != nil {
			return nil, err
		}
		if first.complete && strings.TrimSpace(first.text) == "" {
			if !emitPiece() {
				return out, nil
			}
			header, headerChars = "", 0
			resetPiece()
			paragraphStart = true
			input.pos = first.after
			continue
		}
		if paragraphStart {
			paragraphStart = false
			title := strings.TrimRight(first.text, " \t")
			if structured(kind) && first.complete {
				if m := structuralHeading.FindStringSubmatch(title); m != nil {
					if !flush() {
						return out, nil
					}
					loc = locatorOf(m[1])
					input.pos = first.after
					continue
				}
			}
			if !started && first.complete && (structured(kind) || kind == "docx") &&
				(strings.HasPrefix(title, "# ") || descriptorLine.MatchString(title)) {
				input.pos = first.after
				continue // converter's title and description
			}
			started = true
			if first.complete && (strings.TrimSpace(title) == "(no text on this page)" || strings.TrimSpace(title) == "(empty)") {
				input.pos = first.after
				continue
			}
			if !structured(kind) {
				if m := anyHeading.FindStringSubmatch(title); m != nil {
					if cur.Len() >= 300 && !flush() {
						return out, nil
					}
					loc = headingLocator(m[1])
				}
			}
			// Only a short table header is repeated. Lookahead is bounded even for a huge first row.
			if first.complete && strings.HasPrefix(title, "|") {
				look := textCursor{text: input.text, pos: first.after}
				second, err := look.peekLine(ctx)
				if err != nil {
					return nil, err
				}
				if second.complete && tableDivider.MatchString(strings.TrimSpace(second.text)) &&
					utf8.RuneCountInString(first.text)+utf8.RuneCountInString(second.text)+1 <= TargetChars/3 {
					header = first.text + "\n" + second.text
					headerChars = utf8.RuneCountInString(header)
					resetPiece()
					input.pos = second.after
					continue
				}
			}
		}
		limit := TargetChars
		if header != "" {
			limit -= headerChars + 1
		}
		more, err := input.cutLine(ctx, limit, push)
		if err != nil {
			return nil, err
		}
		if !more {
			return out, nil
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if emitPiece() {
		flush()
	}
	return out, nil
}

// textCursor holds byte offsets into the original input. Even a single unbroken line is consumed one bounded
// window at a time. It also normalizes CRLF and CR at line boundaries without copying the document.
type textCursor struct {
	text string
	pos  int
}

type linePrefix struct {
	text     string
	after    int
	complete bool
}

func (c textCursor) afterNewline(pos int) int {
	if pos < len(c.text) && c.text[pos] == '\r' {
		pos++
		if pos < len(c.text) && c.text[pos] == '\n' {
			pos++
		}
	} else if pos < len(c.text) && c.text[pos] == '\n' {
		pos++
	}
	return pos
}

func (c textCursor) peekLine(ctx context.Context) (linePrefix, error) {
	pos := c.pos
	for n := 0; pos < len(c.text) && n <= TargetChars; n++ {
		if n%256 == 0 {
			if err := ctx.Err(); err != nil {
				return linePrefix{}, err
			}
		}
		if c.text[pos] == '\n' || c.text[pos] == '\r' {
			return linePrefix{text: c.text[c.pos:pos], after: c.afterNewline(pos), complete: true}, nil
		}
		_, size := utf8.DecodeRuneInString(c.text[pos:])
		pos += size
	}
	return linePrefix{text: c.text[c.pos:pos], after: pos, complete: pos == len(c.text)}, nil
}

// cutLine decodes UTF-8 in one forward traversal and emits slices at sentence/word breaks. A fixed-size window
// carries already-decoded lookahead across a break; neither the suffix nor a document-sized rune array is copied.
// emit=false stops immediately, without traversing the next piece or a potentially enormous whitespace suffix.
func (c *textCursor) cutLine(ctx context.Context, limit int, emit func(string) bool) (bool, error) {
	limit = min(TargetChars, max(1, limit))
	var runes [TargetChars]rune
	var offsets [TargetChars + 1]int
	count, read := 0, c.pos
	offsets[0] = c.pos
	trimLeading := false
	for {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		for steps := 0; count < limit && read < len(c.text) && c.text[read] != '\n' && c.text[read] != '\r'; steps++ {
			if steps%256 == 0 {
				if err := ctx.Err(); err != nil {
					return false, err
				}
			}
			r, size := utf8.DecodeRuneInString(c.text[read:])
			read += size
			if trimLeading && count == 0 && r == ' ' {
				c.pos = read
				offsets[0] = read
				continue
			}
			runes[count] = r
			count++
			offsets[count] = read
		}
		complete := read == len(c.text) || c.text[read] == '\n' || c.text[read] == '\r'
		cut, space := count, -1
		if !complete {
			for i := count - 1; i > limit/2; i-- {
				if runes[i] == ' ' {
					if space < 0 {
						space = i
					}
					if strings.ContainsRune(".!?;", runes[i-1]) {
						cut = i
						break
					}
				}
			}
			if cut == count && space >= 0 {
				cut = space
			}
		}
		part := c.text[c.pos:offsets[cut]]
		if !complete {
			part = strings.TrimSpace(part)
		}
		c.pos = offsets[cut]
		if !emit(part) {
			return false, nil
		}
		if complete {
			c.pos = c.afterNewline(read)
			return true, nil
		}
		trimLeading = true
		for cut < count && runes[cut] == ' ' {
			cut++
		}
		c.pos = offsets[cut]
		count -= cut
		copy(runes[:], runes[cut:cut+count])
		copy(offsets[:], offsets[cut:cut+count+1])
	}
}
