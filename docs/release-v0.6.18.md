# ToolHome v0.6.18

Carries everything described in `docs/release-v0.6.17.md` — node status reported by the machine
that runs it, and hosted-CLI status from the probe instead of the enable flag — plus the fix that
stopped that release from building.

## Fixed

- A web test fixture for the node report did not satisfy `ServerWithRuntime` (an incomplete
  `settings` object), so `web: typecheck` failed. The 0.6.17 image was never built, no container
  was deployed and nothing was published to npm from it; the tag and its release notes are kept
  as the record of the attempt.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.6.18`. CLI: `npm install -g toolhome@0.6.18`.

The `node_reports` table is created on first open and no existing data is rewritten. A client
machine that has not updated yet simply never reports, and its servers read *"not reported by
&lt;machine&gt; yet"* until it runs `toolhome node report`, or `toolhome mcp stdio` from 0.6.18.

## Validation

Server typecheck, build and 383 tests; web typecheck, 61 tests and production build — each step
run and reported separately, which is what the previous release's pipeline skipped.
