# Troubleshooting

## Server Status Shows "Unknown"

**Cause**: The `/api/v1/servers` endpoint wasn't returning runtime state (fixed in recent versions).

**Fix**: Update to the latest image. Verify:

```bash
toolhome server list --output json | jq '.[0].runtime.status'
```

If `runtime` is missing, the server is running an old version. Pull the latest image.

## OAuth "Invalid client"

**Cause**: The upstream rejected the URL-based client metadata.

**Fix**: Switch to DCR for that server:

```bash
echo '{"settings":{"urlClientId":false}}' | toolhome server update <id> -
toolhome credential authorize <name> --force
```

See `oauth-guide.md` for per-provider compatibility.

## OAuth "Incompatible auth server: does not support dynamic client registration"

**Cause**: The upstream has no `registration_endpoint` and DCR was forced.

**Fix**: Switch to URL-based (the default):

```bash
echo '{"settings":{"urlClientId":true}}' | toolhome server update <id> -
toolhome credential authorize <name> --force
```

## OAuth "invalid_redirect_uri"

**Cause**: The upstream only approves specific redirect URIs (e.g., Vercel only allows `http://localhost:<port>/callback`).

**Fix**: This provider is incompatible with a remote gateway. Use a PAT (Personal Access Token) as a bearer credential, or keep the MCP configured locally in the harness.

## npm Install Corruption (home-stdio)

**Symptom**: Home-hosted stdio server shows "unreachable" with module resolution errors (e.g., `Cannot find module '.../dist/index.js'`).

**Cause**: npm cache corruption on the server. The tarball was partially extracted.

**Fix**: Inspect the failed entry and reinstall that entry. The npm directory is shared with other MCP servers and CLIs; do not clear the entire directory:

```bash
toolhome market uninstall <id>
toolhome market install <id> --set KEY=value
```

## Fetch Server Won't Start (package name squatting)

**Symptom**: Installing `fetch` from Market produces a server that never reaches "ready", or the installed package description mentions "security research canary".

**Cause**: The npm name `mcp-server-fetch` is **squatted** — the official Fetch server is Python (PyPI `mcp-server-fetch`). The npm package is a canary that runs code in a `postinstall` script.

**Fix**: Ensure the catalog entry uses `kind: "uvx"` (installs via `uv tool install`, runs the installed binary). Remove any npm-installed copy:

```bash
docker exec toolhome rm -rf /data/market/node_modules/mcp-server-fetch /data/market/node_modules/.bin/mcp-server-fetch
toolhome server delete <fetch-server-id>
toolhome market install fetch
```

## Fetch Server "Unreachable" with `ImportError: McpError`

**Symptom**: The uvx-installed fetch server shows unreachable with `ImportError: cannot import name 'McpError' from 'mcp.shared.exceptions'`.

**Cause**: `mcp-server-fetch` (2026.7.10) still imports the pre-2.0 `McpError` name; uv resolves the latest `mcp==2.0` which renamed it to `MCPError`. This is an upstream compatibility break.

**Fix**: Reinstall with the pinned dependency (the catalog already ships `uvWith: ['mcp<2']`):

```bash
toolhome market uninstall fetch
toolhome market install fetch
```

If upgrading an existing broken install without the pin, fix the tool env directly:

```bash
docker exec toolhome sh -c 'uv tool install mcp-server-fetch --with "mcp<2"'
toolhome server restart fetch
```

## Cloudflare Proxy SSE Delay (~25s per request)

**Symptom**: Every MCP request (initialize, tools/list, tools/call) takes ~25s through Cloudflare, but works fine direct.

**Cause**: Cloudflare buffers SSE POST responses.

**Fix**: Set the DNS record for the ToolHome subdomain to "DNS only" (grey cloud), bypassing Cloudflare's proxy. The origin server has a valid TLS certificate (Let's Encrypt via the reverse proxy).

## Credential Shows "Expired"

**Cause**: OAuth access tokens expire (typically 1 hour). ToolHome refreshes lazily.

**Fix**: The web console auto-refreshes expired OAuth credentials on page load. Manually:

```bash
toolhome credential test <id>
toolhome server refresh <server-id>
```

## Upstream "unreachable" Intermittently

**Cause**: Network flakiness between the ToolHome server and the upstream (common for overseas providers from China-based servers).

**Fix**: ToolHome auto-reconnects. Check `toolhome doctor` periodically. For persistent issues, consider relocating the ToolHome server closer to the upstreams, or using a proxy.

## Delete Access Key Returns 404

**Cause**: The key was already revoked. The list endpoint only shows active keys (fixed in recent versions).

**Fix**: This is expected behavior. Revoked keys are gone from the list. No action needed.

## Docker Build Fails (OOM)

**Cause**: The server has limited RAM (<2GB). In-container `npm ci` + `vite build` + `tsc` thrashes memory.

**Fix**: Use the prebuilt GHCR image (`ghcr.io/crayonlu/toolhome:latest`) instead of building locally. The CI pipeline builds on GitHub runners (ample RAM) and pushes the image.

## CLI "command.opts is not a function"

**Cause**: Commander action handler parameter ordering bug (fixed in recent versions).

**Fix**: Update to the latest version: `npm install -g toolhome@latest`.

## A Node Server Shows No State in the Console

**Symptom**: a server placed on a client machine (`kind: node`) always reads as unknown, while
host-run servers show Ready.

**Cause**: this is by construction, not a fault. The ToolHome host never connects to a node
server — the machine running `toolhome mcp stdio` does — so the host has nothing of its own to
report. Before 0.6.17 that left every node server looking identical to a broken one.

**Fix**: the machine now reports what it sees. `toolhome mcp stdio` posts a report at startup and
every 60 seconds; `toolhome node report` does it once. The console shows *"reported by
crayons-air 2 minutes ago · 26 tools"*, and flags the launch command as missing when that machine
does not have it. If a row says *"not reported by &lt;machine&gt; yet"*, no client has connected
since the report channel existed — run `toolhome node report` there, or start `toolhome mcp
stdio`. If it says *"last reported by … 3 hours ago"*, that machine stopped reporting: the state
is kept with its age instead of being presented as current.

## Hosted CLIs Look Ready but Are Not

**Symptom**: the CLIs page says a CLI is ready while `toolhome cli exec <slug> -- …` fails.

**Cause**: the page used the record's `enabled` flag as its status, which only says ToolHome will
run the CLI. Whether the binary is installed and signed in is a question for the CLI's own probe,
and that probe may never answer: the catalog's default probe is `<binary> --version`, which prints
no `version=`/`loggedIn=` markers.

**Fix**: the page now says **Configured** until a probe answers, and **Check** / **Check all**
runs the probe on request (it executes the CLI, so it does not run on page load). The result is
one of *Signed in*, *Not signed in*, *Not installed*, *No status reported* (the probe ran and
printed no markers — inconclusive, not a failure), *No probe* (the record declares none), or *Not
checked*. For an entry whose probe cannot report, declare one that does, e.g. `gh-cli` uses
`/bin/sh -c` to print both markers.

## The MCP Client Times Out on `toolhome-local` (70s), Then Never Recovers

**Symptom**: the client reports `MCP server 'toolhome-local' timed out after 70s`. The remote
`toolhome` entry (same instance) keeps working, and `toolhome mcp stdio` started by hand works
too.

**Cause**: `toolhome-local` is a stdio entry — `toolhome mcp stdio` — so a timeout means the
launcher's startup did not finish, not that the instance is down. Startup makes one request
(`GET /api/v1/servers`) plus one per node-placed server (`/runtime`). Whatever the transport
reason — a proxy switching nodes, a fake-IP mapping going stale, a stalled VPN, a brief network
drop — the client has already given up at 70s and **does not retry**, so the session stays
broken until the client restarts the server. The client's captured stderr is the evidence:

```bash
cat ~/.grok/logs/mcp/toolhome-local.stderr.log     # e.g. "cannot reach https://… : ETIMEDOUT"
```

**Check the order that isolates it**:

```bash
toolhome status          # control plane reachable with this config? (env overrides the file)
toolhome node status     # the local mirror's view of this machine's servers
toolhome mcp stdio       # by hand: it must print `serving node "<label>" over stdio`
```

Read the error text: `ENOTFOUND`/`EAI_AGAIN` is DNS, `ECONNREFUSED` is nothing listening,
`ETIMEDOUT` is a stalled path, and a plain 401/403 means the control key, not the network.

**On a host with a TUN-mode proxy** (Clash, Surge, sing-box), DNS returns a fake IP from the
proxy's pool and every connection is tunnelled, which is the usual reason a path that works one
minute stalls the next. Node's `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY` unless
`NODE_USE_ENV_PROXY=1` is set, so the launcher uses the TUN path even when the proxy's HTTP port
works for `curl`. To make the launcher use the proxy port that is already proven working:

```bash
NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://127.0.0.1:10808 HTTPS_PROXY=http://127.0.0.1:10808 \
  NO_PROXY=localhost,127.0.0.1 toolhome mcp stdio
```

**If a launcher is wedged**, it holds the local mirror while the client is no longer using it:

```bash
ps -ax -o pid,command | grep 'toolhome mcp stdio'    # a stuck one shows a high CPU time
kill -9 <pid>                                        # the client respawns it on demand
```

The mirror is a cache: deleting `~/.config/toolhome/node.sqlite*` while no launcher runs is safe
and forces a clean rebuild on the next start.

## A Migrated Hosted CLI Reports `loggedIn: false`

**Symptom**: after `toolhome migrate`, `toolhome cli status gh-cli` on the target says the CLI is
installed but not logged in.

**Cause**: a platform CLI keeps its login where it chooses, and none of those places is the CLI
record. `gh` stores its token in the macOS keychain by default — `~/.config/gh/hosts.yml`
contains `user`, `git_protocol` and an empty `users:` entry but no token — so copying that file
moves nothing. `az` keeps a token cache under `/root/.azure` inside its state volume. Others log
in by device flow and write state inside the gateway.

**Fix**: run `toolhome cli adopt <slug>` from the machine that is already logged in (it extracts
with the CLI's own command, e.g. `gh auth token`, and hands the value to the target's `exec`
stdin), or migrate with `--with-state` to move the whole state volume. `toolhome cli adopt <slug>
--dry-run` prints what it would do without touching anything. Entries whose login cannot move
report `manual` and name the command to run on the target; `lark-cli` is one of those. Access
keys cannot move at all (only their digests are stored), so re-issue one with
`toolhome access-key create <name>` and re-point the harnesses.

## OAuth Upstream Fails After a Migration

**Symptom**: an MCP server that worked on the old instance answers `credential_authorization_required`
or "Invalid client" on the new one.

**Cause**: the OAuth client registration is bound to the instance that created it — the client
metadata URL and the callback both carry `TOOLHOME_PUBLIC_URL` and the credential id
(`/oauth/upstream/client/<id>`, `/oauth/upstream/callback/<id>`). A copied credential therefore
holds a registration the authorization server cannot match. Refresh tokens still work (the
refresh grant sends no `redirect_uri`), but a new authorization needs a new registration.

**Fix**: re-run the migration with `--reset-oauth-clients`, or call
`POST /api/v1/credentials/{id}/reset-oauth-registration`, then
`toolhome credential authorize <name>` on the new instance.

## Aggregate `/mcp` Only Shows `search` and `exec`

**Cause**: Compact tool exposure is enabled. `compact` intentionally replaces the full tool list with the `search`/`exec` discovery pair.

**Fix**: To go back to the full tool list, set `TOOLHOME_MCP_TOOL_MODE=full` (or remove it) on the host, or drop `--tool-mode` from `toolhome mcp stdio` on a node, then reconnect the client. Full mode clears compact-mirrored visibility rows, so no migration is required.

## Compact Mode Misses a Node Server

**Cause**: The local compact catalog covers only servers placed on this node, and a server whose control-plane projection could not be read at startup stays hidden (fail closed).

**Fix**: Reconnect/restart the local entry (`toolhome mcp stdio`) so it re-mirrors the projection. If it still fails, check `toolhome doctor` and the control-plane connection, and confirm the server is enabled and placed on the correct node. The same rules apply when tool visibility was changed on the control plane after the local entry started.

## Nested Discovery Returns Fewer Tools Than Expected

**Cause**: ToolHome `compact` was stacked behind an upstream that already performs its own search/exec or Code Mode, hiding its real tools behind a second discovery layer.

**Fix**: Keep one discovery layer. Use ToolHome `full`/per-server endpoints, or configure the upstream to expose its full tool list. For Cloudflare API MCP, opt out yourself with its documented `?codemode=false` URL; ToolHome never rewrites upstream URLs or query parameters.

## Version Negotiation Probe Failed: `fetch failed` on a Remote Server

**Symptom**: a remote upstream (observed with Notion: `mcp.notion.com`) reports
`Version negotiation probe failed: fetch failed` and the server shows `unreachable`, while the
same URL answers from the host with `curl` (a 401 is fine — that is the auth challenge).

**Cause**: the upstream publishes an **AAAA record**, and Node's `fetch` tries the IPv6 address
first. On a host with no IPv6 route the connection fails (`ECONNREFUSED` from a dual-stack-less
edge, or `ETIMEDOUT`), and `fetch` reports the whole request as failed without trying the working
IPv4 address. Confirmed from inside the deployed container: `fetch` fails while
`curl -4` to the same URL answers in under a second.

**Fix**: the image sets `NODE_OPTIONS=--dns-result-order=ipv4first`, so upstreams with AAAA
records resolve over IPv4. If you override `NODE_OPTIONS`, add
`--dns-result-order=ipv4first` yourself. To confirm the diagnosis on your host:

```bash
docker exec toolhome node -e "fetch('https://mcp.notion.com/mcp',{method:'POST'}).then(r=>console.log(r.status)).catch(e=>console.log(e.cause?.code ?? e.message))"
# ECONNREFUSED / ETIMEDOUT before the fix; 401 after it
```

The 401 is expected without credentials — it proves the connection now works.
