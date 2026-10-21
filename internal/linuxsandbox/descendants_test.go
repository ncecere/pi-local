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

// Two complete bounded inventories must agree, including task identities and
// child edges, not merely the final PID set. Successful reads can race task exit
// and reparenting too. Refuse instability rather than trusting a partial tree.
// This is bounded revalidation, not an atomic proc snapshot; fixture readiness
// must also precede collection. No authority is inferred from arbitrary host PIDs.
func fixtureDescendants(proc string, root int) ([]int, error) {
	return fixtureDescendantsRead(proc, root, os.ReadFile)
}

func fixtureDescendantsRead(proc string, root int, read func(string) ([]byte, error)) ([]int, error) {
	inventory := func() ([]int, string, error) {
		var out, queue []int
		queue = append(queue, root)
		seen := map[int]bool{root: true}
		var records []string
		for len(queue) > 0 {
			pid := queue[0]
			queue = queue[1:]
			process := filepath.Join(proc, strconv.Itoa(pid))
			taskDir := filepath.Join(process, "task")
			tasks, err := os.ReadDir(taskDir)
			if err != nil {
				if os.IsNotExist(err) && fixturePathGone(process) {
					records = append(records, fmt.Sprintf("%d:gone", pid))
					continue
				}
				return nil, "", fmt.Errorf("fixture task listing failed")
			}
			if len(tasks) == 0 || len(tasks) > 256 {
				return nil, "", fmt.Errorf("unexpected fixture task count")
			}
			var names []string
			for _, task := range tasks {
				if n, err := strconv.Atoi(task.Name()); err != nil || n <= 0 || !task.IsDir() {
					return nil, "", fmt.Errorf("unexpected fixture task")
				}
				names = append(names, task.Name())
				raw, err := read(filepath.Join(taskDir, task.Name(), "children"))
				if err != nil {
					return nil, "", fmt.Errorf("fixture children read failed or raced")
				}
				if len(raw) > 4096 {
					return nil, "", fmt.Errorf("fixture children list too large")
				}
				var children []int
				for _, text := range strings.Fields(string(raw)) {
					n, err := strconv.Atoi(text)
					if err != nil || n <= 1 || n == root {
						return nil, "", fmt.Errorf("unexpected fixture descendant")
					}
					children = append(children, n)
					if seen[n] {
						continue
					}
					seen[n] = true
					out = append(out, n)
					queue = append(queue, n)
					if len(out) > 32 {
						return nil, "", fmt.Errorf("fixture tree too large")
					}
				}
				sort.Ints(children)
				records = append(records, fmt.Sprintf("%d/%s:%v", pid, task.Name(), children))
			}
			// Re-list even after every read succeeded. A departing worker may have
			// reparented a child to a task whose children file we already read.
			after, err := os.ReadDir(taskDir)
			if err != nil || len(after) != len(names) {
				return nil, "", fmt.Errorf("fixture task inventory changed")
			}
			for i, task := range after {
				if task.Name() != names[i] || !task.IsDir() {
					return nil, "", fmt.Errorf("fixture task inventory changed")
				}
			}
		}
		sort.Strings(records)
		sort.Ints(out)
		return out, strings.Join(records, "\n"), nil
	}
	out, first, err := inventory()
	if err != nil {
		return nil, err
	}
	_, second, err := inventory()
	if err != nil {
		return nil, err
	}
	if first != second {
		return nil, fmt.Errorf("fixture tree did not stabilize across complete inventories")
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

func TestFixtureDescendantsRefusesWorkerExitAfterSuccessfulRead(t *testing.T) {
	proc := t.TempDir()
	writeFixtureChildren(t, proc, 100, 100, "")
	writeFixtureChildren(t, proc, 100, 110, "")
	injected := false
	_, err := fixtureDescendantsRead(proc, 100, func(path string) ([]byte, error) {
		raw, err := os.ReadFile(path)
		if err == nil && strings.HasSuffix(path, "/100/task/110/children") && !injected {
			injected = true
			// Worker spawns 102 AFTER its successful empty read, then exits. The
			// child reparents to the leader, whose successful read already happened.
			writeFixtureChildren(t, proc, 102, 102, "")
			writeFixtureChildren(t, proc, 100, 100, "102")
			if err := os.RemoveAll(filepath.Join(proc, "100/task/110")); err != nil {
				t.Fatal(err)
			}
		}
		return raw, err
	})
	if !injected || err == nil {
		t.Fatalf("successful-read exit/reparent race accepted: injected=%v err=%v", injected, err)
	}
}

func TestFixtureDescendantsRevalidatesPreviouslyReadProcesses(t *testing.T) {
	proc := t.TempDir()
	writeFixtureChildren(t, proc, 100, 100, "101")
	writeFixtureChildren(t, proc, 101, 101, "")
	injected := false
	_, err := fixtureDescendantsRead(proc, 100, func(path string) ([]byte, error) {
		raw, err := os.ReadFile(path)
		if err == nil && strings.HasSuffix(path, "/101/task/101/children") && !injected {
			injected = true
			writeFixtureChildren(t, proc, 102, 102, "")
			writeFixtureChildren(t, proc, 100, 100, "101 102")
		}
		return raw, err
	})
	if !injected || err == nil {
		t.Fatalf("late child creation accepted: injected=%v err=%v", injected, err)
	}
}

func writeFixtureChildren(t *testing.T, proc string, pid, tid int, children string) {
	t.Helper()
	dir := filepath.Join(proc, strconv.Itoa(pid), "task", strconv.Itoa(tid))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "children"), []byte(children), 0600); err != nil {
		t.Fatal(err)
	}
}
