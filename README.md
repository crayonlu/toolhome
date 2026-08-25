# ToolHome

> **🌐 Language: English · [中文](README.zh.md)**

ToolHome is a single-user, self-hosted control plane for MCP servers and Hosted CLIs. Manage upstream MCP capabilities, platform CLIs such as Azure `az`, GitHub `gh`, and Tailscale, and their encrypted credentials in one place.

It exposes two data planes:

- **MCP**: `POST /mcp` aggregates enabled servers; `POST /mcp/{server_slug}` preserves one server's original names and extensions.
- **Hosted CLI**: `POST /cli/{slug}/exec` runs an allow-listed argv array on the ToolHome host or in a pinned sibling container and streams NDJSON stdout/stderr/exit frames. `GET /cli/{slug}/status` runs the declared status probe.

ToolHome does not write harness-specific adapters for Claude Code, Codex, Cursor, or anything else. MCP clients use standard Streamable HTTP with Bearer auth; management and Hosted CLI operations use Control Keys.

## For AI Agents

Install the ToolHome skill to teach your agent how to deploy and manage ToolHome:

```bash
npx skills add crayonlu/toolhome -g -y
```

This gives the agent knowledge of all CLI commands, OAuth flows, Market installation, troubleshooting, and deployment patterns. The agent will know when and how to use ToolHome without manual instructions.

## Web Console

The web console mirrors the full CLI surface: server and credential management, OAuth authorization, one-click Market installs, tool call observability, diagnostics, events, config export/import — with Chinese/English UI and mobile support.

<div style="display: flex; flex-wrap: wrap; gap: 8px;">
  <img src="docs/screenshots/en/dashboard.png" width="49%" alt="Dashboard">
  <img src="docs/screenshots/en/servers.png" width="49%" alt="Servers">
  <img src="docs/screenshots/en/calls.png" width="49%" alt="Calls">
  <img src="docs/screenshots/en/credentials.png" width="49%" alt="Credentials">
  <img src="docs/screenshots/en/market.png" width="49%" alt="Market">
  <img src="docs/screenshots/en/settings.png" width="49%" alt="Settings">
</div>

Mobile:

<div style="display: flex; gap: 8px;">
  <img src="docs/screenshots/en/market-mobile.png" width="49%" alt="Market mobile">
  <img src="docs/screenshots/en/dashboard-mobile.png" width="49%" alt="Dashboard mobile">
</div>

## Project Scope

ToolHome has two first-class planes:

- **MCP**: Remote-native servers use Streamable HTTP; Home-hosted servers use stdio on the ToolHome host.
- **Hosted CLI**: platform CLIs represent an external service or control plane, for example Azure `az`, GitHub `gh`, and Tailscale. They are invoked with complete argv, stdin, timeout and output limits, allow/deny rules, and NDJSON output frames. Package managers and developer tools such as `npm`, `go`, `cargo`, `uv`, `pipx`, `docker`, and `cursor` are installer/runtime details, not Hosted CLI products.

MCPs or CLIs that must run on the harness machine and depend on its browser or desktop state remain local to that harness. The first release explicitly excludes multi-tenancy, profiles, workspaces, and project management.

## Protocol Capabilities

The per-server entry proxies losslessly; the aggregate virtualizes conflicting names while keeping everything routable:

- Tools, Prompts, Resources, Resource Templates, Completion
- Resource subscriptions and list-changed notifications
- Sampling, Roots, Elicitation, and 2026 MRTR `input_required`
- Final Tasks extension: `tasks/get`, `tasks/update`, `tasks/cancel`, task-ID virtualization, and `Mcp-Name` binding
- MCP Apps: `ui://` URIs are preserved on the aggregate; original App semantics on per-server entries
- Logging, Progress, cancellation, and custom extension methods
- Automatic 2026-07-28 / 2025-era negotiation, with remote SSE available as an explicit fallback

Downstream 2026 requests stay stateless; 2025-era clients use a persistent session bound to the authenticated principal, preserving initialize capability declarations and bidirectional request semantics. Parts of the Final Tasks extension not yet registered by SDK 2.0 are filled in by an isolated compatibility layer that still speaks the official `tasks/*` wire contract.

Aggregated tool names are `{server_slug}.{upstream_name}`. Unknown extension methods use `toolhome/{server_slug}/{upstream_method}` on the aggregate and pass through untouched on per-server entries. MCP Apps that use original tool names are routed by App resource context or globally unique names; use a per-server entry when names collide.

When a modern harness calls a legacy upstream, ToolHome suspends push-style Elicitation, Sampling, and Roots in Tool, Prompt, and Resource Read calls, converts them to modern `input_required` multi-turn interactions, then resumes the same upstream request. Legacy extensions that issue private server-to-client requests inside a custom method have no standard representation in the closed MRTR type set; use a legacy harness or upgrade the upstream protocol for those.

See [architecture](docs/architecture.md) and [protocol compatibility](docs/protocol-compatibility.md) for details.

## Quick Start

Requires Node.js 24 or newer.

```bash
npm install
cp .env.example .env
```

Generate two independent random values for `MCP_HOME_MASTER_KEY` and the first-boot `MCP_HOME_BOOTSTRAP_CONTROL_KEY`. Both must be at least 32 characters and must differ.

```bash
npm run build
set -a
source .env
set +a
npm start
```

Open `MCP_HOME_PUBLIC_URL` and sign in to the web console with the bootstrap Control API Key. Once you create a new Control Key, you can revoke the bootstrap key.

For development, run the server and web separately:

```bash
npm run dev
npm run dev:web
```

Vite proxies `/api` requests to `http://127.0.0.1:3344`.

## Docker

```bash
export MCP_HOME_MASTER_KEY="$(openssl rand -base64 48)"
export MCP_HOME_BOOTSTRAP_CONTROL_KEY="$(openssl rand -base64 48)"
export MCP_HOME_PUBLIC_URL="https://tool.cyncyn.xyz"
export MCP_HOME_ALLOWED_HOSTS="tool.cyncyn.xyz"
docker compose up -d --build
```

Put an HTTPS reverse proxy in front of ToolHome in production. OAuth callbacks, URL-based Client IDs, and remote harness connections should all use a stable HTTPS `MCP_HOME_PUBLIC_URL`. The value must be a canonical origin — no path, query, fragment, username, or password. Data lives in `/data/toolhome.sqlite` (SQLite, WAL mode).

Market installers are hidden behind curated capability entries. The catalog can use npm, Go, GitHub Release archives, uvx, or Docker recipes; the product surface remains MCP servers and Hosted platform CLIs. Uvx entries execute the installed binary from the persistent ToolHome tool directory instead of resolving the package again on every refresh. Docker-backed entries require the Docker socket mount shown in `docker-compose.yml`. Hosted CLI state directories are explicit named volumes, never implicit mounts of a user's local credential directory.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on every push to main or tag:

1. **test**: server check + test, web typecheck + test
2. **docker**: build dists -> `docker build` -> push `ghcr.io/crayonlu/toolhome:latest` (tags also get `:v*`)
3. **deploy**: SSH to server `docker compose pull && up -d`

Deployment requires three GitHub Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KEY` (SSH private key). The GHCR package must be set to Public (after first push, in Package Settings).

## Market

The Market ships curated MCP servers and Hosted platform CLIs. Installing an entry creates the encrypted Credential and the corresponding Server or CLI record:

```bash
npm run cli -- market list
npm run cli -- market install resend --set RESEND_API_KEY=re_xxx
npm run cli -- market install gh-cli --set GH_TOKEN=ghp_xxx
npm run cli -- market uninstall gh-cli
```

- MCP entries may be remote, npm-backed, uvx-backed, or Docker-backed.
- Hosted CLI entries include Azure `az`, GitHub `gh`, and Tailscale. They pin the platform artifact, define allowed argv, and declare how stored credential material reaches the CLI.
- A CLI can use a bearer token (`GH_TOKEN`), selected Env Credential variables (Azure service principal), or an OAuth access token after the shared MCP authorization flow completes.
- The web console's Market page offers the same flow graphically. MCP/CLI is a plane switch: only entries and records from the selected plane are shown.

## Connecting a Harness

First create an MCP Access API Key from the console or CLI. The generic aggregate configuration is:

```json
{
  "url": "https://tool.cyncyn.xyz/mcp",
  "headers": {
    "Authorization": "Bearer mch_mcp_..."
  }
}
```

For a single GitHub server only:

```json
{
  "url": "https://tool.cyncyn.xyz/mcp/github",
  "headers": {
    "Authorization": "Bearer mch_mcp_..."
  }
}
```

Access Keys only call the MCP data plane; they cannot read server or credential configuration. Control Keys only call the control plane and cannot be used as an MCP identity.

The data plane also implements OAuth 2.1: a harness can discover the authorization server via RFC 9728 metadata and use Authorization Code + PKCE to obtain an access token bound to a specific MCP endpoint.

Downstream Dynamic Client Registration returns a stateless Client ID signed with the master key — no in-process registry, valid across restarts with the same key. HTTPS URL-based Client Metadata is also supported, with limits on response size, redirects, and non-public targets.

## Upstream Authentication

Remote-native servers support:

- Bearer token
- API key header
- Multiple custom headers
- OAuth 2.1 / OIDC

OAuth/OIDC uses the official MCP TypeScript SDK auth orchestrator, covering RFC 9728 discovery, Authorization Server/OIDC metadata, PKCE, RFC 9207 issuer validation, CIMD, DCR, refresh, and RFC 8707 resource indicators. An OAuth Credential is bound 1:1 to a Remote Server, preventing token reuse across resources or issuers.

> If an upstream authorization server advertises URL-based Client Metadata support but cannot fetch it from a proxied origin (for example Cloudflare-hosted MCP), set `MCP_HOME_OAUTH_URL_CLIENT_ID=false` to force Dynamic Client Registration.

Home-hosted servers use an Environment Credential or the transport's own `env`.

Put secrets in Credentials, not in Remote URL query strings or stdio arguments — the latter are structural configuration and cannot be reliably redacted.

## CLI

After building, run `toolhome`; from source, use `npm run cli --`.

```bash
npm run cli -- auth login \
  --url https://tool.cyncyn.xyz \
  --control-key "$MCP_HOME_CONTROL_KEY"

npm run cli -- server list
npm run cli -- server add ./server.json
npm run cli -- cli list
npm run cli -- cli status az
npm run cli -- cli exec az -- account show
npm run cli -- cli exec gh --stdin-file ./input.txt -- issue list
npm run cli -- credential authorize cloudflare
npm run cli -- access-key create laptop
npm run cli -- endpoint aggregate
npm run cli -- doctor
```

`cli exec` sends an argv array to the hosted CLI and streams stdout/stderr without invoking a shell. Put `--` before CLI arguments that start with `-`; `--stdin` and `--stdin-file` feed remote stdin, and `--output json` emits one JSON object per frame plus the final exit outcome:

```bash
npm run cli -- cli exec az --timeout 30000 -- account show --subscription "$SUBSCRIPTION_ID"
npm run cli -- cli exec gh --stdin-file ./issue.md -- issue create --title "Bug" --body-file -
npm run cli --output json -- cli exec host-shell -- -c 'printf hello'
```

The CLI command family also supports `cli get`, `cli add`, `cli update`, `cli delete`, `cli enable`, and `cli disable`. `cli exec` returns exit status 0 only when the hosted process reports `result: "ok"`; SIGINT/SIGTERM abort the HTTP stream and the remote process.

`credential authorize <name>` resolves by credential name (or id), opens the browser, and waits until authorization succeeds, fails, or times out:

```bash
npm run cli -- credential authorize notion --server notion   # explicit server (auto-resolved if omitted)
npm run cli -- credential authorize notion --force            # clear the old client and re-authorize
npm run cli -- credential authorize notion --no-open          # don't open the browser
npm run cli -- credential authorize notion --no-wait          # print the URL and exit
npm run cli -- credential authorize notion --timeout 300      # wait time in seconds (default 600)
```

The CLI exposes a command for every Control API capability plus a general escape hatch:

```bash
npm run cli -- api GET /api/v1/openapi.json
```

Config export is redacted and reviewable by default, and cannot be used to restore. Credential payloads, static HTTP header values, and stdio transport env values are hidden. When secrets are explicitly included, the CLI writes the file with `0600` permissions; import rebuilds credentials, remaps related IDs, and rolls back atomically in a single SQLite transaction if any step fails.

```bash
npm run cli -- config export backup.json --include-secrets
npm run cli -- config import backup.json
```

Backups contain plaintext secrets and deserve the same protection as the master key. `--include-secrets` requires an explicit output file to avoid leaking secrets into terminal logs, and the CLI forces `0600` after writing. Omit it for routine review.

## Configuration

| Environment variable             | Description                                                                   | Default                 |
| -------------------------------- | ----------------------------------------------------------------------------- | ----------------------- |
| `MCP_HOME_HOST`                  | Listen address                                                                | `127.0.0.1`             |
| `MCP_HOME_PORT`                  | Listen port                                                                   | `3344`                  |
| `MCP_HOME_PUBLIC_URL`            | Externally reachable canonical origin (production: `https://tool.cyncyn.xyz`) | `http://127.0.0.1:3344` |
| `MCP_HOME_DATA_DIR`              | SQLite and runtime data directory                                             | `./data`                |
| `MCP_HOME_MASTER_KEY`            | Root key for secret encryption/signing/digests                                | required                |
| `MCP_HOME_BOOTSTRAP_CONTROL_KEY` | Control Key written on first database boot                                    | required on first boot  |
| `MCP_HOME_ALLOWED_HOSTS`         | Allowed Hosts, comma-separated                                                | Public URL hostname     |
| `MCP_HOME_LOG_LEVEL`             | `debug`, `info`, `warn`, `error`                                              | `info`                  |
| `MCP_HOME_WEB_DIR`               | Web console static files directory                                            | disabled                |
| `MCP_HOME_MARKET_DIR`            | Market npm install directory                                                  | `<dataDir>/market`      |
| `MCP_HOME_OAUTH_URL_CLIENT_ID`   | Enable URL-based Client Metadata                                              | `true`                  |

## Security Model

- Upstream secrets are AES-256-GCM encrypted before being written to SQLite.
- The database stores an encrypted master-key check; booting with the wrong master key fails immediately instead of silently locking existing API keys.
- API Keys are stored only as HMAC digests; the full secret is returned once at creation.
- Control and MCP Access Keys use distinct prefixes and validation domains.
- The web console exchanges the Control Key for a short-lived, HttpOnly, SameSite=Strict session cookie.
- Downstream OAuth tokens have exact endpoint audiences; an aggregate token cannot call per-server endpoints and vice versa.
- OAuth callbacks validate state, PKCE, issuer, and discovery state.
- URL-based client metadata rejects private-network and insecure targets and pins validated public-resolved addresses for HTTPS fetches, reducing SSRF and DNS-rebinding risk.
- Downstream DCR Client IDs are signed with the master key, verifiable across restarts, and never stored in the database.
- Diagnostic events keep the last ~10,000 entries; Home-hosted stderr is redacted against transport env and Environment Credential values before entering the event stream.

Back up the database and `MCP_HOME_MASTER_KEY`, or keep a tightly protected `--include-secrets` config export. Losing the master key makes encrypted credentials in the original database unrecoverable.

## Engineering Commands

```bash
npm run check
npm run format:check
npm run build
npm run test
npm run test:real
```

`npm run test:real` prefers to launch the built ToolHome process and connects Home-hosted stdio and Remote-native HTTP fixtures. It uses the official MCP Client to verify aggregate/per-server entries, modern/legacy harnesses, Progress, cancellation, list-changed, MRTR, Tasks, and auth boundaries; it falls back to source entry points when no build artifact exists, which is handy for local debugging.

`/healthz` reports process liveness only; `/readyz` returns `503` while runtime state is unavailable.

## License

[MIT](LICENSE)
