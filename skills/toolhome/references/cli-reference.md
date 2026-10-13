# CLI Reference

## auth

```bash
export TOOLHOME_URL="https://tool.cyncyn.xyz"
export TOOLHOME_CONTROL_KEY="tch_ctl_<your-control-key>"
toolhome auth login --url "$TOOLHOME_URL" --control-key "$TOOLHOME_CONTROL_KEY"
toolhome auth logout
```

Credentials saved to `~/.config/toolhome/config.json` (0600). Supports env vars `TOOLHOME_URL`, `TOOLHOME_CONTROL_KEY`, and `TOOLHOME_CONFIG` (an alternate config-file path).

## server

```bash
toolhome server list                          # list all servers
toolhome server get <id>                      # get a server by id
toolhome server add <file|->                  # add from JSON file or stdin
toolhome server update <id> <file|->          # update fields (partial)
toolhome server delete <id>                   # delete a server
toolhome server enable <id>                   # enable
toolhome server disable <id>                  # disable
toolhome server refresh <id>                  # force reconnect + snapshot
toolhome server restart <id>                  # restart home-hosted stdio
toolhome server test <id>                     # test connectivity
toolhome server capabilities <id>             # show capability snapshot
toolhome server status <id>                   # runtime status + last error
toolhome server logs <id>                     # recent log entries
toolhome server endpoint <id>                 # per-server endpoint URL
```

Server JSON (create):

```json
{
  "slug": "firecrawl",
  "name": "Firecrawl",
  "kind": "remote",
  "transport": { "type": "streamable-http", "url": "https://mcp.firecrawl.dev/v2/mcp" },
  "credentialId": "<uuid>",
  "enabled": true,
  "settings": { "urlClientId": false }
}
```

Home-hosted stdio:

```json
{
  "slug": "resend",
  "name": "Resend",
  "kind": "home",
  "transport": {
    "type": "stdio",
    "command": "/data/market/node_modules/.bin/resend-mcp",
    "args": []
  },
  "credentialId": "<uuid>",
  "enabled": true
}
```

## credential

```bash
toolhome credential list                     # list all credentials
toolhome credential get <id>                 # get a credential
toolhome credential add <file|->             # add from JSON
toolhome credential update <id> <file|->     # update
toolhome credential delete <id>              # delete
toolhome credential test <id>                # validate + refresh
toolhome credential revoke <id>              # revoke OAuth tokens
toolhome credential authorize <name>         # start OAuth flow (by name or id)
```

Authorize options:

```
--server <slug>    specify the server (auto-resolved if omitted)
--force            clear old client + re-authorize
--no-open          don't open browser
--no-wait          print URL and exit
--timeout <sec>    wait time (default 600)
```

Credential JSON (create):

```json
{ "name": "firecrawl", "payload": { "type": "bearer", "token": "fc-xxx" } }
{ "name": "apifox", "payload": { "type": "headers", "headers": { "Authorization": "Bearer xxx", "X-Apifox-Api-Version": "2025-09-01" } } }
{ "name": "cloudflare", "payload": { "type": "oauth" } }
{ "name": "resend", "payload": { "type": "env", "variables": { "RESEND_API_KEY": "re_xxx" } } }
```

## access-key

```bash
toolhome access-key create <name>             # returns secret once
toolhome access-key list
toolhome access-key revoke <id>
```

## control-key

```bash
toolhome control-key create <name>            # returns secret once
toolhome control-key list
toolhome control-key revoke <id>
```

## market

```bash
toolhome market list                          # browse catalog with install status
toolhome market install <id>                  # install MCP or CLI; browser URL for missing secrets
toolhome market install <id> --set KEY=value  # non-secret config (repeatable --set)
toolhome market uninstall <id>                # remove MCP server or CLI and credential
toolhome market updates                       # installed vs catalog pin (+ upstream latest)
toolhome market update <id>                   # update to the catalog pin (keeps credential, restarts)
```

## config

```bash
toolhome config export <file>                 # redacted export
toolhome config export <file> --include-secrets  # full backup (0600)
toolhome config import <file>                 # restore (atomic transaction)
toolhome config import <file> --mode merge [--upsert] [--dry-run]
                                              # merge keeps what the target already has
toolhome config import-harness <file> [--preview] [--upsert]
                                              # import a Claude Desktop / Cursor mcpServers JSON;
                                              # secrets become encrypted credentials (never echoed)
```

An export covers `credentials`, `servers` (including `nodeId` placement), `clis` (the hosted
CLI plane) and `installations` (Market provenance, reported but not written by the import).
`--mode create` (default) aborts when the target already has a slug and lists the conflicts;
`--mode merge` reuses credentials by name, skips records the target already holds, and updates
them only with `--upsert`. Credentials whose name matches but whose payload differs are a 409
unless `--upsert` is given, so a re-run is a no-op rather than a silent overwrite.
`--dry-run` returns the same report without writing. The response lists per-item status:

```json
{
  "mode": "merge", "upsert": false, "dryRun": false,
  "credentials": [{ "name": "Azure SP", "status": "reused" }],
  "servers": [{ "slug": "firecrawl", "status": "created" }],
  "clis": [{ "slug": "gh-cli", "status": "skipped", "changes": [] }],
  "installations": [{ "entryId": "gh-cli", "targetType": "cli", "targetSlug": "gh-cli" }],
  "counts": { "created": 2, "reused": 1, "updated": 0, "skipped": 1, "conflict": 0 }
}
```

Harness import accepts `{ "mcpServers": { name: { command, args, env } | { url, headers } } }`.
Secret-looking env keys (password/token/secret/key/authorization) and `Authorization` headers
are stored as encrypted credentials; everything else lands in the server transport.
`--upsert` re-imports as an update: existing servers are diffed (unchanged → skip,
changed → update transport/env/credential) instead of reported as conflicts.

## mcp

```bash
toolhome mcp launch <slug>                    # run one node-placed server (stdio)
toolhome mcp stdio                            # front every node-placed server (stdio)
toolhome mcp stdio --node <id>                # pick a node label (default: config, else hostname)
toolhome mcp stdio --tool-mode <mode>         # full (default) or compact
```

`toolhome mcp launch <slug>` spawns one node-placed server with its stored credential and
hands this process's stdio to it, preserving original tool names. `toolhome mcp stdio` fronts
every server placed on the machine in one stdio connection using `{slug}_{encodedToolName}`
names; children spawn lazily.

`--tool-mode compact` exposes only the `search`/`exec` discovery pair instead of the full tool
list. The mode is independent per entry, so the host aggregate's `TOOLHOME_MCP_TOOL_MODE` and
this flag do not affect each other. Roll back by omitting `--tool-mode` and reconnecting the
client.

## endpoint

```bash
toolhome endpoint aggregate                   # aggregate /mcp URL
toolhome endpoint server <id>                 # per-server /mcp/{slug} URL
```

## diagnostics

```bash
toolhome status                               # overview (servers, credentials, keys, endpoints)
toolhome doctor                               # health check per server
toolhome events                               # recent events
toolhome events --limit 100                   # includes hosted cli.exec audit events
```

## api (raw)

```bash
toolhome api GET /api/v1/openapi.json
toolhome api POST /api/v1/servers --body ./server.json
```

## cli (hosted CLI plane)

Server-side CLI hosting (Form A): register a CLI once on the ToolHome host; client
machines never install or log in to it. Records live in the `clis` table and execs are
audited in the events stream. The web console has a parallel **CLIs** page
(register/edit/delete, enable toggle, and a Run sheet that streams exec output).

```bash
toolhome cli list
toolhome cli get <id>
toolhome cli add ./cli.json
toolhome cli update <id> ./cli-patch.json
toolhome cli enable <id>
toolhome cli disable <id>
toolhome cli delete <id>
toolhome cli status <slug>
toolhome cli exec <slug> -- --version
toolhome cli exec <slug> --timeout 60000 --max-output-bytes 65536 -- <args...>
toolhome cli exec <slug> --stdin-file ./input.txt -- <args...>
toolhome cli exec <slug> --stdin-file - -- <args...>
```

### Moving a login into ToolHome

A platform CLI keeps its login where it likes: `gh` in the macOS keychain, `az` in a token
cache, others in a container volume on the target. Each catalog entry declares how its state
moves, and `adopt` follows that declaration.

```bash
toolhome cli adopt gh-cli                     # one entry, against the configured instance
toolhome cli adopt gh-cli --to https://cloud.example.com --to-key tch_ctl_... [--dry-run]
toolhome cli sync --to https://cloud.example.com --to-key tch_ctl_... [--dry-run]
                                              # every installed CLI entry on the target
```

Outcomes per entry: `adopted` (credential handed over and accepted), `already-authenticated`,
`credential-only` (the entry authenticates from injected credential values, which travel with
a configuration export), `manual` (the login cannot move — the entry says what to run on the
target), `undeclared`, `failed`. The extracted secret is written to the target's `exec` stdin
and is never printed, logged or returned.

### Moving a state volume

```bash
toolhome cli export-state gh-cli --volume toolhome-gh-cli-state > gh-state.json
toolhome cli import-state gh-cli gh-state.json --volume toolhome-gh-cli-state
```

Both go through the control API (`GET|POST /api/v1/clis/{id}/state?volume=<name>`) with the
archive as base64. Only a `docker`-mode record with a declared, writable volume of that name
is accepted; archives are capped at 64 MiB. **The archive contains the CLI's credentials.**
The gateway needs the host Docker socket (already required for `executionMode: docker`) and
pulls `alpine:3.20` on first use. Tools such as `offen/docker-volume-backup` cover the same
ground if you prefer to move volumes yourself.

`--stdin <text>` and `--stdin-file <path|->` are mutually exclusive. Put platform arguments after `--`; timeout is in milliseconds and cannot exceed the record's limit. Human output streams stdout/stderr; `--output json` emits NDJSON frames and an outcome. A failed or timed-out remote execution exits locally with code 1. Ctrl-C cancels the stream.

```bash
# registry (Control API, admin key)
toolhome api GET  /api/v1/clis                       # list registered CLIs
toolhome api POST /api/v1/clis --body ./cli.json      # register (201); prefer Market for Azure bootstrap
toolhome api GET  /api/v1/clis/<id>                  # fetch
echo '{"enabled":false}' | toolhome api PATCH /api/v1/clis/<id> --body -
toolhome api DELETE /api/v1/clis/<id>                # delete
```

Exec and status live on the data plane (`POST /cli/{slug}/exec`, `GET /cli/{slug}/status`):

```bash
# exec: argv array only — never a shell string; body must be JSON
toolhome cli exec azure-cli --timeout 30000 -- account show -o table
# → 200 NDJSON stream: {"type":"stdout","data":...} {"type":"stderr","data":...}
#   {"type":"exit","code":0,"durationMs":4211,"result":"ok"}
# timeout → {"type":"exit","code":null,"durationMs":...,"result":"timeout"}
# truncated output → exit frame carries "truncated":true

toolhome api GET /cli/azure-cli/status
# → { "installed":true, "version":"azure-cli 2.x", "loggedIn":true, "lastCheckedAt":"..." }
```

Semantics:

- **argv array only**: `spawn(command, argv)` with no shell; a shell string is rejected (400).
- **Allow-list**: `deny` rules are evaluated first; a non-empty `allow` list must match at
  least one rule (`*` matches one argv token, rules match as argv prefixes). Denied argv is
  rejected with 403 before any process is spawned.
- **Credential materialization**: MCP and hosted CLI entries share the encrypted credential
  payload format. CLI bindings project `env:<name>`, `token`, `value`, `header:<name>`, or
  `accessToken` into the process environment. OAuth uses its stored access token and returns
  `credential_authorization_required` until authorization is complete.
- **Env injection**: every exec gets `CI=true`, `NO_COLOR=1`, `PAGER=cat`, `TERM=dumb`
  (unless the record sets `interactive: true`), plus the bound credential variables.
- **Status probe**: the declared `probe.command` runs in the same context; its stdout is
  parsed as `version=...` / `loggedIn=true|false` lines; `installed` = exit code 0.
- **Isolation**: `executionMode: 'host'` spawns on the ToolHome host (trusted entries);
  `'docker'` spawns a one-shot sibling container (`docker run --rm -i <image> <argv…>`).
  `containerVolumes` are explicit Docker named volumes forwarded with `--volume`; bind paths,
  duplicate targets, and host credential directories are rejected.
  credential directories are never mounted implicitly. `authStrategy: "azure-service-principal"`
  performs a fixed `az login --service-principal` bootstrap from bound environment variables,
  while `authStrategy: "tailscale-auth-key"` starts an in-container userspace `tailscaled` and performs a fixed `tailscale --socket=... up --auth-key` bootstrap.
  Catalog entries may use npm, Go, GitHub Release, uv, or Docker installer backends, but those
  backends are hidden implementation details rather than separate Market products.
- **Audit**: every exec appends a `cli.exec` event (slug, argv, exit code, duration) visible
  via `toolhome events` / `GET /api/v1/events`.

## migrate

```bash
toolhome migrate --to https://cloud.example.com --to-key tch_ctl_... [options]
```

Copies this instance into another one. The source is whatever the command already resolves
(`--url`/`--key`, `TOOLHOME_URL`/`TOOLHOME_CONTROL_KEY`, or `~/.config/toolhome/config.json`);
the target is `--to`/`--to-key`. Both keys must be admin-scoped.

| Option | Effect |
| --- | --- |
| `--planes <mcp,cli>` | Which planes to move (default both) |
| `--dry-run` | Report what would change without writing to the target |
| `--with-state` | Also move each hosted CLI's state volume (contains credentials) |
| `--reset-oauth-clients` | Clear OAuth client registrations that point at the source origin |
| `--issue-access-key <name>` | Issue an MCP Access Key on the target and print the harness snippet |

Order is deliberate: Market entries are **reinstalled first** (each one provisions its own
credential, record and installation record at its pinned version, using values harvested from
the exported credential), then the configuration import runs in `merge` mode and skips what
the Market already created. Reinstalling needs the entry's values; `--set`-style values are
harvested from `env` variables, `bearer` tokens, `api-key` values and `headers` entries. An
OAuth entry has no harvestable value, so it is reported as needing authorization on the target.

The report ends with what still needs a human: every `access-key` (stored as a digest, so it
cannot be copied), every hosted CLI that reports no login state, every Market entry that needs
a secret or failed, and every OAuth credential whose registration was left in place.

```json
{
  "dryRun": false,
  "source": { "servers": 2, "clis": 1, "credentials": 1, "installations": 1 },
  "target": { "servers": 0, "clis": 0, "credentials": 0 },
  "reinstalls": [{ "entryId": "gh-cli", "plane": "cli", "status": "installed" }],
  "imported": { "counts": { "created": 2, "skipped": 1 } },
  "stateTransfers": [{ "slug": "gh-cli", "volume": "toolhome-gh-cli-state", "status": "moved", "bytes": 412 }],
  "verification": { "clis": [{ "slug": "gh-cli", "installed": true, "version": "gh 2.97.0", "loggedIn": true }], "mcpOk": true },
  "oauthRegistrationsReset": [],
  "accessKey": null,
  "manual": ["Access keys are stored as digests and cannot be moved: …"]
}
```

## global options

```
--url <url>           control API URL (or TOOLHOME_URL env)
--key <key>           control key (or TOOLHOME_CONTROL_KEY env)
--output <human|json> output format (default human)
```
