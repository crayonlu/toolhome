# Market Guide

## Overview

The Market is a curated catalog of common MCP servers. One command installs the server, creates the credential, and configures everything.

## Catalog Entries (24)

### Remote (OAuth)
github (PAT), linear, slack, stripe, figma, sentry, supabase, notion, cloudflare, deepwiki

### Remote (API Key)
context7, exa, tavily, firecrawl, openrouter, apifox

### Home-stdio (npm)
resend, tailscale, playwright, postgres, sqlite, memory, sequential-thinking

### Uvx (Python)
fetch

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

**Home-stdio entries**: Runs `npm install --prefix <marketDir> <package>`, creates an env credential, and creates a home server with the stdio command pointing to the installed binary. The install is async with progress logging.

**Uvx entries**: Runs `uv tool install <package>` (Python packages from PyPI), then creates a home server with the stdio command `uvx <package>`. Requires the `uv` runtime, which is bundled in the Docker image. Some entries pin extra dependencies via `--with` (e.g. `mcp-server-fetch` pins `mcp<2` because upstream still imports the pre-2.0 `McpError` name).

### Install Location

Home-stdio packages install to `MCP_HOME_MARKET_DIR` (default `<dataDir>/market`), which is a persistent Docker volume. Packages survive container restarts. Uvx tools and caches install to `<dataDir>/.uv`, also persistent.

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

The catalog is defined in `src/market/catalog.ts` (bundled). To add entries, edit this file and redeploy. A remote catalog URL (`MCP_HOME_MARKET_URL`) is planned for future updates without redeployment.
