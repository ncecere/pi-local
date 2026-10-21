package knowledge

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestPDFPagesBecomeLocatedPassagesAndTheConvertersTitleIsDropped(t *testing.T) {
	md := "# paper.pdf\n\n(PDF, 3 pages, as text)\n\n## Page 1\n\nThe warranty lasts two years.\n\n## Page 2\n\n(no text on this page)\n\n## Page 3\n\nRefunds take 14 days.\nContact support.\n"
	got := Split(md, "pdf")
	if len(got) != 2 {
		t.Fatalf("passages: %+v", got)
	}
	if got[0].Locator != "page 1" || got[0].Text != "The warranty lasts two years." {
		t.Errorf("first: %+v", got[0])
	}
	if got[1].Locator != "page 3" || !strings.Contains(got[1].Text, "Refunds take 14 days.\nContact support.") {
		t.Errorf("second: %+v", got[1])
	}
	for _, p := range got {
		if strings.Contains(p.Text, "as text") || strings.Contains(p.Text, "paper.pdf") {
			t.Errorf("the converter's title leaked into %+v", p)
		}
	}
}

func TestSheetsAndSlidesAreLocated(t *testing.T) {
	sheets := Split("# b.xlsx\n\n(Excel workbook, as tables)\n\n## Sheet: Budget\n\n| Item | Cost |\n| --- | --- |\n| Rent | 1200 |\n\n## Sheet: Empty\n\n(empty)\n", "xlsx")
	if len(sheets) != 1 || sheets[0].Locator != "sheet Budget" || !strings.Contains(sheets[0].Text, "| Rent | 1200 |") {
		t.Fatalf("sheets: %+v", sheets)
	}
	slides := Split("# d.pptx\n\n(PowerPoint presentation, as text)\n\n## Slide 1\n\n**Welcome**\n- Opening point\n\n## Slide 2\n\n**Later**\n", "pptx")
	if len(slides) != 2 || slides[0].Locator != "slide 1" || slides[1].Locator != "slide 2" {
		t.Fatalf("slides: %+v", slides)
	}
}

func TestAPassageNeverSpansTwoPagesButSmallParagraphsShareOne(t *testing.T) {
	md := "## Page 1\n\nOne.\n\nTwo.\n\nThree.\n\n## Page 2\n\nFour.\n"
	got := Split(md, "pdf")
	if len(got) != 2 || got[0].Text != "One.\n\nTwo.\n\nThree." || got[1].Locator != "page 2" {
		t.Fatalf("%+v", got)
	}
}

func TestLongTextIsCutNearTheTargetAtSentencesAndNothingIsLost(t *testing.T) {
	var sentences []string
	for i := 0; i < 200; i++ {
		sentences = append(sentences, fmt.Sprintf("Sentence number %d says something about refunds.", i))
	}
	one := strings.Join(sentences, " ") // a single 10,000-character paragraph
	got := Split(one, "text")
	if len(got) < 8 {
		t.Fatalf("only %d passages", len(got))
	}
	var joined strings.Builder
	for _, p := range got {
		if n := utf8.RuneCountInString(p.Text); n > TargetChars {
			t.Errorf("a passage of %d characters", n)
		}
		if !strings.HasSuffix(p.Text, ".") {
			t.Errorf("cut mid-sentence: %q", p.Text[max(0, len(p.Text)-30):])
		}
		joined.WriteString(p.Text + " ")
	}
	for i := 0; i < 200; i++ {
		if !strings.Contains(joined.String(), fmt.Sprintf("Sentence number %d says", i)) {
			t.Fatalf("sentence %d was lost", i)
		}
	}
}

func TestAnUnbrokenRunIsCutAtTheLimit(t *testing.T) {
	got := Split(strings.Repeat("x", 3000), "text")
	if len(got) != 3 || utf8.RuneCountInString(got[0].Text) != TargetChars {
		t.Fatalf("%d passages, first %d", len(got), utf8.RuneCountInString(got[0].Text))
	}
}

func TestALongTableIsCutByRowsEachPartKeepingItsHeader(t *testing.T) {
	rows := []string{"| Name | Amount |", "| --- | --- |"}
	for i := 0; i < 300; i++ {
		rows = append(rows, fmt.Sprintf("| Customer %d | %d |", i, i*10))
	}
	got := Split("## Sheet: Sales\n\n"+strings.Join(rows, "\n"), "xlsx")
	if len(got) < 3 {
		t.Fatalf("%d passages", len(got))
	}
	total := 0
	for _, p := range got {
		if p.Locator != "sheet Sales" || !strings.HasPrefix(p.Text, "| Name | Amount |\n| --- | --- |\n") {
			t.Fatalf("a part without the header: %q", p.Text[:min(80, len(p.Text))])
		}
		if utf8.RuneCountInString(p.Text) > TargetChars {
			t.Errorf("a part of %d characters", utf8.RuneCountInString(p.Text))
		}
		total += strings.Count(p.Text, "| Customer ")
	}
	if total != 300 {
		t.Fatalf("%d of 300 rows kept", total)
	}
}

func TestMarkdownAndWordPassagesAreLocatedByTheirHeading(t *testing.T) {
	md := "# Policy\n\nIntro text.\n\n## Refunds\n\nRefunds take 14 days.\n"
	got := Split(md, "md")
	if len(got) != 1 || got[0].Locator != `section "Policy"` {
		t.Fatalf("one passage starting under the first heading: %+v", got)
	}
	long := "# Policy\n\n" + strings.Repeat("Word ", 300) + "\n\n## Refunds\n\n" + strings.Repeat("Money ", 100) + "\n"
	got = Split(long, "md")
	last := got[len(got)-1]
	if last.Locator != `section "Refunds"` || !strings.Contains(last.Text, "Money") {
		t.Fatalf("%+v", got)
	}
	// Word documents: the converter's title and description lines are skipped.
	docx := Split("# r.docx\n\n(Word document, as text)\n\n## Quarterly report\n\n## Summary\n\nSales grew 12%.\n", "docx")
	if len(docx) != 1 || strings.Contains(docx[0].Text, "as text") || docx[0].Locator != `section "Quarterly report"` {
		t.Fatalf("%+v", docx)
	}
}

func TestEmptyAndBlankDocumentsHaveNoPassages(t *testing.T) {
	for _, in := range []string{"", "\n\n  \n", "# t.pdf\n\n(PDF, 1 page, as text)\n\n## Page 1\n\n(no text on this page)\n"} {
		if got := Split(in, "pdf"); len(got) != 0 {
			t.Errorf("%q: %+v", in, got)
		}
	}
}

func TestLargeHeadingsAndTableHeadersCannotMakeUnboundedPassages(t *testing.T) {
	for _, text := range []string{
		"# " + strings.Repeat("heading", 800) + "\n\n" + strings.Repeat("body ", 500),
		"| " + strings.Repeat("column", 800) + " |\n| --- |\n| data |\n| " + strings.Repeat("cell", 500) + " |",
		"| Small header |\n| --- |\n| " + strings.Repeat("cell", 500) + " |",
	} {
		for _, passage := range Split(text, "md") {
			if n := utf8.RuneCountInString(passage.Text); n > TargetChars {
				t.Fatalf("unbounded passage: %d characters", n)
			}
		}
	}
}

func TestAHugeFileIsCappedAtTheLimit(t *testing.T) {
	got := Split(strings.Repeat("A line of a log file that goes on and on.\n\n", 200_000), "text")
	if len(got) != maxPassagesPerFile {
		t.Fatalf("%d passages", len(got))
	}
}
