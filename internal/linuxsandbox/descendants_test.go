package linuxsandbox

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// fixtureDescendants reads every task's children, not just the thread-group
// leader. Limits are refusal bounds, never silent truncation. A disappeared
// children file is accepted only after confirming that task/process is gone;
// disappearing tasks force a fresh task listing to catch reparented children.
func fixtureDescendants(proc string, root int) ([]int, error) {
	var out []int
	queue := []int{root}
	seen := map[int]bool{root: true}
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		process := filepath.Join(proc, strconv.Itoa(pid))
		stable := false
		for attempt := 0; attempt < 3; attempt++ {
			tasks, err := os.ReadDir(filepath.Join(process, "task"))
			if err != nil {
				if os.IsNotExist(err) && fixturePathGone(process) {
					stable = true
					break
				}
				return nil, fmt.Errorf("fixture task listing failed")
			}
			if len(tasks) == 0 || len(tasks) > 256 {
				return nil, fmt.Errorf("unexpected fixture task count")
			}
			raced := false
			for _, task := range tasks {
				if n, err := strconv.Atoi(task.Name()); err != nil || n <= 0 || !task.IsDir() {
					return nil, fmt.Errorf("unexpected fixture task")
				}
				taskPath := filepath.Join(process, "task", task.Name())
				raw, err := os.ReadFile(filepath.Join(taskPath, "children"))
				if err != nil {
					if os.IsNotExist(err) && (fixturePathGone(taskPath) || fixturePathGone(process)) {
						raced = true
						continue
					}
					return nil, fmt.Errorf("fixture children read failed")
				}
				if len(raw) > 4096 {
					return nil, fmt.Errorf("fixture children list too large")
				}
				for _, s := range strings.Fields(string(raw)) {
					n, err := strconv.Atoi(s)
					if err != nil || n <= 1 || n == root {
						return nil, fmt.Errorf("unexpected fixture descendant")
					}
					if seen[n] {
						continue // shared lists and reparenting can repeat a PID
					}
					seen[n] = true
					out = append(out, n)
					queue = append(queue, n)
					if len(out) > 32 {
						return nil, fmt.Errorf("fixture tree too large")
					}
				}
			}
			if !raced {
				stable = true
				break
			}
		}
		if !stable {
			return nil, fmt.Errorf("fixture task tree did not stabilize")
		}
	}
	return out, nil
}

func fixturePathGone(path string) bool {
	_, err := os.Stat(path)
	return os.IsNotExist(err)
}

func TestFixtureDescendantsIncludesNonLeaderChildrenAndDeduplicates(t *testing.T) {
	proc := t.TempDir()
	write := func(pid, tid int, children string) {
		t.Helper()
		dir := filepath.Join(proc, strconv.Itoa(pid), "task", strconv.Itoa(tid))
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "children"), []byte(children), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(100, 100, "101")
	write(100, 110, "102 101") // child created by non-leader OS thread
	write(101, 101, "")
	write(102, 102, "103")
	write(103, 103, "")
	got, err := fixtureDescendants(proc, 100)
	sort.Ints(got)
	if err != nil || fmt.Sprint(got) != "[101 102 103]" {
		t.Fatalf("non-leader tree: %v, %v", got, err)
	}
}

func TestFixtureDescendantsDoesNotIgnoreMissingChildrenOfLiveTask(t *testing.T) {
	proc := t.TempDir()
	if err := os.MkdirAll(filepath.Join(proc, "100/task/100"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := fixtureDescendants(proc, 100); err == nil {
		t.Fatal("missing children file of a live task was silently dropped")
	}
}

func TestFixtureDescendantsRetainsObservedGoneChildren(t *testing.T) {
	proc := t.TempDir()
	dir := filepath.Join(proc, "100/task/100")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "children"), []byte("101"), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := fixtureDescendants(proc, 100)
	if err != nil || fmt.Sprint(got) != "[101]" {
		t.Fatalf("observed exited child was lost: %v %v", got, err)
	}
}

func TestFixtureDescendantsRefusesOversizedTree(t *testing.T) {
	proc := t.TempDir()
	dir := filepath.Join(proc, "100/task/100")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	var children []string
	for i := 101; i <= 133; i++ {
		children = append(children, strconv.Itoa(i))
	}
	if err := os.WriteFile(filepath.Join(dir, "children"), []byte(strings.Join(children, " ")), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := fixtureDescendants(proc, 100); err == nil {
		t.Fatal("oversized tree accepted")
	}
}
