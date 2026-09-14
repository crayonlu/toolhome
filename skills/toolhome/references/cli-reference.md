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
toolhome config import-harness <file> [--preview] [--upsert]
                                              # import a Claude Desktop / Cursor mcpServers JSON;
                                              # secrets become encrypted credentials (never echoed)
```

Harness import accepts `{ "mcpServers": { name: { command, args, env } | { url, headers } } }`.
Secret-looking env keys (password/token/secret/key/authorization) and `Authorization` headers
are stored as encrypted credentials; everything else lands in the server transport.
`--upsert` re-imports as an update: existing servers are diffed (unchanged → skip,
changed → update transport/env/credential) instead of reported as conflicts.

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

## global options

```
--url <url>           control API URL (or TOOLHOME_URL env)
--key <key>           control key (or TOOLHOME_CONTROL_KEY env)
--output <human|json> output format (default human)
```
