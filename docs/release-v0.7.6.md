# ToolHome v0.7.6

A provider prefix in a discovery query now scopes the search.

## Provider prefix scopes `find`

v0.7.5 returned an absent-provider recovery, but a query that started with a provider the catalog
does host still searched every server. The provider word is not a tool-field hit, so a generic verb
could win: on the deployed catalog, `cloudflare list zones` returned Notion calendar tools.

`action=find` now reads a leading provider slug as a scope, the same way an explicit
`server=<slug>` does:

- `cloudflare list zones` searches only the `cloudflare` server.
- `resend send email` finds `resend_send-email` first.
- When the hosted provider has no matching tool, the response carries `scopedServer` and points at
  `action=servers`; it never falls through to another server.
- A provider the catalog does not host still returns zero matches with `unsupportedProvider` and
  `availableServers`.

Verbs (`list`, `search`, `send`, …) are not treated as providers, so ordinary task queries keep the
existing ranking behavior.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.7.6`. CLI: `npm install -g toolhome@0.7.6`.

No schema, API, or configuration changes. Reconnect MCP clients after upgrading.

## Validation

Typecheck, 405 tests (2 skipped) including the new provider-prefix regressions, and three
consecutive clean launches of the built host and built local stdio, each completing
`find → describe → exec`. A live probe against the deployed v0.7.5 catalog reproduced the Notion
fallthrough that this release fixes.
