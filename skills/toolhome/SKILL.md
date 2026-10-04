---
name: toolhome
description: >
  Deploy and manage a self-hosted ToolHome instance: an MCP and Hosted CLI
  control plane that aggregates upstream capabilities and platform CLIs. Use
  when the user wants to set up ToolHome, manage MCP servers or hosted CLIs,
  place MCP servers on a client machine, reuse encrypted credentials, authorize
  OAuth upstreams, install from the Market catalog, configure harnesses (Claude
  Code, Cursor, Codex, Grok), or troubleshoot ToolHome. Covers CLI, web console,
  Docker deployment, and CI/CD.
---

# ToolHome

ToolHome is a single-user, self-hosted control plane for MCP servers and Hosted platform CLIs. Manage upstream MCP servers, CLIs such as Azure `az`, GitHub `gh`, and Tailscale, and encrypted credentials in one place.

## When to Use This Skill

- User wants to deploy or manage the MCP or Hosted CLI plane
- User wants to aggregate multiple MCP servers behind one URL
- User needs an MCP server that must run on the machine using it (a local Chrome, a local Ghidra bridge, a local Python tool) instead of on the ToolHome host
- User wants to run platform CLIs such as Azure `az`, GitHub `gh`, Tailscale, Cloudflare `wrangler`, Vercel, Lark `lark-cli`, Firecrawl, or Aliyun `aliyun` remotely
- User needs to authorize OAuth for MCP upstreams or reuse access tokens in a CLI
- User wants to install MCP servers or hosted CLIs from the Market catalog
- User wants to connect Claude Code, Cursor, Codex, or Grok to a self-hosted MCP gateway
- User is troubleshooting ToolHome (status, OAuth, connectivity)

## Installation

ToolHome has three components. Install what you need:

### 1. Deploy the server (Docker)

```bash
docker run -d \
  --name toolhome \
  -p 3344:3344 \
  -v toolhome-data:/data \
  -e TOOLHOME_MASTER_KEY="$(openssl rand -base64 48)" \
  -e TOOLHOME_BOOTSTRAP_CONTROL_KEY="tch_ctl_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" \
  -e TOOLHOME_PUBLIC_URL="https://tool.cyncyn.xyz" \
  ghcr.io/crayonlu/toolhome:latest
```

Or with Docker Compose (see `references/deployment.md`). After startup, open the web console at `TOOLHOME_PUBLIC_URL` and sign in with the bootstrap Control Key.

### 2. Install the CLI (npm)

```bash
npm install -g toolhome
toolhome auth login --url https://tool.cyncyn.xyz --control-key "$TOOLHOME_CONTROL_KEY"
```

The CLI manages MCP servers and hosted CLIs as equal planes, plus shared credentials, OAuth, Market, and diagnostics. It requires Node.js 24 or later. The npm package also includes this skill under `skills/toolhome`.

### 3. Install this skill (for AI agents)

```bash
npx skills add crayonlu/toolhome -g -y
```

Teaches the agent all CLI commands, OAuth flows, Market installation, and troubleshooting.

## CLI Quick Reference

```bash
toolhome status                         # overview
toolhome doctor                         # health check
toolhome server list                    # list servers
toolhome server add ./server.json       # add a server
toolhome cli list                      # list hosted CLIs
toolhome cli add ./cli.json             # register a hosted CLI
toolhome cli status gh-cli              # probe a hosted CLI
toolhome cli exec gh-cli -- --version   # run remotely, stream output
toolhome credential list                # list credentials
toolhome credential authorize <name>    # OAuth authorization (opens browser, waits)
toolhome access-key create laptop       # create an MCP Access Key for harnesses
toolhome mcp stdio                      # serve every server placed on this machine
toolhome mcp launch <slug>              # run a server placed on this machine (stdio)
toolhome endpoint aggregate             # show the aggregate endpoint URL
toolhome market list                    # browse the Market catalog
toolhome market install resend         # supply the secret at the one-time browser URL
toolhome calls list --limit 10                              # recent tool calls
toolhome calls stats                                        # call statistics
```

## Common Workflows

### Deploy ToolHome

1. Generate two random keys (master + bootstrap control, each 32+ chars)
2. Start the Docker container with the keys and public URL
3. Open the web console, sign in with the bootstrap key
4. Create a new Control Key, revoke bootstrap
5. Run `toolhome doctor` to verify health

### Add an Upstream Server

1. Create a credential:
   ```bash
   echo '{"name":"firecrawl","payload":{"type":"bearer","token":"fc-xxx"}}' | toolhome credential add -
   ```
2. Get the credential ID from `toolhome credential list`
3. Create a server:
   ```bash
   echo '{"slug":"firecrawl","name":"Firecrawl","kind":"remote","transport":{"type":"streamable-http","url":"https://mcp.firecrawl.dev/v2/mcp"},"credentialId":"<id>","enabled":true}' | toolhome server add -
   ```
4. Verify: `toolhome doctor`

### Install and Run a Hosted CLI

```bash
toolhome market install gh-cli
toolhome cli status gh-cli
toolhome cli exec gh-cli -- --version
toolhome cli exec gh-cli --stdin $'\n' -- auth login --hostname github.com --git-protocol https --web
toolhome cli exec gh-cli -- auth status
toolhome cli exec gh-cli -- repo view crayonlu/toolhome
```

Give the user the device code and authorization URL for browser confirmation. Run the platform CLI only on the ToolHome server; the client needs only `toolhome`. Put platform arguments after `--`. Registry commands take the record ID; `exec` and `status` take its slug. Use `toolhome cli get <id>` to inspect allowed commands before execution. `host` runs installed binaries and `docker` runs sibling containers with explicit state volumes. Read `references/market-guide.md` for supported products and deployment prerequisites, and `references/cli-reference.md` for registry, stdin, timeout, and streaming options.

### Authorize OAuth Upstream

```bash
toolhome credential authorize cloudflare
```

This resolves the credential by name, opens the browser, and waits until authorization succeeds, fails, or times out (default 600s). For force re-authorization:

```bash
toolhome credential authorize cloudflare --force
```

If OAuth fails with "Invalid client" or "Incompatible auth server", switch the registration method per-server:

- URL-based (default): works for most providers
- DCR: needed for Cloudflare, Notion, Linear (set `urlClientId: false` in server settings)

See `references/oauth-guide.md` for per-provider compatibility.

### Install from Market

```bash
toolhome market list                                    # browse MCP and CLI entries
toolhome market install resend                          # home-stdio (npm); browser secret
toolhome market install context7                        # remote (bearer); browser secret
toolhome market install deepwiki                        # remote (no auth)
toolhome market install fetch                           # uvx (Python, no config)
toolhome market install markitdown                       # Docker-backed MCP
toolhome market install gh-cli                             # Hosted GitHub CLI (no token; device-flow login after)
toolhome market uninstall resend                        # remove
```

Market installs are async with progress: the CLI shows installer steps, the web console shows a live log. Packaged artifacts have version pins and installs write a persistent record (source, version, recipe revision). Remote services and the existing `/bin/sh` host-shell entry have no downloadable version pin. If required secrets are omitted, the CLI prints a one-time browser action URL. Use that flow for secrets; `--set` also accepts values, so reserve it for non-secret configuration.

**Docker entries** (e.g. `markitdown`) run the image as a sibling container via `docker run --rm -i <image>`: the install pulls the image, or builds it from the entry's inline Dockerfile when not pullable. The gateway container must mount the host docker socket and its runtime user must be in the host docker group (compose `group_add`, default GID 999, override with `DOCKER_GROUP_ID`). Only needed when a package cannot run inside the Alpine gateway image (e.g. `markitdown` — its `onnxruntime` dependency ships no musl wheels).

### Give an AI Agent Safe Management Access

Create an **agent-scoped control key** (web console → Settings → Control Keys, or API):

```bash
echo '{"name":"agent-key","scope":"agent"}' | toolhome api POST /api/v1/control-keys --body -
```

Agent keys can read state and run safe operations (enable/disable/refresh/restart, market install, tool visibility) but are denied credentials, control/access keys, secret exports, and server deletion (HTTP 403). Existing keys keep full admin scope.

Point an agent's management MCP at:

```json
{
  "url": "https://tool.cyncyn.xyz/manage/mcp",
  "headers": { "Authorization": "Bearer tch_ctl_agent..." }
}
```

The management surface exposes `home_status`, `server_list`, `server_get`, `market_search`, `tool_list`, `calls_query`, and idempotent writes `server_set_enabled`, `server_refresh`, `server_restart`, `market_install`, `tool_set_visibility`. All writes are audited in the call log. The management endpoint never appears inside the `/mcp` aggregate.

### Connect a Harness

Create an MCP Access Key:

```bash
toolhome access-key create laptop
# Returns: tch_mcp_xxx (shown once, copy it)
```

Configure the harness (aggregate endpoint):

```json
{
  "url": "https://tool.cyncyn.xyz/mcp",
  "headers": { "Authorization": "Bearer tch_mcp_xxx" }
}
```

Or per-server (independent endpoint, original tool names):

```json
{
  "url": "https://tool.cyncyn.xyz/mcp/firecrawl",
  "headers": { "Authorization": "Bearer tch_mcp_xxx" }
}
```

Aggregate tool names are `{server_slug}_{encoded_tool_name}`; non-alphanumeric UTF-8 bytes are encoded as `-hh` (for example, `github.search_code` becomes `github_search-5fcode`). Per-server preserves original names.

### Choose a Tool Exposure Mode

By default the aggregate `/mcp` endpoint lists every enabled server's tools (`full`). An opt-in `compact` mode instead exposes exactly two tools — `search` and `exec` — so an agent discovers tools on demand:

- `search`: `action=servers` (server catalog), `action=find` (ranked tools for a task), `action=describe` (a selected tool's complete input schema).
- `exec`: run one exact tool returned by `search`.

Enable it per entry (afterwards reconnect the client, which may cache `tools/list`):

```bash
# Host
TOOLHOME_MCP_TOOL_MODE=compact
# Local node
toolhome mcp stdio --tool-mode compact
```

`search` reads only locally stored definitions — no upstream request and no child process; `exec` connects only to the selected server. Node tools still run only on their owning machine, and the local compact catalog covers only that node. At startup the local entry mirrors the control plane's tool visibility; if a server's projection cannot be read it stays hidden (fail closed) until the next start or refresh.

Roll back with `TOOLHOME_MCP_TOOL_MODE=full` (or unset) and/or by dropping `--tool-mode`, then reconnect. No migration is needed: full clears compact-mirrored visibility rows and exposes every enabled tool again.

Do not nest ToolHome compact behind an upstream that already performs its own search/exec or Code Mode — keep a single discovery layer. For Cloudflare API MCP, opt out explicitly with its documented `?codemode=false` URL; ToolHome never rewrites upstream URLs or query parameters.

### Run a Server on a Client Machine

Some capabilities only exist on the machine running the agent: a local Chrome, a local Ghidra bridge, a local Python tool. Place those servers on a **node** (a label for the machine) and let the CLI launch them locally.

1. Register the server with `kind: "node"` and a `nodeId` label:

   ```bash
   echo '{"slug":"chrome-devtools","name":"Local Chrome","kind":"node","nodeId":"crayons-air","transport":{"type":"stdio","command":"npx","args":["chrome-devtools-mcp@1.6.0"],"env":{}},"enabled":true}' | toolhome server add -
   ```

   `nodeId` is a label such as `laptop`, not a credential. It records which machines should run the server, and the console groups servers by it. A `node` server requires one; other placements reject one.

2. Point the harness at the launcher. Any MCP client with stdio support can use this, and tool names stay exactly as the server defines them:

   ```json
   { "command": "toolhome", "args": ["mcp", "launch", "chrome-devtools"] }
   ```

   In Codex or Grok TOML:

   ```toml
   [mcp_servers.chrome-devtools]
   command = "/absolute/path/to/toolhome"
   args = ["mcp", "launch", "chrome-devtools"]
   enabled = true
   ```

3. Verify with `toolhome mcp launch chrome-devtools`: it must speak MCP on stdio and write nothing else to stdout.

**One entry for every server on the machine**: `toolhome mcp stdio` fronts all of them at once, so the harness config shrinks to a single command and a server added later needs no config edit at all. Tool names use the compatible `slug_encodedToolName` format; children spawn lazily on first use and are disconnected again when the client goes away.

```json
{ "command": "toolhome", "args": ["mcp", "stdio"] }
```

The machine's node label comes from `nodeId` in the local config (`~/.config/toolhome/config.json`), the `--node <id>` flag, or the hostname. `toolhome mcp launch <slug>` remains the per-server form when a client needs original names.

How it works: the launcher reads the server's transport and its credential values from `GET /api/v1/servers/{id}/runtime` (admin control key, audited, values never logged), merges them into the environment, then spawns the real process with this process's stdio so the client talks to the child directly. `TOOLHOME_*` variables are withheld from the child, so a server cannot read the control key that launched it.

Deployment note: because the launcher resolves its config through ToolHome, a client-machine server is unavailable while the ToolHome server or the network path to it is down. Placement also does not create a private channel — a `node` server still runs with the user's own privileges on that machine.

### Diagnose Issues

```bash
toolhome doctor              # check all servers
toolhome server status <id>  # detailed runtime state + last error
toolhome server logs <id>    # recent log entries
toolhome cli status <slug>  # hosted CLI probe
toolhome events --limit 100 # recent events, including cli.exec
```

## Configuration

| Env                               | Description                                        | Default                        |
| --------------------------------- | -------------------------------------------------- | ------------------------------ |
| `TOOLHOME_PUBLIC_URL`             | External HTTPS origin                              | required                       |
| `TOOLHOME_MASTER_KEY`             | Secret encryption key (32+ chars)                  | required                       |
| `TOOLHOME_BOOTSTRAP_CONTROL_KEY`  | First-boot Control Key                             | required on first boot         |
| `TOOLHOME_HOST` / `TOOLHOME_PORT` | Listen address                                     | `127.0.0.1:3344`               |
| `TOOLHOME_DATA_DIR`               | SQLite + market data                               | `/data`                        |
| `TOOLHOME_MARKET_DIR`             | Market npm install dir                             | `<dataDir>/market`             |
| `TOOLHOME_WEB_DIR`                | Web console static files                           | disabled (set in Docker image) |
| `TOOLHOME_OAUTH_URL_CLIENT_ID`    | Global OAuth client registration                   | `true` (URL-based)             |
| `TOOLHOME_UV_INDEX_URL`           | PyPI mirror for uvx Market installs                | unset (pypi.org)               |
| `TOOLHOME_CALLS_RETENTION_DAYS`   | Tool call record retention in days (metadata only) | `30`                           |
| `TOOLHOME_MCP_TOOL_MODE`          | Aggregate `/mcp` exposure: `full` or `compact`     | `full`                         |

## Deep Dives

For detailed information, read the reference files:

- `references/cli-reference.md` — Full CLI command reference with all flags
- `references/oauth-guide.md` — OAuth registration methods, per-provider compatibility, troubleshooting
- `references/market-guide.md` — Market catalog entries, installation details
- `references/deployment.md` — Docker Compose, CI/CD, reverse proxy, data persistence
- `references/troubleshooting.md` — Common issues and solutions
