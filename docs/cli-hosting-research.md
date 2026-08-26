# Research: Server-side CLI Hosting for ToolHome

> Goal: expand the product form so that CLIs (`az`, `gh`, internal tools, …) are hosted on the
> ToolHome server, so no client machine needs to install or log in to them. This plane is a
> **sibling of MCP hosting**, not a dependency on it.
>
> Status: historical research/design note. The implemented v1 follows the Form A direction
> below; later sections retain future-login ideas and operational follow-ups.

---

## 1. Product forms compared

### Form A — First-class CLI plane, parallel to MCP (recommended)

A dedicated registry and execution API beside the existing MCP planes:

```
Control:   POST /api/v1/clis            register a CLI (slug, image/command, allow-list, credentialId)
           GET  /api/v1/clis/{slug}     status incl. version + login-state probe result
Data:      POST /cli/{slug}/exec        { argv[], stdin?, timeoutMs? } → NDJSON stream
Status:    GET  /cli/{slug}/status      { installed, version, loggedIn, lastCheckedAt }
Lifecycle: install/upgrade jobs reuse the Market InstallJob machinery
```

The CLI is a first-class entity: its own table, its own exec endpoint, its own status model,
its own console page. An agent-facing bridge (one generic MCP server exposing `cli_list` /
`cli_exec`) can be layered on top later as a _consumer_ of this plane — but nothing about the
plane depends on MCP semantics.

- ✅ Preserves CLI-native semantics: exit codes, stdout/stderr separation, streaming NDJSON,
  long-running commands with timeouts — none of which survive an MCP tools/list JSON-Schema
  projection
- ✅ No per-CLI wrapper to maintain; adding a CLI is a config entry, not a code artifact
- ✅ Honest product boundary: "ToolHome hosts remote MCP servers **and** server-side CLIs"
- ⚠ New surface area: second data-plane verb family, second status model, console work

### Form B — Wrap each CLI as an MCP server (rejected)

Every CLI gets a wrapper MCP server whose single tool takes free-text argv.

- ❌ Loses exactly what CLIs are: exit codes collapse into text, stderr mixes into content,
  timeouts/streaming are per-wrapper reinventions, `tools/list` schemas are lies for free-form
  CLIs
- ❌ N wrappers = N maintenance artifacts; adding a CLI becomes a code release instead of a
  config entry
- ❌ Pollutes agent tool namespaces with one opaque "run arbitrary args" tool per CLI
- Verdict: this is the "CLI depends on MCP" model explicitly rejected when scoping this work.
  It remains viable only as the thin _consumer_ bridge on top of Form A.

### Form C — Browser/gateway terminal (Azure Cloud Shell style)

Expose a persistent PTY session over WebSocket (ttyd/gotty-style) behind Home auth.

- ✅ Full fidelity: interactive prompts, TUI apps, anything a real shell does; great for
  human-driven ad-hoc work from the web console
- ✅ Strong prior art (Cloud Shell proves demand for "authenticated shell in the browser")
- ❌ Session-oriented, not API-oriented: harnesses/agents cannot consume a PTY cleanly
- ❌ Persistent sessions conflict with the containerized-execution model (Form A's isolation),
  and session reattachment/persistence is its own subsystem
- Verdict: valuable as a **later console add-on** for humans debugging login state, not as the
  core product form. Keep out of scope for v1.

### Recommendation: **Form A**, with Form C as an optional future console feature and Form B

demoted to a consumer-side bridge. Rationale: the user's stated goal is "托管，防止每台 client
机器都装 CLI" — that goal is served by a programmatic exec API with central login state, which
is precisely Form A. Forms B and C either distort CLI semantics into MCP or optimize for a
human-at-a-browser workflow that is secondary here.

---

## 2. Recommended form — concrete feature sketch

All mechanisms cited below exist in this repo today; the sketch composes them.

### 2.1 Registry & storage

New `clis` table mirroring the shape of `servers`: `id, slug, name, image|command,
commandAllowList (JSON), credential_id, enabled, created_at, updated_at`. Storage patterns to
copy are already in `src/storage/sqlite-store.ts`, which creates and migrates
`install_jobs` (see the `CREATE TABLE IF NOT EXISTS install_jobs` block at ~line 436 and the
guarded `'updating'` status migration at ~line 474) — the same guarded-migration approach
applies when the `clis` table gains new columns later.

### 2.2 Exec API semantics

```
POST /cli/{slug}/exec
{
  "argv": ["vm", "list", "-o", "table"],   // required; NOT a shell string — argv array only
  "stdin": null,                            // optional string piped to the process
  "timeoutMs": 60000                        // default from CLI record; hard cap configurable
}
→ 200 NDJSON stream:
  {"type":"stdout","data":"..."}
  {"type":"stderr","data":"..."}
  {"type":"exit","code":0,"durationMs":4211}
```

Rules:

- **argv array, never a shell string** — no `/bin/sh -c`; each argument is passed verbatim via
  `spawn(binary, argv)` exactly as `src/market/market-service.ts` already spawns
  `docker` / `uv tool install` / `npm install` (spawn sites at lines ~540, ~594, ~632)
- Streaming NDJSON keeps long commands responsive; the response ends with the `exit` frame
- Timeout kills the child (SIGTERM → SIGKILL grace), reported as `{"type":"exit","code":"timeout"}`
- Output size cap (e.g. last N KB retained + truncation flag) to protect memory
- Concurrency per CLI bounded like server settings' `maxConcurrency`

### 2.3 Install / upgrade lifecycle

Reuse the Market job pattern end-to-end: `InstallJobRecord` +
`secure_actions`-backed progress reporting already give async jobs with live step logs and a
console progress view (`src/market/market-service.ts`). A `cli install` job is the same shape:
pull image (`docker pull`) or fetch package, pin the version (the catalog's pinned-version
discipline in `src/market/catalog.ts` applies verbatim), report steps, land in `installed`.

### 2.4 Execution isolation

Default execution mode is a **one-shot sibling container**: `docker run --rm -i <image> <argv…>`
with only declared Docker named volumes and credential environment variables forwarded. The host
path is proven: `docker-compose.yml` mounts `/var/run/docker.sock` into the container and sets
`group_add: ${DOCKER_GROUP_ID}` precisely so the runtime user may drive sibling containers
(this is how Docker-backed Market entries run today, via the spawn site above). Host-process
execution stays available as an explicit opt-in for trusted entries (same trust decision the
catalog makes for `home-stdio`). Hosted CLI records reject bind paths and duplicate volume
mount targets; platform-specific bootstrap strategies are limited to supported Docker entries.

The Dockerfile already ships the two runtimes CLIs need (`uv`/`uvx` for Python-based tooling,
`docker` CLI, plus `curl` — see the `apk add` layer in `Dockerfile`, which also supports the
`APK_MIRROR` build arg used for the Aliyun host). Heavier CLIs (azure-cli) install as their own
images per-CLI rather than bloating the base image.

### 2.5 Command allow-listing

Each CLI record carries a declarative allow-list evaluated against `argv[0..n]`:

```jsonc
{
  "allow": [
    ["vm", "*"],
    ["account", "show"],
    ["webapp", "log", "tail", "*"],
  ],
  "deny": [["login"], ["login", "--service-principal"], ["account", "clear"]],
  "interactive": false, // enforced: CI=true, NO_COLOR=1, PAGER=cat injected into env
}
```

- Default posture: read-only-ish subcommands allowed, mutating verbs denied until enabled
- Non-interactive enforcement is centralized: env `CI=true`, `NO_COLOR=1`, `PAGER=cat`,
  `TERM=dumb` injected on every exec, since CLIs otherwise page/prompt/colorize unpredictably
- Every exec is recorded in the events stream (server id/slug, argv, exit code, duration) —
  the same event discipline the rest of the app uses
- Scope note (per non-goals): this is the entire security treatment in v1 — no RBAC, no
  per-principal quotas, no egress filtering. It is a trust-the-operator product.

### 2.6 Status & login-state probing

`GET /cli/{slug}/status` runs the CLI's declared probe command inside the same isolated
context and returns structured fields:

```jsonc
{ "installed": true, "version": "azure-cli 2.x", "loggedIn": true, "lastCheckedAt": "..." }
```

Probes are declared per-CLI (e.g. azure-cli: `["version"]` and `["account","show"]`;
gh: `["auth","status"]`). The web console renders this as a "login state" card with a
re-login action that starts the auth flow from §3. Probe results also feed health surfacing
alongside server runtime state.

---

## 3. Headless auth lifecycle (the riskiest part)

Two concrete approaches, both grounded in the existing credential system
(`src/upstream/credential-resolver.ts` resolves payloads to `{ headers, env }` today; the
`env` case returns `payload.variables` — CLI hosting consumes exactly this hook):

### Approach 1 — Service principal / static creds via existing Env Credential (recommended first)

For Azure: create a service principal once, store `AZURE_CLIENT_ID / AZURE_TENANT_ID /
AZURE_CLIENT_SECRET` as an **Env Credential** (payload type `env` — see the `case 'env'`
branch returning `payload.variables` in `credential-resolver.ts`). At exec time these are
injected into the container environment; `az` picks them up natively (`AZURE_*` is the
documented non-interactive path — Microsoft's own docs describe service-principal login via
environment variables, and Azure MCP Server documents `AZURE_TOKEN_CREDENTIALS="prod"` to
skip interactive credential chains).

- ✅ Zero new machinery: credential CRUD, encryption (AES-256-GCM SecretBox), and injection
  all exist; token refresh is handled entirely by the CLI/SDK against the SP secret
- ✅ Works headless forever; survives container restarts because secrets live in SQLite, not
  in container state
- ⚠ Long-lived client secret (rotation policy is the operator's problem); some CLIs lack any
  non-interactive auth mode and cannot use this path

### Approach 2 — Device-code login bridged through SecureAction (future work)

The current v1 implementation does not add a second CLI OAuth/device-code transport. A future
version could extend `secure_actions` with a `cli_login` kind and run a per-platform device-code
flow inside the exec context, but that requires a poller and platform-specific login semantics.

- The SecureAction record (URL + expiry + status) could carry a future device-code flow, but
  a poller and platform-specific login semantics are still required.

Token-cache durability note: a future device-code flow would need a persistent named volume
(for example `cli-state-{slug}:/home/cli/.config/tool`) so tokens survive container restarts.

---

## 4. External prior art

| Product / model                                                                              | Link                                                                                   | What we take                                                                                                                                                                       | What we reject                                                                                                                          |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Azure Cloud Shell** — authenticated browser shell pre-logged into Azure                    | https://azure.microsoft.com/en-us/get-started/azure-portal/cloud-shell                 | Central authenticated CLI, zero local setup; login state lives server-side — the exact UX end-state we want                                                                        | Session/PTY-centric delivery and Azure-only scope; we want an API-first plane covering many CLIs                                        |
| **Teleport** (`tsh`) — identity-aware access proxy with certificate auth + session recording | https://goteleport.com/how-it-works/                                                   | Declarative access rules per resource, audit/event recording of every execution, short-lived access concepts                                                                       | Enterprise SSH/K8s proxy positioning, heavyweight CA infrastructure — far beyond a single-user self-hosted gateway                      |
| **Desktop Commander MCP / shell-mcp family** — MCP servers exposing terminal exec            | https://github.com/wonderwhy-er/desktopcommandermcp                                    | Proof that agents want command execution; streaming output and timeout handling patterns                                                                                           | Local-machine orientation and raw shell-string execution with no registry/allow-list/central login — this is Form B's dead end at scale |
| **Smithery** — hosted MCP registry + installer with cloud-hosted servers                     | https://smithery.ai/                                                                   | Registry + managed-runtime + one-command install UX; version pinning discipline                                                                                                    | MCP-server-only scope; no CLI plane, and hosted-SaaS assumptions don't fit self-hosted                                                  |
| **Azure MCP Server** — official stdio MCP over az credentials                                | https://github.com/microsoft/mcp/blob/main/servers/Azure.Mcp.Server/TROUBLESHOOTING.md | Confirms the auth reality we must solve: even official MCP needs `~/.azure` mounted into containers (their documented docker volume mount) or `AZURE_TOKEN_CREDENTIALS` env config | Per-tool MCP wrapping as the general strategy for every CLI (N-wrappers problem, Form B)                                                |

---

## 5. Phased roadmap

### Phase 0 — Kill the riskiest assumption first (headless CLI auth in the deployed container)

On the Aliyun host, inside the real deployment topology:

1. Run the pinned Azure image with the current fixed service-principal bootstrap and named `/root/.azure` volume; verify `az account show` succeeds in the deployed sibling-container topology
2. Restart the container; verify the state volume remains usable without importing a local profile
3. Repeat with an Env-Credential-injected service principal (`AZURE_*` env vars) after rotating the stored secret
4. Measure cold-start cost (`az version` after fresh pull) to decide image-per-CLI vs shared base

Exit criteria: the service-principal path demonstrably survives restart; timing numbers are
recorded. Device-code login remains future work and is not part of the current v1 runner.

### Phase 1 — Minimal CLI plane (Form A core)

- `clis` table + control endpoints (register/list/status/delete)
- `POST /cli/{slug}/exec` with argv-only spawn, NDJSON streaming, timeouts, size caps
- One pilot CLI: azure-cli via sibling container + Env Credential (Approach 1)
- Events recorded per exec
- Hosted CLI catalog entries for Azure, GitHub, and Tailscale with pinned Docker images,
  explicit credential bindings, and read-only argv policies

### Phase 2 — Lifecycle & login UX

- Install/upgrade jobs on the Market InstallJob pattern (progress steps, console progress)
- Login-state probes + `cli_login` SecureAction kind (Approach 2) with console re-login flow
- Allow-list editor in the console

### Phase 3 — Ecosystem polish

- Second/third CLI entries (gh, kubectl, internal tools) to prove generality
- Optional consumer bridge: one generic MCP server exposing `cli_list`/`cli_exec` against the
  exec API (MCP adapts to the CLI plane, never the reverse)
- Optional Form C terminal view in the console for human debugging

### Explicitly out of scope (per goal)

Security hardening beyond the allow-list/audit/isolation constraints noted in §2.5;
multi-tenancy; changes to existing MCP data/control plane behavior.

---

## Appendix A — In-repo mechanism index (citation map)

| Mechanism                                                      | Location                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| Sibling-container execution (docker.sock mount, group_add)     | `docker-compose.yml`                                           |
| `uv`/`uvx`/`docker`/`curl` in image, `APK_MIRROR` build arg    | `Dockerfile`                                                   |
| Async install jobs table + guarded migration                   | `src/storage/sqlite-store.ts` (`install_jobs`, ~line 436/~474) |
| Job execution via spawned `docker`/`uv`/`npm`                  | `src/market/market-service.ts` (~lines 540/594/632)            |
| Catalog entry kinds incl. `docker`, pinned versions            | `src/market/catalog.ts`                                        |
| URL-collected secret/action records (`market_install` kind)    | `src/domain/models.ts` (`secureActionRecordSchema`, ~line 473) |
| Credential payload resolution to `{headers, env}` (env branch) | `src/upstream/credential-resolver.ts` (~line 48)               |
