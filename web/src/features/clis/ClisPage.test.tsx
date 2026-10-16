import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClisPage } from './ClisPage'
import { I18nProvider } from '../../i18n'
import { ToastProvider } from '../../components/ui/Toast'
import { ConfirmProvider } from '../../components/ui/ConfirmDialog'

const clis = [
  {
    id: 'c1',
    slug: 'gh-cli',
    name: 'GitHub CLI (gh)',
    command: 'toolhome/gh-cli:2.97.0',
    executionMode: 'docker',
    entrypoint: 'gh',
    authStrategy: 'none',
    containerVolumes: [],
    platform: 'github',
    allowList: { allow: [], deny: [] },
    interactive: false,
    credentialId: null,
    credentialBindings: {},
    probe: null,
    enabled: true,
    timeoutMs: 60000,
    maxOutputBytes: 65536,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: 'c2',
    slug: 'lark-cli',
    name: 'Lark CLI',
    command: '/data/market/node_modules/.bin/lark-cli',
    executionMode: 'host',
    entrypoint: null,
    authStrategy: 'none',
    containerVolumes: [],
    platform: 'lark',
    allowList: { allow: [], deny: [] },
    interactive: false,
    credentialId: null,
    credentialBindings: {},
    probe: null,
    enabled: true,
    timeoutMs: 60000,
    maxOutputBytes: 65536,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
]

const statuses: Record<string, unknown> = {
  'gh-cli': {
    installed: true,
    version: 'gh version 2.97.0 (2026-07-31)',
    loggedIn: true,
    lastCheckedAt: '2026-10-16T00:00:00.000Z',
  },
  'lark-cli': {
    installed: true,
    version: null,
    loggedIn: false,
    lastCheckedAt: '2026-10-16T00:00:00.000Z',
  },
}

function stubFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const statusMatch = /\/cli\/([^/]+)\/status/.exec(url)
    const body = statusMatch
      ? statuses[decodeURIComponent(statusMatch[1]!)]
      : url.includes('/api/v1/clis')
        ? clis
        : []
    return new Response(JSON.stringify(body ?? {}), {
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
            <ClisPage />
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>,
  )
}

describe('hosted CLI status', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('claims only what the record knows before anything is checked', async () => {
    stubFetch()
    renderPage()

    // The old page rendered `enabled` as "Ready", which is not something the
    // host knows: lark-cli is enabled and not configured.
    await waitFor(() => expect(screen.getAllByText('Configured')).toHaveLength(2))
    expect(screen.queryByText('Ready')).toBeNull()
    expect(screen.queryByText('Signed in')).toBeNull()
  })

  it('shows the probe answer once checked, per CLI', async () => {
    stubFetch()
    renderPage()
    await waitFor(() => expect(screen.getAllByText('Configured')).toHaveLength(2))

    await userEvent.click(screen.getByRole('button', { name: /Check all/ }))

    await waitFor(() => expect(screen.getByText('Signed in')).toBeTruthy())
    // gh reported no version/login marker for lark-cli, which is inconclusive
    // rather than a failure.
    expect(screen.getByText('No status reported')).toBeTruthy()
    expect(screen.queryByText('Configured')).toBeNull()
  })
})
