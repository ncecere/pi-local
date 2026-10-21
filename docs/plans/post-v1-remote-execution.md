# After v1.0 readiness: Pi Local remote execution

Status: direction agreed; architecture candidate, not implementation approval before v1.0 readiness. The person
chooses the v1.0 launch. Finish the local-app roadmap first. No PDP source changes are part of the current work.

## Product direction

Pi Local remains the desktop control plane and chat UI. A remote service (an evolved Pi Durable Platform, or a new
project under `~/projects/golang/`) hosts agents that Pi Local can send, run, monitor, interact with and bring back.
Remote agents appear alongside local agents. Team-owned remote agents can be shared with authorized people.

PDP may be changed drastically; backward compatibility with its present architecture is not a constraint by default.
Existing PDP data is not disposable: any actual migration or removal still needs a deliberate plan and backup.

## Storage distinction

Pi Local is not SQL-free: each portable agent directory contains SQLite state. Current PDP instead provisions a
PostgreSQL schema/role per agent. Preserve the portable agent model, not the old per-agent PostgreSQL requirement.
Control-plane relational metadata (users, teams, permissions, execution placement) is a separate concern and may
remain in PostgreSQL without compromising agent portability.

The portable unit includes configuration, agent state/conversations, agent-owned memory, skills and workspace data.
Secrets are separate grants, never silently copied from the desktop Keychain. Local knowledge-folder paths and
macOS-only connections cannot automatically work remotely: explicitly select uploads, replacements or a separately
authorized local bridge. The person's global profile stays local unless explicitly shared.

## celld candidate

Assuming Deno's `denoland/celld`. Source inspected at `90b43017241f81189453d326d05948f388b34652`
(v0.6.2 documentation), with the local PDP checkout at `89418d9`.

What fits:

- A cell is an actor with private SQLite state; one active owner, activation/hibernation, alarms and WebSockets.
- Nodes use an object-storage bucket for durable state, rather than per-agent PostgreSQL schemas.
- `@earendil-works/pi-durable` 1.3.0 already exposes `openDurableObjectSqliteStorage` through
  `@earendil-works/pi-durable/storage/sqlite/cloudflare`, a promising storage-adapter seam.

What has NOT been established:

- That the current Node runtime runs unchanged as a cell. celld uses Workers/Durable Objects-style APIs and partial
  Node compatibility, not a general Node host. Its documented filesystem is request-local `/tmp` and read-only
  `/bundle`; bash, normal workspaces and stdio MCP need another execution environment.
- That an arbitrary local SQLite file can be imported into or exported from a cell byte-for-byte. A shared SQL
  dialect and an existing adapter do not prove migration or snapshot compatibility.
- That container workspaces are durable. celld's experimental container support explicitly describes disk as ephemeral;
  moves/restarts destroy containers, and snapshotDirectory/snapshotContainer are not implemented.
- That celld supplies all PDP functions. Authentication, teams, permissions, ingress/TLS, budgets, approval routing and
  safe secret distribution remain application/control-plane responsibilities. celld is beta; qualify failure behavior.

## Architecture to evaluate

- **Pi Local:** presents local and remote agents through the same interaction protocol; remote location, health,
  connection loss and outstanding approvals are visible.
- **Go control plane:** identity, teams, authorization, agent inventory, placement, deployments, secret grants,
  approval delivery, auditing and quota enforcement. Reuse PDP pieces that fit.
- **Agent state/execution owner:** evaluate a cell per agent using pi-durable's SQLite adapter, or a Node runner with a
  durable per-agent directory. Keep both behind explicit host/storage interfaces until the spike proves a choice.
- **Tool sandbox:** shell/files/browser/stdio MCP execute in isolated containers or VMs, separate from privileged
  control-plane credentials. Use durable volumes or an explicit workspace snapshot/restore protocol; never rely on
  ephemeral container disk as the only copy of an agent.
- **Object storage:** immutable agent-package revisions, workspace snapshots/blobs, and celld's own replication storage
  if selected. Keep application blobs separate from celld's reserved internal namespaces.

## Handoff contract

Begin with move, not bidirectional live sync:

1. Quiesce the local agent, settle/cancel pending work under a documented policy, and checkpoint state.
2. Export a versioned manifest plus state/workspace blobs, verify hashes and compatibility remotely.
3. Bind approved remote credentials and tool capabilities.
4. Transfer ownership using a durable lease/fencing generation. Only one side may write the agent's state.
5. Activate remotely, acknowledge ownership and reconnect event streams by cursor.
6. Reverse the protocol to bring it home. Failed transfers retain a recoverable source copy but must never activate
   both writers. A fork is an explicit new agent identity, not a second writer to the same state.

A disconnected desktop must not strand a remote approval: persist questions and define timeout/cancel behavior.
Model keys are remote secrets, not assumed to be the local machine's keys. A local-only provider (such as Ollama) also
needs an explicit replacement or authorized network path.

## First spike once v1.0-ready

1. Run one basic pi-durable agent against celld's Durable Object SQL interface; test transactions, crash recovery,
   hibernation and alarm wake-up with the required object-store guarantees.
2. Round-trip a real local agent's configuration, conversations, notes and documents; preserve IDs and storage-version
   checks. Establish whether raw snapshots or a logical export format are needed.
3. Run a full Node agent with shell and stdio MCP in an isolated remote sandbox; verify workspace persistence through
   restart and relocation, and compare complexity with the cell-native option.
4. Exercise fenced ownership transfer, interrupted upload, stale desktop, retries, pending approvals and reconnecting
   streams. Inspect latency and durability, not only a happy-path response.
5. Decide whether to refactor PDP or start a new sibling Go project from the results. Do not commit to celld as the
   storage/runtime foundation before these tests pass.

## Sources

- PDP: `~/projects/golang/pi-durable-platform/README.md` (per-agent PostgreSQL schemas and existing launchers).
- [celld overview](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/docs/README.md)
- [Durable Objects interface](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/docs/services/durable-objects.md)
- [Node compatibility](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/docs/cloudflare-compat.md#nodejs-compatibility)
- [Containers and ephemeral disk](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/docs/services/containers.md)
- [Storage and ownership guarantees](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/docs/guarantees.md)
- [Operational limitations](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/docs/limitations.md)
