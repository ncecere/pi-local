package supervisor

import (
	"testing"
	"time"
)

func TestJudge(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	ago := func(d time.Duration) int64 { return now.Add(-d).UnixMilli() }
	bg := func(tasks int, started *int64) *struct {
		Tasks           int    `json:"tasks"`
		OldestStartedAt *int64 `json:"oldestStartedAt"`
	} {
		return &struct {
			Tasks           int    `json:"tasks"`
			OldestStartedAt *int64 `json:"oldestStartedAt"`
		}{tasks, started}
	}
	recent, old := ago(time.Minute), ago(3*time.Hour)
	cases := []struct {
		name string
		st   RuntimeStatus
		want verdict
	}{
		{"idle long enough", RuntimeStatus{LastActivityAt: ago(time.Hour)}, hibernate},
		{"recently active", RuntimeStatus{LastActivityAt: ago(time.Minute)}, keepAwake},
		{"a reply in progress", RuntimeStatus{BusyThreads: 1, LastActivityAt: ago(time.Hour)}, keepAwake},
		{"someone watching", RuntimeStatus{OpenStreams: 1, LastActivityAt: ago(time.Hour)}, keepAwake},
		{"only waiting for a person", RuntimeStatus{WaitingThreads: 1, LastActivityAt: ago(time.Hour)}, hibernate},
		{"background work under the ceiling", RuntimeStatus{BackgroundWork: bg(1, &recent), LastActivityAt: ago(time.Hour)}, keepAwake},
		{"background work over the ceiling", RuntimeStatus{BackgroundWork: bg(1, &old), LastActivityAt: ago(time.Hour)}, abortBackgroundThenHibernate},
	}
	for _, c := range cases {
		if got := judge(c.st, now, 10*time.Minute, 2*time.Hour); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
