# ToolHome v0.6.14

ToolHome can move itself. `toolhome migrate` copies both planes — MCP servers and hosted CLIs, with their encrypted credentials — into another instance, and `toolhome cli adopt` moves a platform CLI's login from the machine that already has it. Configuration export/import grew the CLI plane, placement, and Market provenance, and learned to merge instead of refusing.

## Export and import

- `config export` now covers the **CLI plane** (`clis`), server **placement** (`nodeId`), and Market provenance (`installations`). Previously a configuration containing a node server could not be restored at all: the export dropped `nodeId`, so import failed placement validation with `Node servers require a nodeId` and rolled the whole transfer back.
- `config import --mode merge` makes a restore idempotent: credentials are matched by name and reused when their payload is identical, records the target already holds are skipped, and `--upsert` updates them field by field (transport, args, env, placement, settings, hosted CLI runtime and allow-list). A credential whose name matches but whose payload differs is a `409` unless `--upsert` is given, so a re-run is a no-op instead of a silent overwrite.
- `config import --dry-run` returns the same per-item report without writing. The response now lists every item with a status (`created`, `reused`, `updated`, `skipped`, `conflict`) plus counts.
- `create` mode keeps its old behaviour: it aborts on a slug the target already has and now names every clash instead of failing at the first one.

## Migration

- **`toolhome migrate --to <url> --to-key <key>`** copies this instance into another one. Market entries are reinstalled on the target first, at their pinned versions, with values harvested from the exported credentials (`env`, `bearer`, `api-key`, and `headers` shapes), so the target keeps its own installation records and version tracking; the configuration import then merges and leaves them alone. Per-entry reinstall failures are reported, not fatal.
- `--dry-run` reports without writing, `--planes mcp,cli` narrows the scope, `--issue-access-key <name>` issues an MCP Access Key on the target and prints the harness snippet, and `--with-state` also moves each hosted CLI's state volumes.
- The report ends with the work that needs a human: access keys (digests only, never copyable), hosted CLIs that report no login state, Market entries awaiting a secret, and OAuth credentials whose client registration still points at the source origin.

## Hosted CLI logins

- **`toolhome cli adopt [slug]`** and **`toolhome cli sync`** move a locally authenticated platform CLI into an instance. Each catalog entry declares how its state moves, so the outcome is explicit per entry: `adopted`, `already-authenticated`, `credential-only` (values travel with a configuration export), `manual` (the entry names the command to run on the target), `undeclared`, or `failed`. The extracted secret goes to the target's `exec` stdin and is never printed, logged, or returned. `gh-cli` extracts with `gh auth token` (macOS keeps the token in the keychain, so `hosts.yml` holds none) and imports with `auth login --with-token`, which its allow list already permits.
- **`toolhome cli export-state` / `import-state`** move one declared container volume as a base64 tar archive through `GET|POST /api/v1/clis/{id}/state?volume=<name>`. Only a `docker`-mode record with a declared, writable volume is accepted, archives are capped at 64 MiB, and every transfer is audited. The archive contains the CLI's credentials.
- New admin endpoint `POST /api/v1/credentials/{id}/reset-oauth-registration` clears an OAuth client registration bound to another origin while keeping tokens.

## Fixed

- A configuration export containing a node-placed server can be imported again; the transfer no longer aborts with `Node servers require a nodeId`.
- A secondary import into a non-empty instance reports its conflicts instead of a bare `slug_conflict`.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.6.14`. CLI: `npm install -g toolhome@0.6.14`.

No schema migration and no environment changes. The export format is additive and `version` stays `1`, so new files load in older instances with the new sections ignored — but the target instance must run this version or later to receive `clis` and `installations`. `POST /api/v1/config/import` accepts the new `mode`, `upsert`, and `dryRun` fields; without them it behaves exactly as before.

## Validation

Server typecheck and 349 tests (including a two-instance transfer suite and the migration orchestrator), web typecheck, 31 web tests, and both production builds. Covered end to end: node placement and the CLI plane surviving export/import, merge idempotency, dry runs, credential-conflict refusal, the state-transfer guard rails, the migration order (install before import), value harvesting, and adopt outcomes.

Not covered by CI: the state archive itself needs a Docker host, so the tar helper is tested with an injected process and the full volume round trip is a manual step.
