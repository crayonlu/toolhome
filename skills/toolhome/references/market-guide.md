# Market Guide

## Overview

The Market is a curated catalog of MCP servers and hosted platform CLIs. One command installs the target, creates the credential, and configures the runtime. A Market entry represents the capability itself; installer technologies such as npm, Go, GitHub Release, uv, and Docker remain implementation details.

## Catalog Entries (35)

### Remote (OAuth)

github (PAT), linear, slack, stripe, figma, sentry, supabase, notion, cloudflare, deepwiki

### Remote (API Key)

context7, exa, tavily, firecrawl, openrouter, apifox

### Home-stdio MCP servers

resend, tailscale, playwright, postgres, sqlite, memory, sequential-thinking

### Uvx-backed MCP server

fetch

### Hosted platform CLIs

azure-cli (`az`), gh-cli (`gh`), tailscale-cli, lark-cli, firecrawl-cli (`firecrawl`), wrangler-cli (`wrangler`), vercel-cli, aliyun-cli (`aliyun`)

Hosted CLI entries are parallel to MCP entries. The catalog describes the platform command, pinned artifact, credential requirements, and allowed argv; it does not expose npm, Go, uv, or Docker as products.

npm-backed CLI entries (`lark-cli`, `firecrawl-cli`, `wrangler-cli`, `vercel-cli`) install into the persistent market volume and run in host mode. Credentials are injected as environment variables (`FIRECRAWL_API_KEY`, `CLOUDFLARE_API_TOKEN`, `VERCEL_TOKEN`); `lark-cli` ships no token env var — run `lark-cli auth login --no-wait --json` through exec, complete the device flow in a browser, then finish with `lark-cli auth login --device-code <code>`. Its npm package downloads the platform binary on first execution, so the first command needs a generous exec timeout. `aliyun-cli` installs a pinned GitHub Release tarball (linux-amd64) and authenticates through `ALIBABA_CLOUD_ACCESS_KEY_ID`, `ALIBABA_CLOUD_ACCESS_KEY_SECRET`, and `ALIBABA_CLOUD_REGION_ID`; bare probe commands (its `aliyun version` probe) resolve next to the installed binary.

> ⚠️ The npm package name `mcp-server-fetch` is **squatted** by a canary (npx-confusion) package that runs code on install. The official Fetch server is Python — the catalog installs it via `uvx`, never via npm.

## Installation

```bash
toolhome market list                                    # browse with install status
toolhome market install resend --set RESEND_API_KEY=re_xxx
toolhome market install context7 --set CONTEXT7_API_KEY=xxx
toolhome market install deepwiki                        # no config needed
toolhome market install fetch                           # uvx (Python), no config
toolhome market uninstall resend
```

### How It Works

**Remote entries**: Creates a credential (bearer/headers/oauth) + a remote server with the upstream URL. For OAuth entries, run `toolhome credential authorize <name>` after install.

**Home-stdio entries**: The installer backend runs the pinned npm recipe, creates an env credential, and creates a home server with the stdio command pointing to the installed binary. The install is async with progress logging.

**Uvx entries**: The installer backend runs `uv tool install <package>` (Python packages from PyPI), then creates a home server that executes the installed binary from the persistent `UV_TOOL_BIN_DIR`. It does not run `uvx <package>` again during every MCP refresh, so the pinned artifact is reused without a second dependency resolution. Some entries pin extra dependencies via `--with` (e.g. `mcp-server-fetch` pins `mcp<2` because upstream still imports the pre-2.0 `McpError` name).

**Hosted CLI entries**: A CLI entry provisions a first-class CLI record and installs its pinned artifact through the entry's hidden npm, Go, GitHub Release, uvx, or Docker recipe. Execution remains argv-only and uses the same encrypted credential payloads as MCP. A declarative binding maps credential material to the platform CLI environment, for example `GH_TOKEN <- bearer token` or `AZURE_CLIENT_ID <- env:CLIENT_ID`. OAuth-backed CLI records use the stored access token and return `credential_authorization_required` until the credential is authorized. ToolHome never mounts a user's local `~/.azure`, `~/.config/gh`, `~/.aws`, or similar directory by default.

Azure service-principal entries use `authStrategy: "azure-service-principal"`: the runner starts `/bin/sh` inside the pinned Azure image, executes a fixed non-interactive `az login --service-principal` from `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and `AZURE_TENANT_ID`, then executes the allow-listed `az` argv. The named `/root/.azure` volume preserves CLI state across runs without importing a user's local Azure profile.

Tailscale entries use `authStrategy: "tailscale-auth-key"` and an explicit named `/var/lib/tailscale` volume. Each invocation starts `tailscaled` in userspace-networking mode inside the pinned container, waits for its socket, performs the fixed `tailscale --socket=/var/run/tailscale/tailscaled.sock up --auth-key="$TS_AUTHKEY" --reset` bootstrap, then executes the allow-listed `tailscale` argv through that socket. This avoids requiring host TUN devices or kernel capabilities; the state volume preserves the node identity. The entry remains limited to the catalog's read-only `version`, `status`, and `netcheck` commands.

### Hosted CLI Authentication

MCP and CLI credentials share the encrypted `CredentialPayload` storage format and a common materialization layer:

- `env` credentials pass variables through, or select them with `env:<name>` bindings.
- `bearer` credentials bind with `token`.
- `api-key` credentials bind with `value`.
- `headers` credentials bind with `header:<Header-Name>`.
- `oauth` credentials bind with `accessToken` after authorization.

The MCP side still owns OAuth provider discovery, refresh, and callback handling. The CLI side only consumes the stored access token; it does not implement a second OAuth transport.

### Install Location

Home-stdio packages, Go binaries, and GitHub Release binaries install to `TOOLHOME_MARKET_DIR` (default `<dataDir>/market`), which is a persistent Docker volume. Packages survive container restarts. Uvx tools and caches install to `<dataDir>/.uv`, also persistent.

### Installation Progress

- CLI: shows `installing: npm install <package>...` with live progress
- Web console: InstallSheet shows spinner + current step + live npm output log
- API: `POST /market/:id/install` returns a `jobId`; `GET /market/install/:jobId` polls status

## Adding Custom Servers (outside Market)

For servers not in the catalog, use the standard CLI:

```bash
echo '{"name":"custom","payload":{"type":"bearer","token":"xxx"}}' | toolhome credential add -
echo '{"slug":"custom","name":"Custom","kind":"remote","transport":{"type":"streamable-http","url":"https://example.com/mcp"},"credentialId":"<id>","enabled":true}' | toolhome server add -
```

## Market Catalog Source

The catalog is defined in `src/market/catalog.ts` (bundled). To add entries, edit this file and redeploy. A remote catalog URL (`TOOLHOME_MARKET_URL`) is planned for future updates without redeployment.
