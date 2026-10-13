import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { I18nProvider } from '../../i18n';
import { ToastProvider } from '../../components/ui/Toast';
import { ConfirmProvider } from '../../components/ui/ConfirmDialog';

const backup = { version: 1, secretsIncluded: true, credentials: [], servers: [], clis: [] };

const report = {
  mode: 'merge',
  dryRun: false,
  counts: { created: 1, reused: 1, updated: 0, skipped: 0, conflict: 0 },
  credentials: [{ name: 'Azure SP', status: 'reused' }],
  servers: [{ slug: 'firecrawl', status: 'created' }],
  clis: [{ slug: 'gh-cli', status: 'skipped', changes: [] }],
  installations: [{ entryId: 'gh-cli', targetType: 'cli', targetSlug: 'gh-cli' }],
  conflicts: [],
};

function renderPage(): HTMLElement {
  return render(
    <I18nProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <ConfirmProvider>
            <SettingsPage />
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>,
  ).container;
}

/** The first file input is Import, the second is Preview. */
async function uploadBackup(container: HTMLElement, index: number): Promise<void> {
  const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  const input = inputs[index];
  if (input === undefined) throw new Error(`no file input at index ${String(index)}`);
  await userEvent.upload(input, new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' }));
}

function stubFetch(bodies: { export?: unknown; import?: unknown }): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v1/config/import')) {
      return new Response(JSON.stringify(bodies.import ?? report), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/v1/control-keys')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(bodies.export ?? backup), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function importBodies(fetchMock: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([input]: [RequestInfo | URL, RequestInit?]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('/api/v1/config/import');
    })
    .map(([, init]: [RequestInfo | URL, RequestInit?]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

describe('configuration transfer in the console', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('imports in merge mode with upsert when the operator asks for it', async () => {
    const fetchMock = stubFetch({});
    const container = renderPage();

    // The mode selector carries its label as plain text, so reach it from there.
    const modeTrigger = screen
      .getByText('Import mode')
      .parentElement!.querySelector('[role="combobox"]') as HTMLElement;
    await userEvent.click(modeTrigger);
    await userEvent.click(await screen.findByText(/Merge/));
    await userEvent.click(screen.getByRole('checkbox'));
    await uploadBackup(container, 0);

    await waitFor(() => expect(importBodies(fetchMock)).toHaveLength(1));
    expect(importBodies(fetchMock)[0]).toMatchObject({
      mode: 'merge',
      upsert: true,
      dryRun: false,
      version: 1,
    });
  });

  it('previews without writing and renders the report', async () => {
    const fetchMock = stubFetch({ import: { ...report, dryRun: true } });
    const container = renderPage();

    await uploadBackup(container, 1);

    await waitFor(() => expect(importBodies(fetchMock)).toHaveLength(1));
    expect(importBodies(fetchMock)[0]).toMatchObject({ mode: 'create', dryRun: true });

    expect(await screen.findByText('firecrawl')).toBeTruthy();
    expect(screen.getByText('gh-cli')).toBeTruthy();
    expect(screen.getByText(/created: 1/)).toBeTruthy();
    expect(screen.getByText(/reused: 1/)).toBeTruthy();
  });

  it('summarizes what an export contains', async () => {
    const fetchMock = stubFetch({
      export: { ...backup, servers: [{}], clis: [{}, {}], credentials: [{}] },
    });
    renderPage();

    await userEvent.click(screen.getByText('Export'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]: [RequestInfo | URL, RequestInit?]) =>
          String(input).includes('config/export'),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText(/1 servers, 2 hosted CLIs, 1 credentials/)).toBeTruthy();
  });
});
