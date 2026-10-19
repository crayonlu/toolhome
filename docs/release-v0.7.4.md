# ToolHome v0.7.4

The call ledger now names what actually ran, and the console ships with each deploy.

## Calls: the tool that ran, not the wrapper that exposed it

Compact endpoints expose every upstream tool as `exec`, so a ledger row led by the exposed name
read `exec` for everything and hid the only useful part. Rows now lead with the identity — the
server slug and the upstream tool:

```
penpot / execute_code
penpot / export_shape   penpot_export-5fshape
CLI gh-cli / auth status
```

The compact wrapper (`exec`, `search`) is dropped from the row; a differing aggregate identifier
is still shown muted, since that is what a caller sent on a direct aggregate call. Hosted CLI
calls read as slug and command. Statistics already grouped by the upstream name and are unchanged.

## Deploys ship the console

The deploy job runs in its own checkout while `dist/` and `web/dist/` are gitignored, so the
artifact step copied nothing and the deployment host kept rebuilding from whatever console build
it already had. This went unnoticed because a manual transfer had seeded it. The docker job now
uploads both directories and the deploy job downloads them before shipping, so the console in a
deployed image matches the commit.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.7.4`. CLI: `npm install -g toolhome@0.7.4`.

No schema or API changes.

## Validation

Web typecheck, 65 tests (4 new: compact row identity, direct aggregate identifier, CLI row, and no
bare `exec` label), production build. Server typecheck and 393 tests unchanged. The deployed
bundle hash is checked against the local build after the deploy.
