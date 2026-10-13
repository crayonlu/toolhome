# ToolHome v0.6.15

Follow-up fixes found by running the new migration and adoption paths against a live deployment.

## Adoption

- `cli adopt` verified a hand-over by asking the CLI's `status` probe for `loggedIn`, which most
  platform CLIs never report: `gh --version` cannot say anything about a login, so a successful
  hand-over was reported as a failure. An entry can now declare how to check itself, and `gh-cli`
  does:
  ```ts
  verify: { args: ['auth', 'status'], expect: 'Logged in to' }
  ```
- A probe that reports no markers at all is now **inconclusive** rather than a failure: the
  hand-over is reported as `handed over, but this entry reports no login state to confirm it`,
  and it never causes the upload to be skipped as "already authenticated".
- `gh-cli`'s own `status` probe reports `version=` and `loggedIn=` markers, so `toolhome cli
  status gh-cli` answers a real login state instead of always `loggedIn:false`. Existing
  installations keep the probe stored in their record; update it with
  `toolhome cli update <id> '{"probe":...}'` or reinstall the entry.

## Deployment

- The GitHub CLI image shipped by the deploy job no longer bakes in
  `GH_HOST=toolhome-gh-relay.crayon-6eb.workers.dev`. That Cloudflare Worker relay stopped
  answering, so every `gh` invocation inside the hosted container hung until it timed out —
  including `gh auth status`, which made a stored token look invalid. The deployment host
  reaches `api.github.com` directly, verified from inside a container on it (`gh api
  rate_limit` answers in about a second). Set `GH_HOST` again only if that direct route is lost.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.6.15`. CLI: `npm install -g toolhome@0.6.15`.

No schema or environment changes. The probe and verification changes live in the catalog and in
the adopting CLI; a CLI record installed earlier keeps the probe it was created with.

## Validation

Server typecheck and 380 tests, web typecheck and 34 tests, both builds. Adoption is covered for
the four verification outcomes (a declared `verify` command, an already-authenticated target, an
inconclusive probe, and a probe that reports a version but no login), plus the catalog invariant
that every hosted CLI entry declares how its login state moves.
