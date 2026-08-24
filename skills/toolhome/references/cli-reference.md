# CLI Reference

## auth

```bash
toolhome auth login --url https://mcp.example.com --control-key "$KEY"
toolhome auth logout
```

Credentials saved to `~/.config/toolhome/config.json` (0600). Supports env vars `MCP_HOME_URL` and `MCP_HOME_CONTROL_KEY`.

## server

```bash
toolhome server list                          # list all servers
toolhome server get <id>                      # get a server by id
toolhome server add <file|-                   # add from JSON file or stdin
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
  "transport": { "type": "stdio", "command": "/data/market/node_modules/.bin/resend-mcp", "args": [] },
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
toolhome market install <id> --set KEY=value  # install (repeatable --set)
toolhome market uninstall <id>                # remove server + credential
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
toolhome events --level error                 # filter by level
```

## api (raw)

```bash
toolhome api GET /api/v1/openapi.json
toolhome api POST /api/v1/servers -d '{"slug":"test",...}'
```

## global options

```
--url <url>           control API URL (or MCP_HOME_URL env)
--control-key <key>   control key (or MCP_HOME_CONTROL_KEY env)
--output <human|json> output format (default human)
```
