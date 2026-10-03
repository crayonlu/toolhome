# ToolHome v0.6.0

ToolHome can now hold MCP servers that must run on the machine using them, not on the ToolHome host. A local Chrome, a local Ghidra bridge or a local Python tool is defined once in ToolHome and reaches every MCP client through one command line.

- New `node` placement: a server runs as a stdio process on a client machine, identified by a `nodeId` label (`remote` and `home` placements are unchanged).
- `toolhome mcp stdio` fronts every server placed on the machine over one stdio connection: tools are namespaced `slug.tool`, children spawn lazily per call, capability discovery happens once per server, and children are disconnected when the client goes away. `toolhome mcp launch <slug>` remains the per-server form with original names.
- `toolhome mcp launch <slug>` spawns such a server with its stored credential and hands over this process's stdio, so the client talks to the real process with its original tool names and extension semantics. `TOOLHOME_*` variables are withheld from the child.
- New admin-only read endpoint `GET /api/v1/servers/{id}/runtime` returns a stdio server's transport plus its credential values projected into environment variables. Every read is audited with the variable names and never the values.
- Restart now applies to every stdio server rather than home-hosted ones only, so a process that dies on a client machine is restarted.
- Config import classifies a `command` entry by placement instead of assuming the ToolHome host.

## Upgrade

Requires Node.js 24+ for the management CLI: `npm install -g toolhome@0.6.3`. 0.6.3 adds `toolhome node status` — the local health report for node-hosted servers (runtime state, capability counts from the last discovery, call counts, launch-command probe), with `--check` reconnecting to each enabled server in parallel to refresh capabilities.

Use 0.6.2 or later from npm: the 0.6.0 tarball was published from a partial tree (no CLI fixes), and 0.6.1 was published before `toolhome mcp stdio` and the child-process reap landed.

Server image: `ghcr.io/crayonlu/toolhome:v0.6.0`. Existing `servers` rows migrate in place: the table is rebuilt to admit the new kind and carry `node_id`, with foreign keys disabled during the rebuild so runtime state, capability snapshots and tool projections survive.

No environment or key changes. The runtime endpoint requires an admin control key; agent-scoped keys are rejected with 403.

### Fixed

- A ToolHome host no longer treats node-hosted servers as its own: it does not connect or spawn them, and readiness (`/readyz`, `toolhome doctor`) no longer goes degraded because of a server that is meant to run on a client machine. `refresh` and `test` on such a server answer `409 server_not_hosted_here` instead. Without this, a node-hosted server placed on a Mac made the server report `unreachable` from its Linux host and turned `/readyz` red.
- `toolhome events`, `calls list`, `calls stats`, `api`, `config export` and `config import-harness` failed with "command.opts is not a function". Commander passes the parsed options object before the Command, so the parameter those actions treated as the Command was the options object. This affected every release before 0.6.1.

## Validation

Server typecheck and 169 tests; web typecheck and 31 tests; production builds; Market installation and execution coverage. The launcher is verified end to end against a live server: register a node-placed stdio server, then `toolhome mcp launch <slug>` completes an MCP handshake, lists the server's original tool names and round-trips a tool call.
