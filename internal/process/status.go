package process

import "fmt"

// ExitStatusError contains the actual native Windows status. It deliberately is
// not an exec.ExitError: Windows does not use exec.Cmd.Start/Wait or fabricate
// ProcessState. The type is portable so callers can inspect it on any platform;
// Unix continues to return the unmodified cmd.Wait error instead.
type ExitStatusError struct{ Code uint32 }

func (e *ExitStatusError) Error() string { return fmt.Sprintf("process exited with status %d", e.Code) }
