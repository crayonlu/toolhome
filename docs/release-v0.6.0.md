# ToolHome v0.6.0

ToolHome can now hold MCP servers that must run on the machine using them, not on the ToolHome host. A local Chrome, a local Ghidra bridge or a local Python tool is defined once in ToolHome and reaches every MCP client through one command line.

- New `node` placement: a server runs as a stdio process on a client machine, identified by a `nodeId` label (`remote` and `home` placements are unchanged).
- `toolhome mcp launch <slug>` spawns such a server with its stored credential and hands over this process's stdio, so the client talks to the real process with its original tool names and extension semantics. `TOOLHOME_*` variables are withheld from the child.
- New admin-only read endpoint `GET /api/v1/servers/{id}/runtime` returns a stdio server's transport plus its credential values projected into environment variables. Every read is audited with the variable names and never the values.
- Restart now applies to every stdio server rather than home-hosted ones only, so a process that dies on a client machine is restarted.
- Config import classifies a `command` entry by placement instead of assuming the ToolHome host.

## Upgrade

Requires Node.js 24+ for the management CLI: `npm install -g toolhome@0.6.1`.

Use 0.6.1 or later from npm. The 0.6.0 tarball was published from a partial tree and still carries the CLI option-parsing bug described below; 0.6.1 is the first complete build of this release.

Server image: `ghcr.io/crayonlu/toolhome:v0.6.0`. Existing `servers` rows migrate in place: the table is rebuilt to admit the new kind and carry `node_id`, with foreign keys disabled during the rebuild so runtime state, capability snapshots and tool projections survive.

No environment or key changes. The runtime endpoint requires an admin control key; agent-scoped keys are rejected with 403.

### Fixed

- `toolhome events`, `calls list`, `calls stats`, `api`, `config export` and `config import-harness` failed with "command.opts is not a function". Commander passes the parsed options object before the Command, so the parameter those actions treated as the Command was the options object. This affected every release before 0.6.1.

## Validation

Server typecheck and 169 tests; web typecheck and 31 tests; production builds; Market installation and execution coverage. The launcher is verified end to end against a live server: register a node-placed stdio server, then `toolhome mcp launch <slug>` completes an MCP handshake, lists the server's original tool names and round-trips a tool call.
