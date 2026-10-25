# ToolHome v0.7.10

Provider words in a scoped query no longer count against the task.

## Provider words are scope, not task

v0.7.9 let a scoped query match on one task word, but the provider word still sat in the coverage
denominator. `{"action":"find","query":"mosaic list presets"}` returned nothing because `mosaic`
cannot match anything inside the Mosaic server, so two of three words looked uncovered.

`find` now separates the two roles. A leading hosted provider slug, or a token naming the scoped
server, selects the scope and is excluded from coverage; the remaining task words are measured on
their own. A query made only of provider names (`shadcn context7`) still matches nothing, and
unscoped queries keep the stricter multi-token gate.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.7.10`. CLI: `npm install -g toolhome@0.7.10`.

No schema, API, or configuration changes.

## Validation

Typecheck, 407 tests (2 skipped), and three consecutive clean launches of the built host and built
local stdio. Live probes against v0.7.9 found the provider-prefixed empty result this release
fixes.
