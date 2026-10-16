import { describe, expect, it } from 'vitest'
import { displayStatus, nodeReportLine } from './nodeReport'
import type { ServerWithRuntime } from '../../api/types'

const base = {
  id: 's1',
  slug: 'chrome-devtools',
  name: 'Local Chrome',
  transport: { type: 'stdio' as const, command: 'npx', args: [] },
  credentialId: null,
  enabled: true,
  settings: {},
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  runtime: null,
}

/** The real i18n helper: a key lookup with `{name}` substitution. */
const templates: Record<string, string> = {
  'servers.nodeReport.by': 'reported by {node} {age}',
  'servers.nodeReport.stale': 'last reported by {node} {age}',
  'servers.nodeReport.missing': 'not reported by {node} yet',
  'servers.nodeReport.probeMissing': 'launch command missing',
  'servers.nodeReport.tools': '{count} tools',
  'servers.placement.node': 'Node',
}
const t = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    templates[key] ?? key,
  )

const report = (input: Partial<NonNullable<ServerWithRuntime['nodeReport']>> = {}) => ({
  serverId: 's1',
  nodeId: 'crayons-air',
  status: 'ready' as const,
  lastError: null,
  probeOk: true,
  probeDetail: 'npx',
  tools: 26,
  reportedAt: new Date(Date.now() - 60_000).toISOString(),
  stale: false,
  ...input,
})

describe('node server status', () => {
  it('prefers the machine report over the host\'s own unknown state', () => {
    const server: ServerWithRuntime = {
      ...base,
      kind: 'node',
      nodeId: 'crayons-air',
      runtime: { status: 'unknown' } as ServerWithRuntime['runtime'],
      nodeReport: report(),
    }
    expect(displayStatus(server)).toBe('ready')
  })

  it('stays unknown for a node server that has not reported', () => {
    const server: ServerWithRuntime = { ...base, kind: 'node', nodeId: 'crayons-air' }
    expect(displayStatus(server)).toBe('unknown')
    expect(nodeReportLine(server, t, 'en')).toBe('not reported by crayons-air yet')
  })

  it('says which machine reported, how long ago, and what it found', () => {
    const server: ServerWithRuntime = {
      ...base,
      kind: 'node',
      nodeId: 'crayons-air',
      nodeReport: report(),
    }
    const line = nodeReportLine(server, t, 'en')
    expect(line).toContain('reported by crayons-air')
    expect(line).toContain('26 tools')
  })

  it('keeps a stale report visible with its age instead of calling it current', () => {
    const server: ServerWithRuntime = {
      ...base,
      kind: 'node',
      nodeId: 'crayons-air',
      nodeReport: report({ stale: true, reportedAt: new Date(Date.now() - 3_600_000).toISOString() }),
    }
    expect(nodeReportLine(server, t, 'en')).toContain('last reported by crayons-air')
  })

  it('flags a missing launch command, which only that machine can know', () => {
    const server: ServerWithRuntime = {
      ...base,
      kind: 'node',
      nodeId: 'crayons-air',
      nodeReport: report({ probeOk: false, tools: null }),
    }
    expect(nodeReportLine(server, t, 'en')).toContain('launch command missing')
  })

  it('says nothing for a server the host runs itself', () => {
    const server: ServerWithRuntime = { ...base, slug: 'firecrawl', kind: 'remote', nodeId: null }
    expect(nodeReportLine(server, t, 'en')).toBeNull()
  })
})
