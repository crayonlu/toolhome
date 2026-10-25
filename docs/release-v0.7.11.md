# ToolHome v0.7.11

An explicitly scoped search no longer uses the directory-wide coverage rule.

## Explicit scope relaxes the gate

v0.7.10 excluded provider words from coverage but still required two task words inside a scope.
`{"action":"find","query":"bot preset","server":"mosaic"}` returned nothing even though the caller
had already named the server, and one recent session retried four phrasings because of it.

`find` now distinguishes the two roles. An explicit `server` selects the scope and one matched task
word is enough; a leading hosted provider slug is removed from the coverage denominator the same
way. Queries made only of provider names still match nothing, and unscoped queries keep the
stricter multi-token gate that prevents a single common word from matching the whole directory.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.7.11`. CLI: `npm install -g toolhome@0.7.11`.

No schema, API, or configuration changes.

## Validation

Typecheck, 407 tests (2 skipped), and three consecutive clean launches of the built host and built
local stdio. Live probes against v0.7.10 reproduced the scoped empty result this release fixes.
