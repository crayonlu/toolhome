import { HardDrive, Laptop } from 'lucide-react'
import { useI18n } from '../../i18n'
import type { PlacementGroup } from './placement'

/**
 * Second-level menu under the plane switch: which machine each MCP server is
 * placed on. Rendered as a segmented row so a node machine never reads as just
 * another remote endpoint.
 */
export function PlacementMenu({
  groups,
  value,
  onChange,
}: {
  groups: PlacementGroup[]
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useI18n()
  const label = (group: PlacementGroup): string => {
    if (group.kind === 'all') return t('servers.placement.all')
    if (group.kind === 'host') return t('servers.placement.host')
    return group.nodeId ?? t('servers.placement.node')
  }
  return (
    <div
      role="radiogroup"
      aria-label={t('servers.placement.label')}
      className="flex flex-wrap items-center gap-0.5 bg-surface-2 p-0.5"
    >
      {groups.map((group) => {
        const Icon = group.kind === 'node' ? Laptop : group.kind === 'host' ? HardDrive : undefined
        const selected = group.id === value
        return (
          <button
            key={group.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(group.id)}
            className={`flex h-7 items-center gap-1.5 px-2.5 text-xs font-medium transition-colors ${
              selected ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {Icon !== undefined && <Icon className="size-3.5" />}
            <span className="max-w-[12rem] truncate">{label(group)}</span>
            <span className={selected ? 'text-ink-3' : 'text-ink-3/70'}>{group.count}</span>
          </button>
        )
      })}
    </div>
  )
}
