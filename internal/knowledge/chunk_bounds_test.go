package knowledge

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"
)

// Counts bounded traversal checkpoints, and can cancel at an exact one (no timing/race-based assertions).
type splitProbeContext struct {
	context.Context
	checks  int
	onCheck func(int)
}

func (c *splitProbeContext) Err() error {
	c.checks++
	if c.onCheck != nil {
		c.onCheck(c.checks)
	}
	return c.Context.Err()
}

func splitAllocations(t *testing.T, input string, budget int) (uint64, int) {
	t.Helper()
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	out, err := splitContext(context.Background(), input, "text", budget)
	runtime.ReadMemStats(&after)
	if err != nil {
		t.Fatal(err)
	}
	runtime.KeepAlive(out)
	return after.TotalAlloc - before.TotalAlloc, len(out)
}

func TestSingleMiBLineHasLinearAllocationAndTraversalCosts(t *testing.T) {
	for name, input := range map[string]string{
		"ASCII": strings.Repeat("x", 1<<20),
		"UTF-8": strings.Repeat("界😀", (1<<20)/7),
	} {
		t.Run(name, func(t *testing.T) {
			allocated, count := splitAllocations(t, input, maxPassagesPerFile)
			t.Logf("%d input bytes: %d allocated bytes, %d passages", len(input), allocated, count)
			// Includes all output builders and passage metadata. The old suffix conversions allocated over 2 GiB
			// on a 1 MiB ASCII line. This is a byte budget, not a flaky runtime threshold.
			if allocated > uint64(16*len(input)) || count == 0 {
				t.Fatalf("%d input bytes allocated %d bytes for %d passages", len(input), allocated, count)
			}
			small := &splitProbeContext{Context: context.Background()}
			large := &splitProbeContext{Context: context.Background()}
			SplitContext(small, input, "text")
			SplitContext(large, input+input, "text")
			if large.checks > 2*small.checks+32 {
				t.Fatalf("nonlinear traversal: %d versus %d checkpoints", small.checks, large.checks)
			}
		})
	}
}

func TestLongLineCutterOnlySlicesTheOriginalUTF8Input(t *testing.T) {
	input := strings.Repeat("界😀", 100_000)
	parts := 0
	allocs := testing.AllocsPerRun(5, func() {
		cursor := textCursor{text: input}
		parts = 0
		more, err := cursor.cutLine(context.Background(), TargetChars, func(part string) bool {
			parts++
			if !utf8.ValidString(part) || utf8.RuneCountInString(part) > TargetChars {
				panic("cut through a rune or exceeded the passage limit")
			}
			return true
		})
		if err != nil || !more || cursor.pos != len(input) {
			panic("did not consume the line")
		}
	})
	if allocs > 1 || parts != (200_000+TargetChars-1)/TargetChars {
		t.Fatalf("%g allocations for %d sliced pieces", allocs, parts)
	}
}

func TestSplittingStopsAtTheRemainingBudgetWithoutScanningTheSuffix(t *testing.T) {
	input := strings.Repeat("x", 32<<20)
	probe := &splitProbeContext{Context: context.Background()}
	out, err := splitContext(probe, input, "text", 2)
	if err != nil || len(out) != 2 || len(out[0].Text) != TargetChars || probe.checks > 64 {
		t.Fatalf("budget: %d passages, %d checkpoints, %v", len(out), probe.checks, err)
	}
	allocated, count := splitAllocations(t, input, 2)
	if allocated > 128<<10 || count != 2 {
		t.Fatalf("budgeted split allocated %d bytes for %d passages", allocated, count)
	}
	// The production cap applies within a single huge line, not just between eagerly generated blocks.
	out, err = SplitContext(context.Background(), input, "text")
	if err != nil || len(out) != maxPassagesPerFile {
		t.Fatalf("production cap: %d %v", len(out), err)
	}
}

func TestSplittingChecksCancellationInsideLongLinesAndWhitespace(t *testing.T) {
	for name, input := range map[string]string{
		"plain":   strings.Repeat("x", 1<<20),
		"heading": "# " + strings.Repeat("界", 1<<20),
		"table":   "| Name |\n| --- |\n| " + strings.Repeat("cell ", 1<<20) + " |",
		"spaces":  strings.Repeat(" ", 1<<20),
		"CRLF":    strings.Repeat("x\r\ny\r\n\r\n", 100_000),
	} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			probe := &splitProbeContext{Context: ctx, onCheck: func(n int) {
				if n == 20 {
					cancel()
				}
			}}
			out, err := SplitContext(probe, input, "md")
			if !errors.Is(err, context.Canceled) || out != nil || probe.checks != 20 {
				t.Fatalf("cancellation: %d passages, %d checkpoints, %v", len(out), probe.checks, err)
			}
		})
	}
}
