# ToolHome v0.7.8

Discovery breaks score ties on the name that fully covers the task.

## Shortest covered name wins a tie

With a provider prefix already scoped, `resend send email` returned `send-batch-emails` ahead of
`send-email`: `send-batch-emails` matched the query words in its name and gained extra points from
its description and parameters, while `send-email` covered the same words with a shorter name.

`find` now ranks candidates by how much of the task their **name** covers before comparing the
total field score. A name that mentions more query words wins, then a name with fewer unexplained
words, and only then the weighted score. A tool whose description repeats an incidental query word
no longer outranks the tool the task names. Ties still fall back to name length and identifier.

The retrieval fixture now carries the sibling tools that caused this (`send-batch-emails`,
`send-broadcast`, `list-emails`, and the Mosaic `bots_*` family), so the regression is measured
against a catalog with realistic near-misses rather than one tool per provider.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.7.8`. CLI: `npm install -g toolhome@0.7.8`.

No schema, API, or configuration changes.

## Validation

Typecheck, 405 tests (2 skipped) including the new name-tie regression, and three consecutive clean
launches of the built host and built local stdio. A live probe against v0.7.7 reproduced the
`send-batch-emails` ordering that this release fixes.
