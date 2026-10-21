# Agent update durability

`Update` and `UpdatePrepared` serialize on the store's write mutex. A prepared
update's expected revision is checked before callbacks or live file writes. The
config bytes, new revision, and builder receipt/first schedule commit in one
SQLite transaction. There is no precommit replacement of `agent.yaml`, and no
filesystem rollback to perform if that transaction fails.

Migration `00015_agent_config_materializations.sql` adds the pending config table.
After commit, the store writes a same-directory temporary file, syncs it, closes
it, renames it over `agent.yaml`, and syncs the containing directory. Only then
does it delete the pending config row. Startup resolves all pending writes before
loading any agents; a recovery failure stops opening the store rather than
silently skipping the agent. The pending row's revision must equal the committed
agent revision. Recovery and already-completed builder retries are idempotent.

If postcommit materialization fails, the new config remains committed in SQLite
and in the live store's memory. The error explicitly says the change was saved
and materialization is pending. Do not claim rollback or resubmit a new proposal;
repair the filesystem and reopen, or replay the same durable builder request.
If Commit/Rollback itself errors, the outcome is reported as uncertain rather
than claiming nothing was saved. Rollback errors are preserved.

## Crash boundaries covered by tests

A subprocess exits without defers/DB close after recording the pending config
but before related writes, immediately before commit, immediately after commit,
and after file materialization but before clearing the pending row. Reopening
must recover either the entire old state or the entire new committed state,
including related transaction writes. Other tests cover filesystem failure,
failed recovery, post-write failure, SQLite rollback failure, stale approval
without even replacing the file's inode, and builder replay without duplicate
schedules or revisions. All data is temporary; app fixtures use memory secrets.

## Durability limits

- app.db uses WAL with `synchronous=FULL`, not NORMAL, because SQLite's commit
  must be durable before the external file is replaced. This increases write
  synchronization cost for all app.db writers.
- Tests exercise process termination and injected I/O/transaction failures on
  macOS, not actual power cuts, every filesystem, or Windows. They cannot prove
  storage hardware/driver cache behavior. Go's file/directory `Sync` and SQLite's
  FULL sync are used; macOS `F_FULLFSYNC` / SQLite `fullfsync` are not enabled.
- On Windows Go cannot sync directories. File Sync/replacement and the SQLite
  pending record protect process-crash recovery, but directory-entry durability
  after power loss is not guaranteed there. Other platforms surface directory
  sync errors instead of clearing the recovery record.
- These guarantees cover updates through this store, not concurrent app
  processes sharing a data directory, external YAML edits while the app is
  running, database/storage corruption, or the older creation/import/deletion
  filesystem lifecycles. A crash during recovery may leave harmless temporary
  files; the pending row is replayed until materialization succeeds.
- An old pending builder schedule prepared before canonical preparation may
  now be refused rather than silently changed on approval. Prepare a new request
  so the human can approve the actual defaults and normalized values.
