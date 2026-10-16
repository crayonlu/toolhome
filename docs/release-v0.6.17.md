# ToolHome v0.6.17

Both planes now report state that the host can actually know.

## Node servers: reported by the machine that runs them

A server placed on a client machine was permanently `unknown`: the host never connects to it, so
it had nothing to record. The console could not tell such a server apart from a broken one.

- `toolhome mcp stdio` publishes a report at startup and every 60 seconds; `toolhome node report`
  does it once, which suits cron. `POST /api/v1/nodes/{nodeId}/report` accepts only servers
  actually placed on that label, so a machine cannot report another one's servers.
- The report carries what only that machine can answer: the last connection state and error,
  **whether the launch command exists there**, and how many tools the server exposes.
- A report older than five minutes comes back marked `stale` and is shown with its age instead of
  as current, and a server that has never reported shows no state rather than a bare `unknown`.
- The servers list says where a state came from — *"reported by crayons-air 2 minutes ago · 26
  tools"* — and warns when the launch command is missing on that machine.

## Hosted CLIs: the probe's answer instead of the enable flag

The CLIs page rendered the record's `enabled` flag as **Ready**, which claimed more than ToolHome
knows: an enabled CLI can be missing or not signed in, and that is exactly what the probe reports.

- The page now shows **Configured** until a probe answers, and **Check** / **Check all** runs the
  probe on request — it executes the CLI, so it is not run on page load.
- The result distinguishes *Signed in*, *Not signed in*, *Not installed*, *No status reported*
  (the probe ran and printed no markers — inconclusive rather than failed), *No probe* (the record
  declares none) and *Not checked*.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.6.17`. CLI: `npm install -g toolhome@0.6.17`.

The `node_reports` table is created on first open; no existing data is rewritten. A client machine
that has not updated yet simply never reports, and its servers keep showing *"not reported yet"*.
Older servers ignore reports for a node they do not know, so updating the CLI first is safe.

## Validation

Server typecheck and 383 tests, web typecheck and 61 tests, both builds. Node reports are covered
end to end: what a machine reports reaches the server list, another machine's servers and
host-run servers are rejected, and a backdated report comes back `stale`. Web tests cover the
report line (machine, age, tool count, missing launch command), the probe state machine, both
locales defining every key, and the CLI page claiming only *Configured* before a check.
