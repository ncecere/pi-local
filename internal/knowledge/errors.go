package knowledge

import "net/http"

// Error is a refusal for the model or the person.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// ErrNoFolders: the agent has no knowledge folders.
var ErrNoFolders = &Error{Status: http.StatusConflict, Code: "no_folders", Message: "This agent has no knowledge folders yet: the person adds them in its Knowledge tab. Tell them, and answer without the documents only if they say to."}
