import { describe, expect, it } from 'vitest'
import {
  ALL_PLACEMENT,
  HOST_PLACEMENT,
  matchesPlacement,
  nodePlacement,
  placementGroups,
  resolvePlacement,
} from './placement'
import type { ServerKind } from '../../api/types'

const server = (slug: string, kind: ServerKind, nodeId: string | null = null) => ({
  slug,
  kind,
  nodeId,
})

const mixed = [
  server('firecrawl', 'remote'),
  server('resend', 'home'),
  server('chrome-devtools', 'node', 'crayons-air'),
  server('ghidra', 'node', 'crayons-air'),
  server('drawio', 'node', 'R9000P'),
]

describe('placement grouping', () => {
  it('separates the host from every node machine, with counts', () => {
    expect(placementGroups(mixed)).toEqual([
      { id: ALL_PLACEMENT, kind: 'all', count: 5 },
      { id: HOST_PLACEMENT, kind: 'host', count: 2 },
      // Locale-aware order, not ASCII: 'crayons-air' sorts before 'R9000P'.
      { id: nodePlacement('crayons-air'), kind: 'node', nodeId: 'crayons-air', count: 2 },
      { id: nodePlacement('R9000P'), kind: 'node', nodeId: 'R9000P', count: 1 },
    ])
  })

  it('keeps the menu stable when the machine list changes order', () => {
    const ids = (servers: typeof mixed) => placementGroups(servers).map((group) => group.id)
    expect(ids([...mixed].reverse())).toEqual(ids(mixed))
  })

  it('always offers all and host, even for an empty instance', () => {
    expect(placementGroups([])).toEqual([
      { id: ALL_PLACEMENT, kind: 'all', count: 0 },
      { id: HOST_PLACEMENT, kind: 'host', count: 0 },
    ])
  })

  it('never lets a remote server fall into a node group', () => {
    const remote = mixed[0]!
    expect(matchesPlacement(remote, HOST_PLACEMENT)).toBe(true)
    expect(matchesPlacement(remote, nodePlacement('crayons-air'))).toBe(false)
    expect(matchesPlacement(remote, ALL_PLACEMENT)).toBe(true)
  })

  it('matches a node server only for its own machine', () => {
    const ghidra = mixed[3]!
    expect(matchesPlacement(ghidra, nodePlacement('crayons-air'))).toBe(true)
    expect(matchesPlacement(ghidra, nodePlacement('R9000P'))).toBe(false)
    // A node server is not a host server: it runs on the client machine.
    expect(matchesPlacement(ghidra, HOST_PLACEMENT)).toBe(false)
  })

  it('falls back to everything when the selected machine is gone', () => {
    const groups = placementGroups([server('resend', 'home')])
    expect(resolvePlacement(groups, nodePlacement('crayons-air'))).toBe(ALL_PLACEMENT)
    expect(resolvePlacement(groups, HOST_PLACEMENT)).toBe(HOST_PLACEMENT)
  })

  it('groups a node server that lost its label instead of hiding it', () => {
    const orphan = server('mystery', 'node', null)
    const groups = placementGroups([orphan])
    expect(groups.map((group) => group.id)).toEqual([
      ALL_PLACEMENT,
      HOST_PLACEMENT,
      nodePlacement('unlabelled'),
    ])
    expect(matchesPlacement(orphan, nodePlacement('unlabelled'))).toBe(true)
  })
})
