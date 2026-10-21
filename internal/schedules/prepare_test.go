package schedules

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPrepareCanonicalDefaultsAndRepresentations(t *testing.T) {
	s := New(nil, nil, nil, nil)
	defer s.Close()
	s.now = func() time.Time { return time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC) }
	for _, name := range []string{"", "   ", "  Named  ", strings.Repeat("n", 100)} {
		for _, tz := range []string{"", "   ", " UTC "} {
			for _, timing := range []string{"once", "cron"} {
				message := "  Hello \n world  "
				in := Input{Name: &name, Timezone: &tz, Message: &message}
				if timing == "once" {
					at := " 2026-09-02T12:00:00.123456+02:00 "
					in.At = &at
				} else {
					cron := "  @daily  "
					in.Cron = &cron
				}
				canonical, err := s.Prepare(in)
				if err != nil {
					t.Fatal(err)
				}
				wantName := "Hello" // trimmed first line of the normalized message
				if strings.TrimSpace(name) != "" {
					wantName = strings.TrimSpace(name)
					if len(wantName) > maxNameChars {
						wantName = wantName[:maxNameChars-1] + "…"
					}
				}
				if *canonical.Name != wantName || *canonical.Timezone != "UTC" || *canonical.Message != "Hello \n world" || *canonical.ThreadMode != "new" || *canonical.MissedPolicy != "run_once" || *canonical.Paused {
					t.Fatalf("unexpected canonical values: %+v", canonical)
				}
				if timing == "once" && (canonical.Cron != nil || *canonical.At != "2026-09-02T10:00:00.123Z") {
					t.Fatalf("at representation: %+v", canonical)
				}
				if timing == "cron" && (canonical.At != nil || *canonical.Cron != "@daily") {
					t.Fatalf("cron representation: %+v", canonical)
				}
				again, err := s.Prepare(canonical)
				if err != nil || !reflect.DeepEqual(canonical, again) {
					t.Fatalf("canonical preparation is not idempotent: %+v %+v %v", canonical, again, err)
				}
			}
		}
	}
}

func TestPrepareRejectsBothTimingFieldsBeforeApply(t *testing.T) {
	s := New(nil, nil, nil, nil)
	defer s.Close()
	at, cron, message := "2026-09-02T12:00:00Z", "@daily", "Hello"
	if _, err := s.Prepare(Input{At: &at, Cron: &cron, Message: &message}); err == nil || !strings.Contains(err.Error(), "not both") {
		t.Fatalf("both timings accepted: %v", err)
	}
	d := draft{message: "Unchanged"}
	if err := s.apply(&d, Input{At: &at, Cron: &cron, Message: &message}); err == nil || d.message != "Unchanged" {
		t.Fatal("conflict did not fail before applying changes")
	}
}
