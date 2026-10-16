import type { CliStatus } from '../../api/types'

/**
 * What a hosted CLI's probe actually said.
 *
 * The record's `enabled` flag only says ToolHome will run the CLI; it says
 * nothing about whether the binary is present or signed in. Reporting that flag
 * as "ready" claimed more than the host knows, so the console shows the record
 * state until a probe answers, and the probe's own answer afterwards.
 */
export type ProbeState =
  | 'unchecked'
  | 'no-probe'
  | 'missing'
  | 'ready'
  | 'unauthenticated'
  | 'unreported'

export function probeState(status: CliStatus | undefined): ProbeState {
  if (status === undefined) return 'unchecked'
  if (status.installed === null) return 'no-probe'
  if (!status.installed) return 'missing'
  if (status.loggedIn) return 'ready'
  // The probe ran and printed no login marker: that is not proof of failure,
  // and for most platform CLIs it never can be (see the catalog's probes).
  return status.version === null ? 'unreported' : 'unauthenticated'
}

export function probeTone(state: ProbeState): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (state) {
    case 'ready':
      return 'success'
    case 'unauthenticated':
      return 'warning'
    case 'missing':
      return 'danger'
    default:
      return 'neutral'
  }
}
