# ToolHome v0.6.16

The console's servers page separates placement.

## Servers page

- A second-level menu under the plane switch groups MCP servers by where they run: **All**, the
  **ToolHome host** (remote and home servers), and one entry per **node machine**. Counts sit on
  each entry, and the menu only appears once a node machine exists, so a single-machine
  installation looks exactly as it did.
- A `node` server row no longer shows a bare `node` badge: it names its machine (`node ·
  crayons-air`), on the list and on the detail header. Previously a client-machine server was
  indistinguishable from a remote endpoint at a glance.
- The web types knew only `remote | home`; `node` and `nodeId` are now part of `ServerRecord`, so
  the console can classify a server it used to render as an untyped extra kind.

Selecting a machine the instance no longer has falls back to showing everything rather than an
empty list.

Known gap, unchanged here: the server form still offers only `remote` and `home`, so a node
server is created through the CLI or the API.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.6.16`. CLI: `npm install -g toolhome@0.6.16`.

No schema, API or environment changes; the console ships inside the image.

## Validation

Web typecheck, 45 web tests (11 new: grouping, counts, ordering, per-machine filtering, and the
menu driving the list), production build. Server typecheck and 380 tests unchanged. Grouping was
also run against the live instance's 19 servers: 12 host, 6 on `crayons-air`, 1 on `R9000P`, and
no node server in the host group.
