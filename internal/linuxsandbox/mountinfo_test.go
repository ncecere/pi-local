package linuxsandbox

import (
	"strings"
	"testing"
)

func safeMounts(h handoff) []mount {
	out := []mount{{Point: "/", FSType: "tmpfs", Options: map[string]bool{"ro": true, "nosuid": true, "nodev": true}}, {Point: "/proc", FSType: "proc", Options: map[string]bool{"ro": true, "nosuid": true, "nodev": true, "noexec": true}}}
	for _, p := range []string{"/tmp", "/run", "/dev", "/dev/pts"} {
		fs := "tmpfs"
		if p == "/dev/pts" {
			fs = "devpts"
		}
		out = append(out, mount{Point: p, FSType: fs, Options: map[string]bool{"rw": true, "nosuid": true, "nodev": true}})
	}
	for _, b := range h.Bindings {
		opts := map[string]bool{"nosuid": true, "nodev": true}
		if b.Writable {
			opts["rw"] = true
		} else {
			opts["ro"] = true
		}
		out = append(out, mount{Point: b.Dest, FSType: "ext4", Options: opts})
	}
	return out
}
func TestMountTopology(t *testing.T) {
	h := fixtureHandoff()
	if err := verifyMounts(safeMounts(h), h.Bindings); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func([]mount) []mount{
		"descendant": func(m []mount) []mount {
			return append(m, mount{Point: h.Policy.Workspace + "/nested", FSType: "ext4"})
		},
		"propagation":  func(m []mount) []mount { m[len(m)-1].Optional = []string{"master:1"}; return m },
		"writeSystem":  func(m []mount) []mount { m[6].Options["ro"] = false; return m },
		"devices":      func(m []mount) []mount { m[len(m)-1].Options["nodev"] = false; return m },
		"stacked":      func(m []mount) []mount { return append(m, m[len(m)-1]) },
		"hostSys":      func(m []mount) []mount { return append(m, mount{Point: "/sys", FSType: "sysfs"}) },
		"hostRoot":     func(m []mount) []mount { m[0].FSType = "ext4"; return m },
		"writableProc": func(m []mount) []mount { m[1].Options["ro"] = false; return m },
	} {
		t.Run(name, func(t *testing.T) {
			if verifyMounts(change(safeMounts(h)), h.Bindings) == nil {
				t.Fatal("unsafe mounts accepted")
			}
		})
	}
}
func TestMountinfoParser(t *testing.T) {
	text := "1 0 0:1 / / rw,nosuid,nodev - tmpfs tmpfs rw\n2 1 8:1 /source /tmp/a\\040b rw,nosuid,nodev master:5 - ext4 /dev/sda rw\n"
	m, err := parseMounts(strings.NewReader(text))
	if err != nil {
		t.Fatal(err)
	}
	if m[1].Point != "/tmp/a b" || m[1].Optional[0] != "master:5" || m[0].FSType != "tmpfs" {
		t.Fatal("incorrect mount parse")
	}
	if err := noDescendantMounts(m, "/tmp"); err == nil {
		t.Fatal("descendant mount accepted")
	}
	for _, bad := range []string{"", "bad", "1 0 0:1 / /bad\\00 rw - tmpfs tmpfs rw\n", strings.Repeat("x", 65537)} {
		if _, err := parseMounts(strings.NewReader(bad)); err == nil {
			t.Fatal("bad mountinfo accepted")
		}
	}
}
