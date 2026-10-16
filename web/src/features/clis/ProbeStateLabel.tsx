import { useI18n } from '../../i18n'
import type { ProbeState } from './probe'

/** The probe's own answer, with the version it reported when there is one. */
export function ProbeStateLabel({ state, version }: { state: ProbeState; version: string | null }) {
  const { t } = useI18n()
  const label = t(`cli.probe.${state}`)
  if (version === null) return <>{label}</>
  return (
    <>
      {label}
      <span className="ml-1 text-ink-3">{version.split(' ').slice(0, 2).join(' ')}</span>
    </>
  )
}
