# ToolHome v0.6.19

Three fixes observed in real use of the compact discovery surface and a deployed upstream.

## Compact `describe` no longer dead-ends on oversized definitions

A tool whose complete contract exceeds the 16 KiB describe budget (observed: Firecrawl's
`firecrawl_search` at 19 KB, its `scrapeOptions` block alone being 2.4 KB) returned
`definition_too_large` at every turn: `find` with `detail=definition` marked it
`needsDescribe`/`definitionTooLarge`, and `describe` failed with the same budget — the caller
could never obtain the argument contract through compact discovery at all.

`describe` now degrades instead:

- The schema is shrunk to a faithful outline — every top-level argument kept with its type,
  clamped description and `required` list, nested objects collapsed one level. Firecrawl's
  contract compresses to about a third, which fits.
- Oversized upstream instructions are truncated at 400 characters with a marker instead of
  failing the whole request.
- Both degradations are explicit: the schema carries `x-toolhome-schema: "truncated"`, the payload
  carries `upstreamInstructionsTruncated`. The `definition` fingerprint always covers the full
  contract, so `exec` still detects a stale hand-over against either form.
- `definition_too_large` remains the last resort, for a tool whose shrunken form still cannot fit.

The `find(detail=definition)` budget path is unchanged.

## Compact `exec` accepts a client-prefixed tool name

A harness that connects to several ToolHome entries namespaces every tool with its own label,
turning `firecrawl_firecrawl-5fsearch` into `toolhome-local__firecrawl_firecrawl-5fsearch`; the
gateway answered `Tool not found` because no upstream slug contains `__`. `resolve` now strips an
outer entry prefix (both the `__` and single-underscore forms) before matching, and never touches
a plain aggregate name like `github_search`.

## Remote upstreams with AAAA records resolve over IPv4

An upstream that publishes an IPv6 address (Notion) made the whole gateway-side request fail with
`Version negotiation probe failed: fetch failed` on hosts without an IPv6 route, while `curl -4`
to the same URL answered immediately: Node's `fetch` tries the AAAA first and does not fall back.
The image and compose file now set `NODE_OPTIONS=--dns-result-order=ipv4first`; override it if the
deployment network is IPv6-native. A troubleshooting entry covers confirming the diagnosis with
`docker exec`.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.6.19`. CLI: `npm install -g toolhome@0.6.19`.

No schema or API changes; the compose change adds one environment line.

## Validation

Server typecheck, build and 390 tests; web typecheck and 61 tests; both builds. New tests cover
the degraded describe (schema survives, instructions truncated with markers, fingerprint intact),
the still-oversized error path, and entry-prefix stripping in both separators — including that a
plain aggregate name is never mangled. The pre-existing deepwiki oversized-instructions test now
asserts the truncation contract it previously expected to fail wholesale.
