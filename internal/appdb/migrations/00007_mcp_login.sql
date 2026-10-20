-- +goose Up

-- A local (stdio) server's own sign-in command: the arguments to run its command with (JSON array; NULL: none). The
-- app runs it on request (the server's Sign in button) and shows its output.
ALTER TABLE mcp_servers ADD COLUMN login_args TEXT;

-- +goose Down
ALTER TABLE mcp_servers DROP COLUMN login_args;
