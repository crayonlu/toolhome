# ToolHome v0.7.0

Compact mode now teaches agents how to use it. Three changes address the same
failure observed against the deployed gateway: an agent connected to the
aggregate endpoint saw full-mode naming guidance, called a discovery identifier
as if it were a tool name, and got a refusal it could not act on.

## Compact instructions describe the two-step flow

The aggregate server instructions were identical in full and compact modes. In
compact mode that guidance is wrong — `tools/list` exposes only `search` and
`exec`, yet the instructions advertised `server_slug_encodedToolName` naming,
steering agents into calling catalog identifiers directly. Compact deployments
now get mode-specific instructions: discover with `search`, execute the
returned identifier with `exec`, never call an identifier as a tool name.

## Discovery results carry invocation hints

`find` and `describe` results for exec-boundary tools now include `via: "exec"`
and a `call` field spelling out the invocation shape (`tools/call` with
`name="exec"`, the identifier as `tool`, arguments per the inputSchema).
Previously only `individualEndpoint` tools carried guidance; the common case
said nothing about how to execute what discovery returned.

## `unknown_tool` errors are mechanically followable

Calling an unresolvable name previously returned a generic refusal with a
`retry_search` nextStep whose arguments omitted the required `query` —
following it verbatim produced a second error. Now:

- When the submitted name resolves in the catalog (the direct-identifier
  mistake), the error names the mistake and emits an `exec_tool` nextStep with
  `{ tool: <identifier>, arguments: {} }` ready to fill from `describe`.
- Otherwise the generic `retry_search` nextStep carries `action: "find"` plus
  the required `query` placeholder and explains the discover-then-exec flow.

A new `exec_tool` action joins `CompactNextStepAction`.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.7.0`. CLI: `npm install -g toolhome@0.7.0`.

No schema or API changes; new fields are additive to find/describe payloads.

## Validation

Server typecheck, build and 393 unit tests plus the integration suite (50
files). New tests cover the resolvable/non-resolvable `unknown_tool` branches
(unit and integration), the `via`/`call` hint on find and describe payloads,
and that individualEndpoint tools still route to guidance without the exec
hint. Verified against the deployed compact gateway: instructions, find hints
and both error branches behave as described.
