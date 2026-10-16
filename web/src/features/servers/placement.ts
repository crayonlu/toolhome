import type { ServerKind } from '../../api/types'

/**
 * Placement grouping for the servers list.
 *
 * `remote` and `home` servers run where ToolHome runs, while a `node` server
 * runs on a named client machine. Listing them together hides which machine a
 * server actually needs, so the second-level menu splits them: one group for the
 * host itself and one per node machine.
 */
export type PlacementKind = 'all' | 'host' | 'node'

export interface PlacementGroup {
  /** Stable menu id: `all`, `host`, or `node:<nodeId>`. */
  id: string
  kind: PlacementKind
  nodeId?: string
  count: number
}

export const ALL_PLACEMENT = 'all'
export const HOST_PLACEMENT = 'host'

export function nodePlacement(nodeId: string): string {
  return `node:${nodeId}`
}

interface Placeable {
  kind: ServerKind
  nodeId?: string | null
}

/** Groups in menu order: all, the host, then node machines sorted by label. */
export function placementGroups(servers: Placeable[]): PlacementGroup[] {
  const nodeCounts = new Map<string, number>()
  let hostCount = 0
  for (const server of servers) {
    if (server.kind === 'node') {
      // Placement validation requires a label; fall back to the slug-less label
      // rather than dropping a server from every group.
      const nodeId = server.nodeId ?? 'unlabelled'
      nodeCounts.set(nodeId, (nodeCounts.get(nodeId) ?? 0) + 1)
      continue
    }
    hostCount += 1
  }
  const groups: PlacementGroup[] = [
    { id: ALL_PLACEMENT, kind: 'all', count: servers.length },
    { id: HOST_PLACEMENT, kind: 'host', count: hostCount },
  ]
  for (const [nodeId, count] of [...nodeCounts].sort(([left], [right]) => left.localeCompare(right))) {
    groups.push({ id: nodePlacement(nodeId), kind: 'node', nodeId, count })
  }
  return groups
}

export function matchesPlacement(server: Placeable, placement: string): boolean {
  if (placement === ALL_PLACEMENT) return true
  if (placement === HOST_PLACEMENT) return server.kind !== 'node'
  return server.kind === 'node' && nodePlacement(server.nodeId ?? 'unlabelled') === placement
}

/** Selected placement, falling back to "all" when the machine is gone. */
export function resolvePlacement(groups: PlacementGroup[], selected: string): string {
  return groups.some((group) => group.id === selected) ? selected : ALL_PLACEMENT
}
