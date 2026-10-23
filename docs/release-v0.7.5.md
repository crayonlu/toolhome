# ToolHome v0.7.5

Compact discovery now works on the first attempt in the cases agents actually hit.

## Discovery names its own surface

The two compact tools used to be titled "Search tools" and "Execute tool", which a host could
rank alongside every other MCP server. Their titles now lead with ToolHome, and the descriptions
state the whole contract: this endpoint exposes only `search` and `exec`, `action=servers` lists
servers, `action=find` ranks tools for a task, `action=describe` returns the argument schema, and
a returned identifier is executed by passing it to `exec` rather than by calling it as a tool
name. The aggregate server instructions carry the same flow.

## Provider-scoped and absent-provider queries

`action=find` now separates the provider from the task. A query that names a provider present in
the catalog narrows to that provider (`resend send email` finds `resend_send-email` first). A
query that names a provider the catalog does not host returns zero matches with
`unsupportedProvider`, `availableServers`, and guidance, instead of unrelated tools whose
description happened to contain a generic verb. Ordinary multi-word tasks keep the existing
ranking, so long queries are unaffected.

An unknown `server` argument now fails with the available slugs and a suggested slug when the
spelling is close (`resnd` → `resend`).

## Near-miss arguments recover in one call

Missing `query`, an out-of-range `limit`, and an argument that does not belong to the action each
name the action-specific requirement and valid range, for example
`limit must be an integer between 1 and 10 for action=find`. The response also carries
`details.requirement`, so a client can correct the call without another discovery round.

## Retrieval details

Query and field tokens fold a trailing plural, so `list browser console messages` and the exact
`list_console_messages` both reach the same tool. The response budgets, the no-upstream-request
guarantee for discovery, and `full` mode are unchanged.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.7.5`. CLI: `npm install -g toolhome@0.7.5`.

No schema, API, or configuration changes. Reconnect MCP clients after upgrading so they fetch the
new tool descriptions.

## Validation

Typecheck, 405 tests (2 skipped) including new first-use regressions and near-miss recovery, and
three consecutive launches of the built host and built local stdio from clean data directories,
each completing `find → describe → exec` with the expected result. A real `grok` CLI run against
the built catalog reached the target tool with no failed call.
