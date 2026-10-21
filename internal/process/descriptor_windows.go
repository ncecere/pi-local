//go:build windows

package process

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

type nativeDescriptor struct {
	app, argv, dir *uint16
	env            []uint16
}

// Cmd is only a descriptor on Windows. Private Cmd.{Stdin,Stdout,Stderr}Pipe
// ownership is not supported: use NewInputPipe/NewOutputPipe or caller-owned
// files/readers/writers. Callers must not subsequently call Cmd.Start/Wait/Run.
func windowsDescriptor(cmd *exec.Cmd) (*nativeDescriptor, error) {
	if cmd == nil {
		return nil, errors.New("process: nil command")
	}
	if cmd.Err != nil {
		return nil, cmd.Err
	}
	if cmd.Process != nil || cmd.ProcessState != nil {
		return nil, errors.New("process: command already started")
	}
	if cmd.Cancel != nil {
		return nil, errors.New("process: use exec.Command, not CommandContext")
	}
	if cmd.SysProcAttr != nil {
		return nil, errors.New("process: native job launcher does not support SysProcAttr")
	}
	if len(cmd.ExtraFiles) != 0 {
		return nil, errors.New("process: ExtraFiles unsupported")
	}
	if cmd.Path == "" {
		return nil, errors.New("process: empty application path")
	}
	dir := cmd.Dir
	if dir == "" {
		var err error
		dir, err = os.Getwd()
		if err != nil {
			return nil, err
		}
	}
	dir, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	app := cmd.Path
	if !filepath.IsAbs(app) {
		if filepath.VolumeName(app) != "" {
			return nil, errors.New("process: drive-relative application paths are unsupported")
		}
		if strings.HasPrefix(app, `\`) || strings.HasPrefix(app, "/") {
			app = filepath.VolumeName(dir) + app
		} else {
			app = filepath.Join(dir, app)
		}
	}
	app, err = filepath.Abs(app)
	if err != nil {
		return nil, err
	}
	// Resolve extensionless absolute paths without any PATH search. Go caches
	// this privately in exec.Cmd; lpApplicationName must receive our own fully
	// resolved name. A resolved batch file is still rejected below.
	app, err = exec.LookPath(app)
	if err != nil {
		return nil, err
	}
	switch strings.ToLower(filepath.Ext(app)) {
	case ".bat", ".cmd":
		return nil, errors.New("process: shell scripts require an explicit interpreter")
	}
	args := cmd.Args
	if len(args) == 0 {
		args = []string{app}
	}
	// ComposeCommandLine's special argv[0] convention strips quotes. Refuse that
	// lossy case rather than executing a command different from the descriptor.
	if strings.ContainsAny(args[0], "\"\x00") {
		return nil, errors.New("process: invalid argv[0]")
	}
	for _, arg := range args {
		if strings.ContainsRune(arg, 0) {
			return nil, errors.New("process: argument contains NUL")
		}
	}
	d := &nativeDescriptor{}
	if d.app, err = windows.UTF16PtrFromString(app); err != nil {
		return nil, err
	}
	if d.dir, err = windows.UTF16PtrFromString(dir); err != nil {
		return nil, err
	}
	// Same documented CommandLineToArgvW escaping as Go exec/syscall. Shell
	// interpreters have their own language and are never inserted implicitly.
	if d.argv, err = windows.UTF16PtrFromString(windows.ComposeCommandLine(args)); err != nil {
		return nil, err
	}
	env := cmd.Env
	if env == nil {
		env = os.Environ()
	}
	values := make(map[string]string, len(env)+1)
	for _, kv := range env {
		if strings.ContainsRune(kv, 0) {
			return nil, errors.New("process: environment contains NUL")
		}
		i := strings.IndexByte(kv, '=')
		if i == 0 {
			if j := strings.IndexByte(kv[1:], '='); j >= 0 {
				i = j + 1
			}
		}
		if i <= 0 {
			return nil, errors.New("process: environment entry must have a key and value")
		}
		values[strings.ToUpper(kv[:i])] = kv // Windows environment keys ignore case; last wins.
	}
	if _, ok := values["SYSTEMROOT"]; !ok {
		values["SYSTEMROOT"] = "SystemRoot=" + os.Getenv("SystemRoot")
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		d.env = append(d.env, utf16.Encode([]rune(values[key]))...)
		d.env = append(d.env, 0)
	}
	d.env = append(d.env, 0) // double-NUL terminated even for an explicit empty env
	return d, nil
}
