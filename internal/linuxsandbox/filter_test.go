package linuxsandbox

import "testing"

func evaluate(t *testing.T, arch, nr uint32, args ...uint64) uint32 {
	t.Helper()
	data := map[uint32]uint32{0: nr, 4: arch}
	for i, a := range args {
		data[16+uint32(i)*8] = uint32(a)
		data[20+uint32(i)*8] = uint32(a >> 32)
	}
	program := Filter()
	var acc uint32
	for pc, steps := 0, 0; pc < len(program) && steps < 4096; steps++ {
		v := program[pc]
		pc++
		switch v.Code {
		case bpfLD:
			acc = data[v.K]
		case bpfAND:
			acc &= v.K
		case bpfJEQ:
			if acc == v.K {
				pc += int(v.JT)
			} else {
				pc += int(v.JF)
			}
		case bpfJSET:
			if acc&v.K != 0 {
				pc += int(v.JT)
			} else {
				pc += int(v.JF)
			}
		case bpfRET:
			return v.K
		default:
			t.Fatal("unknown filter instruction")
		}
	}
	t.Fatal("filter fell through or looped")
	return 0
}
func TestFilterABIAndDefaultDeny(t *testing.T) {
	for _, arch := range []uint32{0x40000003, 0xc00000b7, 0, 0x4000003e} {
		if got := evaluate(t, arch, 0); got != killABI {
			t.Fatalf("ABI %x allowed", arch)
		}
	}
	if evaluate(t, 0xc000003e, 0x40000000) != killABI {
		t.Fatal("x32 allowed")
	}
	for _, nr := range []uint32{41, 42, 43, 44, 45, 46, 47, 49, 50, 54, 55, 64, 65, 66, 67, 68, 69, 70, 71, 101, 153, 154, 155, 161, 165, 166, 167, 169, 175, 176, 220, 248, 249, 250, 259, 272, 298, 300, 303, 304, 308, 310, 311, 312, 313, 317, 321, 323, 425, 426, 427, 428, 429, 430, 431, 432, 433, 435, 438, 442, 9999} {
		if got := evaluate(t, 0xc000003e, nr); got != deny {
			t.Fatalf("dangerous/unknown syscall %d returned %x", nr, got)
		}
	}
	seen := map[uint32]bool{}
	for _, n := range localSyscalls {
		if seen[n] {
			t.Fatalf("duplicate syscall %d", n)
		}
		seen[n] = true
		if got := evaluate(t, 0xc000003e, n); got != allow {
			t.Fatalf("allowlisted syscall %d denied", n)
		}
	}
	if len(Filter()) > 4096 {
		t.Fatal("filter too large")
	}
}
func TestFilterClone(t *testing.T) {
	for _, flags := range []uint64{17, 0x100 | 0x200 | 0x400 | 0x800 | 0x10000 | 0x80000 | 0x100000 | 0x200000} {
		if evaluate(t, 0xc000003e, 56, flags) != allow {
			t.Fatal("ordinary fork/thread clone blocked")
		}
	}
	for _, flag := range []uint64{0x80, 0x2000, 0x20000, 0x800000, 0x2000000, 0x4000000, 0x8000000, 0x10000000, 0x20000000, 0x40000000, 1 << 32} {
		if evaluate(t, 0xc000003e, 56, flag|17) != deny {
			t.Fatalf("clone flags %x allowed", flag)
		}
	}
	if evaluate(t, 0xc000003e, 435) != deny {
		t.Fatal("uncertified clone3 fallback enabled")
	}
}
func TestFilterLocalSocketpairAndIoctl(t *testing.T) {
	for _, typ := range []uint64{1, 1 | 0x800, 1 | 0x80000, 1 | 0x800 | 0x80000} {
		if evaluate(t, 0xc000003e, 53, 1, typ, 0) != allow {
			t.Fatal("local stream pair blocked")
		}
	}
	for _, args := range [][]uint64{{2, 1, 0}, {1, 2, 0}, {1, 5, 0}, {1, 1, 1}} {
		if evaluate(t, 0xc000003e, 53, args...) != deny {
			t.Fatal("unreviewed socketpair allowed")
		}
	}
	for _, request := range []uint64{0x5401, 0x5413, 0x541b} {
		if evaluate(t, 0xc000003e, 16, 0, request) != allow {
			t.Fatal("query ioctl blocked")
		}
	}
	for _, request := range []uint64{0x5412, 0x541c, 0x5402, 0x541b + (1 << 32)} {
		if evaluate(t, 0xc000003e, 16, 0, request) != deny {
			t.Fatalf("unsafe ioctl %x allowed", request)
		}
	}
}
