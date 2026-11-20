# Research: One-Step Migration of Local Harness MCP Configs into a Hosted ToolHome

> Goal: let a user move the MCP servers that live in local harness config files
> (Claude Desktop/Code, Cursor, Grok/Codex TOML, …) onto one hosted ToolHome instance in a
> single step, then point every harness at the hosted aggregate `/mcp` endpoint.
>
> Status: research, followed by the implementation it recommended (§5). The gaps below are
> now closed in this tree: `toolhome harness import`, JSON/TOML readers, gateway detection,
> node placement, and the Access Key snippet fix. The research sections stay as written so
> the reasoning and the observed deployment state remain auditable; §5 marks what shipped.

---

## 0. TL;DR

Rows 2 and 3 are what this research found broken before the implementation; §5 lists where
each now lives.

| Migration source                                                                                       | Before this work                                                                                                                                                    | Now                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON `mcpServers` file (`~/.pi/agent/mcp.json`, Claude Desktop, Cursor)                                | Preview + apply existed (`toolhome config import-harness`, `src/cli/main.ts:652`); no placement hint, no gateway detection, no write-back                           | `toolhome harness import` covers read → preview → apply → verify → snippet → `--write-back` (`src/cli/harness.ts`)                                    |
| Harness entries that launch `toolhome mcp stdio` / `toolhome mcp launch`                               | Importing one created a _home_ stdio server running the CLI on the ToolHome host, which double-wraps and needs a Control Key the child does not have                | Recognized as gateways and skipped (`stdioGateway`, `src/config/harness-import.ts:176-217`); `--include-gateways` opts into proxying another instance |
| CLI-native formats other than JSON `mcpServers` (e.g. Grok/Codex `config.toml` with `[mcp_servers.*]`) | `harnessConfigSchema` required a JSON object with the exact key `mcpServers` (`src/config/harness-import.ts:26-43`); a TOML file failed with `Unexpected token 'm'` | Read by `src/config/harness-formats.ts` (JSON `mcpServers` / `servers`, TOML `[mcp_servers.*]`), the same reader behind the console paste box         |

The moving parts for "one step" are all in the tree now: one verb reads the local file(s),
calls the existing preview/apply route, reports the OAuth entries to authorize against the
hosted origin, issues an MCP Access Key, verifies, and prints the exact snippet to paste into
every harness.

## 1. What ships today (verified against this tree)

### 1.1 Generic harness import — JSON `mcpServers`

- Parser: `src/config/harness-import.ts:26-43` — `harnessServerSchema` plus
  `harnessConfigSchema` accept one top-level key, `mcpServers`, mapped to a record of entries.
  Zod strips unknown per-entry keys (`alwaysAllow`, `timeout` pass silently — verified by
  running the shipped parser on such an entry).
- Entry split (`parseHarnessConfigDetailed`, `src/config/harness-import.ts:124-174`): an entry
  with `url` becomes a `remote` server (`parseRemote`, `:265-308`) unless it is the gateway
  itself; otherwise `command` is required and it becomes a stdio server on `home` or on a
  named `node` (`parseStdio`, `:311-377`, `kind` at `:361`).
- Secrets:
  - `Authorization: Bearer X` → encrypted `bearer` credential, stripped from the plaintext
    transport (`src/config/harness-import.ts:278-290`);
  - any other headers → encrypted `headers` credential (`:291-295`);
  - stdio `env` keys matching `SECRET_KEY_RE` (`/password|token|secret|key|authorization/i`,
    `:45`) → encrypted `env` credential (`:330-334`, `:371-374`).
- Market hints: `npx`/`uvx`/`bunx`/… entries whose package matches the curated catalog warn
  that a Market install is more reliable (`:345-356`, `src/market/catalog.ts`).
- HTTP route: `POST /api/v1/config/import-harness` (admin), body `{ config, preview?, mode? }`
  (`src/control/control-api.ts:404-421`); service `importHarnessConfig`
  (`src/control/control-service.ts:942-1005`) with per-entry `created / changed / unchanged /
conflict` outcomes in `create` vs `upsert` mode.
- CLI: `toolhome config import-harness <file> [--preview] [--upsert]`
  (`src/cli/main.ts:652-668`); web console has the same flow
  (`web/src/features/settings/SettingsPage.tsx:142-147, 341-349`).
- Tests: `tests/integration/config.test.ts:137` (preview + import, stdio and remote) and
  `:262` (upsert diffing).

### 1.2 Instance-to-instance migration

- `toolhome migrate --to <url> --to-key <key> [--dry-run] [--with-state]
[--reset-oauth-clients] [--issue-access-key <name>]` (`src/cli/main.ts:749-796`).
- Engine `migrateConfiguration` (`src/cli/migrate.ts:146-418`): exports the source
  (`GET /api/v1/config/export?includeSecrets=true`, `:157`), reinstalls Market entries on the
  target first (provenance, `:239-276`), imports the rest in `merge` mode
  (`POST /api/v1/config/import`, `:228-235`), optionally moves hosted-CLI state volumes
  (`:309-359`), resets OAuth client registrations bound to the source origin (`:366-370`),
  verifies (`/cli/{slug}/status` and `/api/v1/diagnostics`, `:374-402`), and prints a manual
  follow-up list (`manualFollowUps`, `:476-521`).
- Tests: `tests/integration/migration.test.ts` (node placement carried and reinstated,
  `:444`; dry-run idempotence, `:513`; merge-over-differing-credential refusal, `:589`) and
  `tests/unit/migrate.test.ts`.

### 1.3 The hosted target's own moving parts

- **Placement.** A server is `remote`, `home` (runs in the gateway container on the ToolHome
  host) or `node` (runs on a labeled client machine) — `src/domain/models.ts:72`,
  `nodeId` required only for `node` (`src/domain/models.ts:105-116`). The harness importer maps
  stdio → `home`, or → `node` when the caller names one (`--node`, body `node`;
  `src/config/harness-import.ts:361`), and a stored server of a different kind is reported as a
  conflict rather than left mis-placed (`src/control/control-service.ts`, `#applyHarnessUpdate`).
- **Local gateway.** `toolhome mcp stdio` fronts every `node`-placed server of one machine
  over one stdio connection (`src/cli/main.ts:363-424`); `toolhome mcp launch <slug>` runs a
  single one with original tool names (`:343-361`). The local CLI config
  (`~/.config/toolhome/config.json`, `src/cli/main.ts:1050-1052`) holds `url`, `controlKey`, `nodeId`
  (`src/cli/main.ts:36-56`, verified on this machine: `url=https://tool.cyncyn.xyz`,
  `nodeId=R9000P`).
- **Keys.** Control Keys administer; MCP Access Keys authenticate a harness to `/mcp`
  (`toolhome access-key create`, `src/cli/main.ts:604` (mount defined at `:898-911`); issuance in
  `src/security/auth-service.ts:48-60`, digests only in the store,
  `src/storage/sqlite-store.ts:1086-1100`).
- **OAuth, upstream side.** The client registration ToolHome presents to an upstream is bound
  to the instance origin: the client metadata URL and the redirect URI are built from
  `TOOLHOME_PUBLIC_URL` (`src/upstream/oauth-provider.ts:41-46` and `:53-55`); the code documents
  that a credential imported from another instance therefore needs its registration reset
  (`src/upstream/oauth-service.ts:196-205`) via
  `POST /api/v1/credentials/{id}/reset-oauth-registration`
  (`src/control/control-api.ts:354-359`, `src/control/control-service.ts:486-489`), then
  `toolhome credential authorize <name>` on the target.
- **OAuth, inbound side.** Harnesses authorize against the target origin via the data plane's
  OAuth 2.1 server (`src/security/oauth-server.ts:129-135` registration endpoint derived from
  the public URL).

## 2. Migration source taxonomy

Three distinct sources, each with a different "what moves" answer.

### (a) Local JSON `mcpServers` files

What they are: the de-facto generic MCP config shape — a JSON object `mcpServers` whose
entries have `command`/`args`/`env` (stdio) or `url`/`headers` (remote). On this machine:
`~/.pi/agent/mcp.json` (7 entries, keys `url,headers,command,args,env` — structure verified,
values not recorded). Claude Desktop's `claude_desktop_config.json`, Claude Code's
`.mcp.json`, and Cursor's `~/.cursor/mcp.json` use the same shape (neither file exists on
this machine, so their exact local layout is unverified here).

What moves cleanly: URL + headers, stdio command + args + env, secrets → encrypted
credentials, Market suggestions.

### (b) Harness-spawned ToolHome gateway entries

What they are: entries whose `command` is `toolhome` with `args ["mcp","stdio"]` or
`["mcp","launch","<slug>"]` — the local mirror pattern that README.md:187 and
`skills/toolhome/SKILL.md:79-80, 265` recommend. The Grok config on this machine carries a
`toolhome` entry (`url` + `Authorization` header; structure verified).

Why they must not be imported as servers: `parseStdio` would create a stdio server whose
transport is `toolhome mcp stdio` (`src/config/harness-import.ts:311-377`), i.e. the hosted gateway
would try to spawn the CLI on the ToolHome host. That (i) double-wraps the aggregate (a
ToolHome inside ToolHome), (ii) requires a Control Key the child cannot be given
(`TOOLHOME_*` variables are withheld from children, `src/node/launch.ts:4-5, 28-32`), and (iii) was
exactly what a preview of `{"command":"toolhome","args":["mcp","stdio"]}` returned before the
fix: `kind: home`, `warnings: []` — the gateway was not recognized. It is now classified by
`stdioGateway` (`:176-217`) and skipped, so the import drops it and the harness is re-pointed
at the hosted aggregate URL.

### (c) CLI-native harness configs in other formats

What they are: harnesses that keep the same logical shape in TOML, e.g.
`~/.grok/config.toml` `[mcp_servers.<name>]` with `command`, `args`, `env`, `url`, `headers`
(structure verified on this machine; values redacted), and Codex's `~/.codex/config.toml`
(same `[mcp_servers.*]` convention; file absent on this machine).

Before this work they were rejected outright — `harnessConfigSchema` had no `mcp_servers` key
and the CLI read the file with `JSON.parse` (`src/cli/main.ts:1054-1057`), so a TOML file failed
with `Unexpected token 'm'` before the parser was reached, and VS Code's `servers`-keyed JSON
was rejected by the schema (`mcpServers: Invalid input: expected record, received undefined`).
Both are read now: `describePath` sniffs the format, `parseTomlServers` reads
`[mcp_servers.*]`, and `jsonKey` accepts `servers`
(`src/config/harness-formats.ts:163-186` for the format sniff and JSON key, `:316-347` for the TOML reader).

## 3. What is lost, or needs a hand, per source

| Dimension                       | (a) JSON `mcpServers`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | (b) gateway entries                                                                                                                                                                                                   | (c) TOML / other formats                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Secrets**                     | Bearer/headers/env values become encrypted credentials (`src/config/harness-import.ts:278-295`, `:330-334`, `:371-374`). Values written as `${VAR}` placeholders are imported literally — there is no expansion step (`parseHarnessConfigDetailed`, `:124-174`, takes strings as-is), and env vars that only exist in the harness process are unrecoverable.                                                                                                                                                                              | None to move (the entry authenticates to ToolHome itself with an Access Key).                                                                                                                                         | Same rules as (a) _once a TOML reader exists_; until then the user moves secrets by hand. |
| **OAuth registrations**         | A harness usually holds _no_ token for OAuth upstreams (the harness does its own OAuth); the import creates a credential-less `remote` server, so the target must authorize itself: `toolhome credential authorize <name>`, or `reset-oauth-registration` first when a registration was carried over (`src/upstream/oauth-service.ts:195-204`). Cloudflare additionally requires DCR (`urlClientId: false`) — URL-based client metadata fails behind a proxied origin (`skills/toolhome/references/oauth-guide.md:31` and `:86`).         | The harness's own OAuth session against the local gateway is discarded; the harness re-authorizes against the hosted `/mcp` origin on first connect (inbound OAuth server, `src/security/oauth-server.ts:129-135`).   | Same as (a) after parsing.                                                                |
| **Placement (node vs home)**    | A stdio entry defaults to `home`; with `--node <label>` it becomes a `node` server (`src/config/harness-import.ts:361`), and a command that is a local path warns when no node is named (`:380-390`). Without the hint, a server that must run on the user's machine (local Chrome, local Ghidra, this machine's `azure`/`outlook`/`chrome-devtools` entries) is placed on the ToolHome host and stops seeing the local resource.                                                                                                         | The entry itself is dropped and replaced by the hosted aggregate URL; the _node servers behind it_ are already registered on the target, so nothing is lost — provided the node label stays stable (`README.md:203`). | Same as (a).                                                                              |
| **Access keys / endpoint swap** | The harness entry is replaced by one aggregate entry: `{"url":"<target>/mcp","headers":{"Authorization":"Bearer tch_mcp_…"}}`. The Access Key is issued on the target (`POST /api/v1/access-keys`, `src/control/control-api.ts:549-570`) and shown once: the route answers `{key: <record>, secret: <string>}` (`src/security/auth-service.ts:7-10`), and both `migrate --issue-access-key` (`src/cli/migrate.ts:404-427`) and `harness import` (`src/cli/harness.ts`) build the snippet from `secret` with the target's real `/mcp` URL. | Same snippet, but this is the _destination_ state.                                                                                                                                                                    | Same as (a).                                                                              |
| **Dependency availability**     | stdio commands must resolve inside the gateway container for `home` entries (`src/config/harness-import.ts:345-356` warns; Market installs are preferred). `cwd` is carried into the transport (`:26-43` schema, `:364-371`), `enabled: false` is reported, and the remaining per-entry flags (`timeout`, `alwaysAllow`, `type`) are dropped.                                                                                                                                                                                             | n/a                                                                                                                                                                                                                   | Same as (a).                                                                              |
| **What is genuinely lost**      | Tool-side OAuth state held by the harness; `${VAR}` indirection; per-entry flags the harness adds.                                                                                                                                                                                                                                                                                                                                                                                                                                        | The local stdio indirection (replaced by hosted HTTP — that is the point).                                                                                                                                            | Nothing beyond (a), now that the TOML reader exists.                                      |

## 4. One-step flow to the hosted instance

Target used in examples: the live instance (verified, §6). The flow below is expressed with
existing pieces plus two clearly-marked proposed capabilities (§5). `--control-key` is the
target **Control Key** (administers the instance); the Access Key minted in step 4 is what
harnesses use afterwards — they are different keys and only the second appears in harness
configs.

```bash
# 0. Connection: flags or the stored local config
toolhome auth login --url https://tool.cyncyn.xyz --control-key tch_ctl_…   # writes ~/.config/toolhome/config.json (src/cli/main.ts:947-970)

# 1. Preview: which files are read, what would be created, secrets masked,
#    and which entries are the gateway itself rather than servers
toolhome harness import --harness grok --harness cursor --node R9000P --preview

# 2. Apply: secrets become encrypted credentials; --upsert for re-runs
toolhome harness import --harness grok --harness cursor --node R9000P --upsert

# 3. OAuth against the hosted origin (the report names the entries that need it)
toolhome credential authorize cloudflare            # Cloudflare needs DCR on the server record (skills/toolhome/references/oauth-guide.md:31)
toolhome credential authorize notion

# 4. Access key + snippet + verification, and one /mcp entry per harness file
toolhome harness import --harness grok --issue-access-key laptop --write-back
#   → report.accessKey.snippet / .snippetToml, report.verification, report.writtenBack

# 5. Verify on the target
toolhome doctor                                     # GET /api/v1/diagnostics → {ok, servers[], failing[]}
```

The resulting harness entry, identical in every file `--write-back` touched:

```json
{
  "mcpServers": {
    "toolhome": {
      "url": "https://tool.cyncyn.xyz/mcp",
      "headers": { "Authorization": "Bearer tch_mcp_…"" }
    }
  }
}
```

```toml
[mcp_servers.toolhome]
url = "https://tool.cyncyn.xyz/mcp"

[mcp_servers.toolhome.headers]
Authorization = "Bearer tch_mcp_…"
```

**What "one step" means concretely** — `toolhome harness import <file…> --node <id>` (shipped)
collapses steps 1-4 into one command that: parses (a)+(c) with one reader, classifies (b)
entries as gateways instead of servers, applies the import, sets placement per entry, prints
the OAuth entries that need `credential authorize`, mints the Access Key, prints the
verification report, and emits both snippets. The harness file itself is rewritten only with
`--write-back` (a `.bak-<timestamp>` copy is kept); without it the command only prints.

**Dry-run → apply → verification semantics** follow `migrateConfiguration`
(`src/cli/migrate.ts:228-235` dry-run flag, `:374-402` verification, `:476-521` manual
follow-ups) so both verbs report the same way.

## 5. What shipped, and the repo mechanisms it builds on

| Piece                                                                                                                                                                          | Status  | Where                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------- |
| `toolhome harness import [files…]` (`--harness`, `--node`, `--preview`, `--upsert`, `--write-back`, `--issue-access-key`)                                                      | shipped | `src/cli/harness.ts`, wired in `src/cli/main.ts`                                               |
| `toolhome harness list` — known harnesses and whether their config is here                                                                                                     | shipped | `src/cli/harness.ts`                                                                           |
| Generic format layer: JSON `mcpServers` / `servers`, TOML `[mcp_servers.*]`, with a declarative location table (Claude Code, Claude Desktop, Cursor, Codex, Grok, Pi, VS Code) | shipped | `src/config/harness-formats.ts`                                                                |
| Gateway-entry recognition: `toolhome mcp stdio`, `mcp launch <slug>` (also behind npx), a remote URL carrying a `tch_mcp_` key, or an entry pointing at the target origin      | shipped | `src/config/harness-import.ts` (`stdioGateway`, `remoteGateway`)                               |
| Placement hint at import time (`--node`, body `node`)                                                                                                                          | shipped | `src/config/harness-import.ts`, `src/control/control-service.ts`, `src/control/control-api.ts` |
| Snippet from the real `secret` field + real target URL                                                                                                                         | shipped | `src/cli/migrate.ts`, `src/cli/harness.ts`                                                     |
| Write-back of the harness file (JSON object or TOML tables), with a `.bak-<timestamp>` copy                                                                                    | shipped | `src/config/harness-formats.ts` (`renderHarnessFile`)                                          |
| Web-console import UI, now naming gateway entries                                                                                                                              | shipped | `web/src/features/settings/SettingsPage.tsx`                                                   |

The harness location table follows yetone/magpie's `internal/library/targets.go` (one file +
one format per agent). It stays declarative: adding a harness is a row, and the readers are
format-level, so the product boundary in `README.md:12` ("no harness-specific adapters")
still holds.

Tests: `tests/unit/harness-formats.test.ts`, `tests/unit/harness-import.test.ts`,
`tests/unit/harness-cli.test.ts`, `tests/integration/config.test.ts` (node placement +
gateway skip), `tests/unit/migrate.test.ts` (Access Key snippet).

## 6. Observed deployment state (2026-11-20)

The observations below were captured on 2026-11-20 with the commands in this block; the
ones that matter are quoted inline in §6.1. Reproduce with:

```bash
getent hosts toolhome.cyncyn.xyz tool.cyncyn.xyz
curl -v https://toolhome.cyncyn.xyz/ ; curl -v https://tool.cyncyn.xyz/
ssh -o BatchMode=yes Aliyun 'docker ps; docker inspect mcp-home-mcp-home-1 --format "{{.Config.Image}}"'
ssh -o BatchMode=yes Aliyun 'grep -E "^TOOLHOME_PUBLIC_URL" /opt/mcp-home/.env; cat /opt/mcp-home/docker-compose.yml'
ssh -o BatchMode=yes Aliyun 'docker exec 1Panel-openresty-lIsf cat /usr/local/openresty/nginx/conf/conf.d/tool.cyncyn.xyz.conf'
toolhome status --output json      # against the Control Key already stored in ~/.config/toolhome/config.json
```

### 6.1 Verified

- **`https://tool.cyncyn.xyz` is live and is a ToolHome instance.** From this runner: TLS
  handshake succeeds (ZeroSSL ECC certificate, `CN=tool.cyncyn.xyz`), `GET /` → HTTP/2 200,
  `server: openresty`. From the Aliyun host: `dig +short tool.cyncyn.xyz @1.1.1.1` →
  `123.56.83.28`; `curl https://tool.cyncyn.xyz/` → 200 from that IP.

  ```text
  $ curl -sS https://toolhome.cyncyn.xyz/      # from this runner
  curl: (35) TLS connect error: ... unexpected eof while reading
  $ curl -sS -o /dev/null -w '%{http_code}\n' https://tool.cyncyn.xyz/
  200
  $ ssh Aliyun 'docker ps --format "{{.Names}} {{.Image}} {{.Status}}"'
  mcp-home-mcp-home-1 ghcr.io/crayonlu/toolhome:latest Up 6 days (healthy)
  cloudflared-cyni cloudflare/cloudflared:latest Up 7 days
  # /usr/local/openresty/nginx/conf/conf.d/tool.cyncyn.xyz.conf
      proxy_pass http://127.0.0.1:3344;
  ```

- **The Aliyun SSH host works from this runner** (`Host Aliyun` in `~/.ssh/config`,
  BatchMode OK). `docker ps` shows `mcp-home-mcp-home-1` (`ghcr.io/crayonlu/toolhome:latest`,
  healthy, up ~6 days) and `cloudflared-cyni` (up ~7 days).
- **Deployment layout matches CI.** `/opt/mcp-home/docker-compose.yml` builds/runs the image
  with `127.0.0.1:3344:3344` (`docker-compose.yml:7-8` in the repo is identical),
  `/opt/mcp-home/.env` sets `TOOLHOME_PUBLIC_URL=https://tool.cyncyn.xyz`, the host listens on
  `127.0.0.1:3344` (docker-proxy) and `0.0.0.0:80/443` (openresty). This matches
  `.github/workflows/ci.yml`'s deploy job (`.github/workflows/ci.yml:115`): scp into `/opt/mcp-home/build/`
  (`:149-155`), ssh with `DEPLOY_HOST`/`DEPLOY_USER`/`DEPLOY_KEY` (`:159-165`), and
  `docker compose up -d` (`:197`).
- **Reverse proxy.** The openresty vhost `/usr/local/openresty/nginx/conf/conf.d/tool.cyncyn.xyz.conf`
  proxies `tool.cyncyn.xyz` → `http://127.0.0.1:3344` (TLS terminated at openresty with a
  ZeroSSL cert; DNS resolves the Aliyun IP directly, i.e. no Cloudflare orange-cloud proxy in
  front).
- **Live instance inventory** (read-only `toolhome status` / `doctor`, values not secret):
  24 servers — 11 remote, 3 home, 10 node across node labels `crayons-air` (8), `R9000P` (1),
  `crayon-laptop` (1); 4 hosted CLIs; 21 credentials — 8 bearer, 10 env, 1 headers, 2 OAuth
  (`cloudflare`, `notion`, both `ready`); 1 Access Key; 2 Control Keys; `doctor` →
  `{ok: true, database: "ok"}`. The aggregate endpoint answers at
  `https://tool.cyncyn.xyz/mcp` with per-server variants `/mcp/<slug>`.
- **`toolhome.cyncyn.xyz` does not resolve.** `dig +short toolhome.cyncyn.xyz @1.1.1.1` from
  the Aliyun host returns nothing; no openresty vhost and no host-wide reference exists
  (bounded grep over `/opt`, `/etc/nginx`, `/www`, `/root` found nothing). From this runner it
  resolves to `198.18.1.234` — a fake-IP from the local DNS-intercepting proxy (the
  `198.18.0.0/15` benchmark range) — and `curl` fails with exit 35 (`unexpected eof while
reading`). The same proxy answers `tool.cyncyn.xyz` with HTTP 200, which is why origin-side
  facts were cross-checked over SSH.

### 6.2 Unverified / open

- **Which hostname is authoritative.** The objective says the instance is
  `toolhome.cyncyn.xyz`; the deployment, the repo (`README.zh.md`, release notes) and CI all
  use `tool.cyncyn.xyz`. Everything observed says `tool.cyncyn.xyz` is the real origin;
  `toolhome.cyncyn.xyz` has no DNS record at all. If the plan is to _rename_ the public
  origin, that changes `TOOLHOME_PUBLIC_URL` — and per §1.3/§3 it invalidates every upstream
  OAuth registration (Cloudflare included), requiring a `reset-oauth-registration` +
  re-authorization pass on the renamed origin. This is a user decision; the research assumes
  `tool.cyncyn.xyz` until told otherwise.
- **Cloudflare Tunnel role.** `cloudflared-cyni` runs on the host, but its log shows ingress
  for other hostnames (e.g. `cyni.top` → `127.0.0.1:3000`); the tunnel config lives in the
  Cloudflare dashboard (token-based), so its full ingress list is unverified. Nothing observed
  routes `tool.cyncyn.xyz` through the tunnel.
- **Whether the deployed image is current with `main`** (image tag is `:latest`, container up
  ~6 days; the repo's `git log` has newer commits than the last visible deploy).
- **Per-entry details** such as which node servers are used by which harness are not
  observable without reading more user data; the inventory above is deliberately shallow.

### 6.3 Environment limits

This runner's DNS is intercepted by a local proxy (fake-IP `198.18.0.0/15` answers), so
origin-level checks (TLS to the Aliyun IP, reachability of `123.56.83.28` directly) cannot be
made from here; HTTPS checks succeed _through_ the proxy. All origin-side facts above were
therefore cross-checked over `ssh Aliyun` (BatchMode, key-based, works from this runner).

## 7. Risks and open questions

1. **The importer's placement default is wrong for local-capability servers.** Migrating a
   `command`-based Chrome/Ghidra entry as `home` silently breaks it. The one-step verb needs
   the node hint, or an interactive/`--node` mapping; without it, "one-click" migrates the
   wrong half of the config.
2. **Gateway entries double-wrap silently** (§2b probe: no warning today). Even without a
   full importer, adding the classification warning to `parseStdio` is cheap and prevents a
   bad import that currently succeeds.
3. **OAuth is the part that cannot be silent.** Cloudflare/Notion/Linear need DCR on the
   target (`skills/toolhome/references/oauth-guide.md:31-33`); a rename of the public origin invalidates every upstream
   registration. The flow should end with an explicit "re-authorize these N credentials"
   report rather than a green checkmark.
4. **`--issue-access-key` is untested and its parse looks wrong** (§1.3). Verify against the
   real route before building on it.
5. **Secret hygiene in transit.** `config export --include-secrets` exists for instance→
   instance moves, but the harness→target path never needs plaintext secrets on disk; the
   importer already goes straight into encrypted credentials, and the new verb should keep
   that property (no temp files with plaintext).
6. **Multi-file imports.** A user's harnesses disagree (this machine: `~/.pi/agent/mcp.json`
   plus `~/.grok/config.toml`); the same server can appear in both with different commands.
   The flow needs deterministic conflict handling — the existing `upsert` diff
   (`src/control/control-service.ts:1046-1070`) is per-file, so a two-file import needs either a merge
   preview or a documented last-wins rule.

## 8. Non-goals

- Implementing the verb, the TOML reader, or the write-back (follow-up goal).
- Per-harness adapters or auto-discovery of harness directories (product boundary,
  `README.md:12`); paths stay user-supplied and formats stay generic.
- Changing the deployed instance, renaming its origin, or migrating real credentials now.
- Multi-tenant, profile, or workspace concepts.
