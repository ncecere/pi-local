package linuxsandbox

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// Portable decoding tests use only injected numeric records. The native C
// diagnostic is enabled solely for standalone controls, not PID-1 probes.
type execAuthorityFDDiagnostic struct {
	stage, fd, flags, fileType uint64
	statResult                 int64
}

func decodeExecAuthorityFDDiagnostic(data []byte) (execAuthorityFDDiagnostic, error) {
	invalid := errors.New("invalid bounded FD diagnostic")
	if len(data) != 48 || binary.LittleEndian.Uint64(data[:8]) != 0x3144464145 {
		return execAuthorityFDDiagnostic{}, invalid
	}
	d := execAuthorityFDDiagnostic{
		stage:      binary.LittleEndian.Uint64(data[8:16]),
		fd:         binary.LittleEndian.Uint64(data[16:24]),
		flags:      binary.LittleEndian.Uint64(data[24:32]),
		fileType:   binary.LittleEndian.Uint64(data[32:40]),
		statResult: int64(binary.LittleEndian.Uint64(data[40:48])),
	}
	if (d.stage != 1 && d.stage != 2) || d.fd < 3 || d.fd > 2147483647 ||
		d.flags > 0x7fffffffffffffff || d.fileType & ^uint64(0170000) != 0 ||
		d.statResult > 0 || d.statResult < -4095 || (d.statResult != 0 && d.fileType != 0) {
		return execAuthorityFDDiagnostic{}, invalid
	}
	return d, nil
}

func (d execAuthorityFDDiagnostic) summary(err error) string {
	if err != nil {
		return "FD diagnostic unavailable or invalid"
	}
	stage := "initial"
	if d.stage == 2 {
		stage = "proc-self-fd"
	}
	return fmt.Sprintf("stage=%s fd=%d F_GETFD=%d type=%#o fstat=%d",
		stage, d.fd, d.flags, d.fileType, d.statResult)
}

func TestExecAuthorityFDDiagnosticInjected(t *testing.T) {
	record := func(words ...uint64) []byte {
		data := make([]byte, 8*len(words))
		for i, word := range words {
			binary.LittleEndian.PutUint64(data[i*8:], word)
		}
		return data
	}
	for _, tc := range []struct {
		name, want string
		data       []byte
	}{
		{"initial", "stage=initial fd=3 F_GETFD=0 type=020000 fstat=0", record(0x3144464145, 1, 3, 0, 0020000, 0)},
		{"above-limit", "stage=proc-self-fd fd=100 F_GETFD=0 type=020000 fstat=0", record(0x3144464145, 2, 100, 0, 0020000, 0)},
		{"ambient-pipe", "stage=initial fd=142 F_GETFD=0 type=010000 fstat=0", record(0x3144464145, 1, 142, 0, 0010000, 0)},
		{"stat-failure", "stage=initial fd=4 F_GETFD=1 type=0 fstat=-9", record(0x3144464145, 1, 4, 1, 0, ^uint64(8))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, err := decodeExecAuthorityFDDiagnostic(tc.data)
			if err != nil || d.summary(err) != tc.want {
				t.Fatalf("numeric summary mismatch: %s", d.summary(err))
			}
		})
	}
	valid := record(0x3144464145, 1, 3, 0, 0020000, 0)
	invalid := [][]byte{nil, valid[:47], append(append([]byte{}, valid...), 0), []byte("not-a-path-to-log")}
	for _, replacement := range []struct {
		word  int
		value uint64
	}{
		{0, 0}, {1, 3}, {2, 2}, {2, 2147483648}, {3, ^uint64(0)},
		{4, 0020001}, {5, 1}, {5, ^uint64(4095)}, {5, ^uint64(8)},
	} {
		data := append([]byte{}, valid...)
		binary.LittleEndian.PutUint64(data[replacement.word*8:], replacement.value)
		invalid = append(invalid, data)
	}
	for i, data := range invalid {
		d, err := decodeExecAuthorityFDDiagnostic(data)
		if err == nil || !strings.Contains(d.summary(err), "unavailable or invalid") {
			t.Fatalf("malformed injected record %d was accepted", i)
		}
	}
}
