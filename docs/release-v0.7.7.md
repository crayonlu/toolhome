# ToolHome v0.7.7

Discovery breaks score ties on the name that fully covers the task.

## Shortest covered name wins a tie

With a provider prefix already scoped, `resend send email` returned `send-batch-emails` ahead of
`send-email`: both matched the query words, and the extra name words did not count against the
longer name. `find` now breaks a score tie by the number of tool-name words the query does not
mention, then by name length. A real extra hit still outranks the tie-break, so this changes only
the order of equally scoring candidates.

The retrieval fixture now carries the sibling tools that caused this (`send-batch-emails`,
`send-broadcast`, `list-emails`, and the Mosaic `bots_*` family), so the regression is measured
against a catalog with realistic near-misses rather than one tool per provider.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.7.7`. CLI: `npm install -g toolhome@0.7.7`.

No schema, API, or configuration changes.

## Validation

Typecheck, 405 tests (2 skipped) including the new name-tie regression, and three consecutive clean
launches of the built host and built local stdio. A live probe against v0.7.6 reproduced the
`send-batch-emails` ordering that this release fixes.
