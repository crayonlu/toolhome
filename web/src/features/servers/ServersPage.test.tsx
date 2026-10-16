import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServersPage } from './ServersPage'
import { I18nProvider } from '../../i18n'
import { ToastProvider } from '../../components/ui/Toast'
import { ConfirmProvider } from '../../components/ui/ConfirmDialog'

const servers = [
  {
    id: 's1',
    slug: 'firecrawl',
    name: 'Firecrawl',
    kind: 'remote',
    nodeId: null,
    transport: { type: 'streamable-http', url: 'https://mcp.firecrawl.dev/v2/mcp' },
    credentialId: null,
    enabled: true,
    settings: {},
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    runtime: { status: 'ready' },
  },
  {
    id: 's2',
    slug: 'chrome-devtools',
    name: 'Local Chrome',
    kind: 'node',
    nodeId: 'crayons-air',
    transport: { type: 'stdio', command: 'npx', args: [] },
    credentialId: null,
    enabled: true,
    settings: {},
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    runtime: { status: 'ready' },
  },
  {
    id: 's3',
    slug: 'drawio',
    name: 'Drawio',
    kind: 'node',
    nodeId: 'R9000P',
    transport: { type: 'stdio', command: 'npx', args: [] },
    credentialId: null,
    enabled: true,
    settings: {},
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    runtime: { status: 'unknown' },
  },
]

function stubFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = url.includes('/api/v1/servers')
      ? servers
      : url.includes('/api/v1/diagnostics')
        ? { ok: true, servers: [] }
        : []
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
            <MemoryRouter>
              <ServersPage />
            </MemoryRouter>
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>,
  )
}

function listSlugs(): string[] {
  return screen
    .getAllByRole('link')
    .map((link) => link.textContent ?? '')
    .filter((text) => text.includes('firecrawl') || text.includes('chrome-devtools') || text.includes('drawio'))
    .map((text) => (text.includes('firecrawl') ? 'firecrawl' : text.includes('chrome-devtools') ? 'chrome-devtools' : 'drawio'))
}

describe('servers placement menu', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('splits the host from each node machine instead of listing them together', async () => {
    stubFetch()
    renderPage()

    const menu = await screen.findByRole('radiogroup', { name: 'Placement' })
    const labels = within(menu)
      .getAllByRole('radio')
      .map((item) => item.textContent)
    expect(labels).toEqual(['All3', 'ToolHome host1', 'crayons-air1', 'R9000P1'])

    // Every server is visible under "All".
    await waitFor(() => expect(listSlugs().sort()).toEqual(['chrome-devtools', 'drawio', 'firecrawl']))
  })

  it('shows only the host servers when the host group is selected', async () => {
    stubFetch()
    renderPage()

    const menu = await screen.findByRole('radiogroup', { name: 'Placement' })
    await userEvent.click(within(menu).getByRole('radio', { name: /ToolHome host/ }))

    await waitFor(() => expect(listSlugs()).toEqual(['firecrawl']))
    expect(screen.queryByText('chrome-devtools')).toBeNull()
    expect(screen.queryByText('drawio')).toBeNull()
  })

  it('shows only the servers of the selected machine', async () => {
    stubFetch()
    renderPage()

    const menu = await screen.findByRole('radiogroup', { name: 'Placement' })
    await userEvent.click(within(menu).getByRole('radio', { name: /crayons-air/ }))

    await waitFor(() => expect(listSlugs()).toEqual(['chrome-devtools']))
    expect(screen.queryByText('firecrawl')).toBeNull()
    expect(screen.queryByText('drawio')).toBeNull()
  })

  it('says a node server was not reported instead of leaving a bare unknown', async () => {
    stubFetch()
    renderPage()

    // No report yet: the host cannot know, and the row says so.
    expect(await screen.findByText('not reported by crayons-air yet')).toBeTruthy()
    expect(screen.getByText('not reported by R9000P yet')).toBeTruthy()
    // A host-run server carries no such line.
    expect(screen.queryByText(/not reported by .*firecrawl/)).toBeNull()
  })

  it('shows what the machine reported, with the probe finding', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const body = url.includes('/api/v1/servers')
        ? servers.map((server) =>
            server.kind === 'node' && server.nodeId === 'crayons-air'
              ? {
                  ...server,
                  nodeReport: {
                    serverId: server.id,
                    nodeId: 'crayons-air',
                    status: 'ready',
                    lastError: null,
                    probeOk: false,
                    probeDetail: 'ghidra bridge missing',
                    tools: 214,
                    reportedAt: new Date(Date.now() - 60_000).toISOString(),
                    stale: false,
                  },
                }
              : server,
          )
        : url.includes('/api/v1/diagnostics')
          ? { ok: true, servers: [] }
          : []
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    renderPage()

    const line = await screen.findByText(/reported by crayons-air/)
    expect(line.textContent).toContain('214 tools')
    // Only that machine can know the launch command is missing, so it is flagged.
    expect(line.textContent).toContain('launch command missing')
    expect(line.getAttribute('title')).toBe('ghidra bridge missing')
  })

  it('labels a node row with its machine so it cannot read as a remote endpoint', async () => {
    stubFetch()
    renderPage()

    expect(await screen.findByText('node · crayons-air')).toBeTruthy()
    expect(screen.getByText('node · R9000P')).toBeTruthy()
    // The remote row keeps its plain kind badge.
    expect(screen.getByText('remote')).toBeTruthy()
  })
})
