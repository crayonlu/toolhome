import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CallsPage } from './CallsPage'
import { I18nProvider } from '../../i18n'
import { ToastProvider } from '../../components/ui/Toast'
import { ConfirmProvider } from '../../components/ui/ConfirmDialog'

const servers = [
  {
    id: 'penpot-id',
    slug: 'penpot',
    name: 'Penpot',
    kind: 'remote',
    nodeId: null,
    transport: { type: 'streamable-http', url: 'https://design.penpot.app/mcp/stream' },
    credentialId: null,
    enabled: true,
    settings: {},
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    runtime: null,
  },
]

const call = (input: {
  id: string
  endpointType: 'aggregate' | 'individual' | 'cli'
  serverId: string | null
  exposed: string
  upstream: string
}) => ({
  id: input.id,
  endpointType: input.endpointType,
  principalKind: 'access_key',
  principalId: 'p',
  serverId: input.serverId,
  exposedToolName: input.exposed,
  upstreamToolName: input.upstream,
  status: 'success',
  errorType: null,
  startedAt: '2026-10-19T06:02:01.934Z',
  completedAt: '2026-10-19T06:02:04.518Z',
  durationMs: 2584,
})

const calls = [
  // Compact discovery: the exposed name is the wrapper, the upstream name is the tool.
  call({ id: 'c1', endpointType: 'aggregate', serverId: 'penpot-id', exposed: 'exec', upstream: 'execute_code' }),
  // Direct aggregate: both names differ and the exposed one is meaningful.
  call({ id: 'c2', endpointType: 'aggregate', serverId: 'penpot-id', exposed: 'penpot_export-5fshape', upstream: 'export_shape' }),
  // Hosted CLI: the slug and the command.
  call({ id: 'c3', endpointType: 'cli', serverId: null, exposed: 'gh-cli', upstream: 'auth status' }),
]

function stubFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let body: unknown = []
    if (url.includes('/api/v1/calls/stats')) {
      body = {
        total: 3,
        success: 3,
        error: 0,
        successRate: 100,
        avgDurationMs: 2000,
        p50Ms: 2000,
        p95Ms: 2500,
        topTools: [{ tool: 'execute_code', count: 1 }],
        topFailing: [],
      }
    } else if (url.includes('/api/v1/calls/series')) {
      body = { points: [], bucketSeconds: 3600 }
    } else if (url.includes('/api/v1/calls')) {
      body = { items: calls, total: calls.length }
    } else if (url.includes('/api/v1/servers')) {
      body = servers
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function renderPage(): void {
  render(
    <I18nProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <ConfirmProvider>
            <CallsPage />
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>,
  )
}

describe('call ledger identity', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names the upstream tool and its server instead of repeating the compact wrapper', async () => {
    stubFetch()
    renderPage()

    // "penpot / execute_code", not "execute_code exec".
    const compact = await screen.findByText('penpot / execute_code')
    expect(compact.textContent).toBe('penpot / execute_code')
    expect(screen.queryByText(/execute_code exec/)).toBeNull()
  })

  it('keeps a direct aggregate name when it differs from the upstream tool', async () => {
    stubFetch()
    renderPage()

    const direct = await screen.findByText(/export_shape/)
    expect(direct.textContent).toContain('penpot / export_shape')
    expect(direct.textContent).toContain('penpot_export-5fshape')
  })

  it('reads a hosted CLI call as slug and command', async () => {
    stubFetch()
    renderPage()

    const cli = await screen.findByText('gh-cli / auth status')
    expect(cli.textContent).toContain('gh-cli / auth status')
    expect(screen.getByText('CLI')).toBeTruthy()
  })

  it('leaves the ledger free of a bare exec label', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('penpot / execute_code')

    const rows = screen.getAllByText(/penpot \/|gh-cli \//)
    for (const row of rows) {
      expect(row.textContent?.trim()).not.toBe('exec')
    }
  })
})
