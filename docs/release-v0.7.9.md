# ToolHome v0.7.9

Two search round trips that agents were repeating are now answered in one call.

## Scoped tasks are not gated out

The multi-token coverage gate exists to stop a single common word from matching the whole
directory. Inside an explicit scope it was too strict: `{"action":"find","query":"bot preset",
"server":"mosaic"}` returned zero matches, so the agent tried four more phrasings. When the caller
has already chosen a server, or the query starts with a hosted provider slug, one matched task word
is now enough to rank inside that scope. A query made only of provider names (`shadcn context7`)
still matches nothing, and unscoped queries keep the stricter gate.

## `describe` accepts the provider slug

Clients carry `server` forward from `find`, and `describe` rejected it with
`Argument "server" is not valid for action "describe"`. Two recent sessions lost a call to this.
`describe` now accepts an optional `server` and verifies it: a matching slug is ignored, and a
mismatch returns `unknown_tool` naming the server that actually owns the tool.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.7.9`. CLI: `npm install -g toolhome@0.7.9`.

No schema, API, or configuration changes.

## Validation

Typecheck, 407 tests (2 skipped) with new regressions for a scoped two-word task, a provider-prefix
two-word task, and describe with a matching and mismatched server, plus three consecutive clean
launches of the built host and built local stdio. The audit that motivated this release read 68
`search` calls from recent sessions and replayed the failing ones against the deployed v0.7.8
catalog.
