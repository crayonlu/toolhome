# ToolHome v0.7.2

One deployment fix, found while adding a Penpot upstream.

## Remote upstreams on dual-stack hosts connect reliably

0.6.19 set `--dns-result-order=ipv4first` so upstreams with AAAA records resolve over IPv4. That
was not enough: with Node's happy-eyeballs still enabled, a fast IPv6 failure can abort the whole
connection before the working IPv4 attempt finishes. The symptom is `ETIMEDOUT` after roughly half
a second from a fresh process, for a host that `curl` reaches in 300 ms — and it is intermittent,
because a long-lived process reuses a connection that once succeeded. Measured inside the deployed
container against `design.penpot.app`:

| `NODE_OPTIONS` | result |
| --- | --- |
| `--dns-result-order=ipv4first` (0.6.19) | `ETIMEDOUT` ~0.7 s |
| `--no-network-family-autoselection` | `HTTP 200` |
| both | `HTTP 200` |

The image and compose file now set
`NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"`. This also explains
the intermittent `fetch failed` seen earlier on Notion (about 4 of 10 fresh processes failed while
a warm process succeeded 10 of 10).

Override `NODE_OPTIONS` on an IPv6-native deployment; keep both flags on an IPv4-only one.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.7.2`. CLI: `npm install -g toolhome@0.7.2`.

No schema, API or configuration changes beyond that environment value. The manifest's accidental
self-dependency (`toolhome` on itself) was removed.

## Validation

Server typecheck and 393 tests. The flag combination was measured against
`design.penpot.app` inside the deployed container before and after, and a remote MCP server that
had been reporting `Version negotiation probe failed: fetch failed` connects with it.
