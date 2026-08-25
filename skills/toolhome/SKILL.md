---
name: toolhome
description: >
  Deploy and manage a self-hosted ToolHome instance: an MCP and Hosted CLI
  control plane that aggregates upstream capabilities and platform CLIs. Use
  when the user wants to set up ToolHome, manage MCP servers or hosted CLIs,
  reuse encrypted credentials, authorize OAuth upstreams, install from the
  Market catalog, configure harnesses (Claude Code, Cursor, Codex, Grok), or
  troubleshoot ToolHome. Covers CLI, web console, Docker deployment, and CI/CD.
---

# ToolHome

ToolHome is a single-user, self-hosted control plane for MCP servers and Hosted platform CLIs. Manage upstream MCP servers, CLIs such as Azure `az`, GitHub `gh`, and Tailscale, and encrypted credentials in one place.

## When to Use This Skill

- User wants to deploy or manage the MCP or Hosted CLI plane
- User wants to aggregate multiple MCP servers behind one URL
- User wants to run platform CLIs such as Azure `az`, GitHub `gh`, or Tailscale remotely
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
  -e MCP_HOME_MASTER_KEY="$(openssl rand -base64 48)" \
  -e MCP_HOME_BOOTSTRAP_CONTROL_KEY="$(openssl rand -base64 48)" \
  -e MCP_HOME_PUBLIC_URL="https://tool.cyncyn.xyz" \
  ghcr.io/crayonlu/toolhome:latest
```

Or with Docker Compose (see `references/deployment.md`). After startup, open the web console at `MCP_HOME_PUBLIC_URL` and sign in with the bootstrap Control Key.

### 2. Install the CLI (npm)

```bash
npm install -g toolhome
toolhome auth login --url https://tool.cyncyn.xyz --control-key "$MCP_HOME_CONTROL_KEY"
```

The CLI manages servers, credentials, OAuth, Market, and diagnostics from any terminal.

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
toolhome credential list                # list credentials
toolhome credential authorize <name>    # OAuth authorization (opens browser, waits)
toolhome access-key create laptop       # create an MCP Access Key for harnesses
toolhome endpoint aggregate             # show the aggregate endpoint URL
toolhome market list                    # browse the Market catalog
toolhome market install resend --set RESEND_API_KEY=re_xxx  # install from Market
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
toolhome market list                                    # browse 30 curated entries
toolhome market install resend --set RESEND_API_KEY=re_xxx   # home-stdio (npm)
toolhome market install context7 --set CONTEXT7_API_KEY=xxx  # remote (bearer)
toolhome market install deepwiki                        # remote (no auth)
toolhome market install fetch                           # uvx (Python, no config)
toolhome market install markitdown                       # Docker-backed MCP
toolhome market install gh-cli --set GH_TOKEN=ghp_xxx     # Hosted GitHub CLI
toolhome market uninstall resend                        # remove
```

Market installs are async with progress: the CLI shows installer steps, the web console shows a live log. Every curated entry is pinned to an exact artifact version (package, Go module, GitHub Release tag, or `package==x.y.z`); installs never drift with `latest`, and each install writes a persistent record (source, version, recipe revision). If an install needs a secret, the CLI/console prints a one-time action URL instead of accepting the secret on the command line.

**Docker entries** (e.g. `markitdown`) run the image as a sibling container via `docker run --rm -i <image>`: the install pulls the image, or builds it from the entry's inline Dockerfile when not pullable. The gateway container must mount the host docker socket and its runtime user must be in the host docker group (compose `group_add`, default GID 999, override with `DOCKER_GROUP_ID`). Only needed when a package cannot run inside the Alpine gateway image (e.g. `markitdown` — its `onnxruntime` dependency ships no musl wheels).

### Give an AI Agent Safe Management Access

Create an **agent-scoped control key** (web console → Settings → Control Keys, or CLI):

```bash
toolhome control-key create agent-key --scope agent
```

Agent keys can read state and run safe operations (enable/disable/refresh/restart, market install, tool visibility) but are denied credentials, control/access keys, secret exports, and server deletion (HTTP 403). Existing keys keep full admin scope.

Point an agent's management MCP at:

```json
{
  "url": "https://tool.cyncyn.xyz/manage/mcp",
  "headers": { "Authorization": "Bearer mch_ctl_agent..." }
}
```

The management surface exposes `home_status`, `server_list`, `server_get`, `market_search`, `tool_list`, `calls_query`, and idempotent writes `server_set_enabled`, `server_refresh`, `server_restart`, `market_install`, `tool_set_visibility`. All writes are audited in the call log. The management endpoint never appears inside the `/mcp` aggregate.

### Connect a Harness

Create an MCP Access Key:

```bash
toolhome access-key create laptop
# Returns: mch_mcp_xxx (shown once, copy it)
```

Configure the harness (aggregate endpoint):

```json
{
  "url": "https://tool.cyncyn.xyz/mcp",
  "headers": { "Authorization": "Bearer mch_mcp_xxx" }
}
```

Or per-server (independent endpoint, original tool names):

```json
{
  "url": "https://tool.cyncyn.xyz/mcp/firecrawl",
  "headers": { "Authorization": "Bearer mch_mcp_xxx" }
}
```

Aggregate tool names are `{server_slug}.{tool_name}`. Per-server preserves original names.

### Diagnose Issues

```bash
toolhome doctor              # check all servers
toolhome server status <id>  # detailed runtime state + last error
toolhome server logs <id>    # recent log entries
toolhome events              # recent events with level filter
```

## Configuration

| Env                              | Description                                        | Default                        |
| -------------------------------- | -------------------------------------------------- | ------------------------------ |
| `MCP_HOME_PUBLIC_URL`            | External HTTPS origin                              | required                       |
| `MCP_HOME_MASTER_KEY`            | Secret encryption key (32+ chars)                  | required                       |
| `MCP_HOME_BOOTSTRAP_CONTROL_KEY` | First-boot Control Key                             | required on first boot         |
| `MCP_HOST` / `MCP_HOME_PORT`     | Listen address                                     | `127.0.0.1:3344`               |
| `MCP_HOME_DATA_DIR`              | SQLite + market data                               | `/data`                        |
| `MCP_HOME_MARKET_DIR`            | Market npm install dir                             | `<dataDir>/market`             |
| `MCP_HOME_WEB_DIR`               | Web console static files                           | disabled (set in Docker image) |
| `MCP_HOME_OAUTH_URL_CLIENT_ID`   | Global OAuth client registration                   | `true` (URL-based)             |
| `MCP_HOME_UV_INDEX_URL`          | PyPI mirror for uvx Market installs                | unset (pypi.org)               |
| `MCP_HOME_CALLS_RETENTION_DAYS`  | Tool call record retention in days (metadata only) | `30`                           |

## Deep Dives

For detailed information, read the reference files:

- `references/cli-reference.md` — Full CLI command reference with all flags
- `references/oauth-guide.md` — OAuth registration methods, per-provider compatibility, troubleshooting
- `references/market-guide.md` — Market catalog entries, installation details
- `references/deployment.md` — Docker Compose, CI/CD, reverse proxy, data persistence
- `references/troubleshooting.md` — Common issues and solutions
