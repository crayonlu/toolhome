import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallSheet } from './InstallSheet';
import { I18nProvider } from '../../i18n';
import type { MarketEntry } from '../../api/types';

const entry: MarketEntry = {
  id: 'gh-cli',
  name: 'GitHub CLI (gh)',
  description: 'Hosted GitHub CLI',
  category: 'devtools',
  plane: 'cli',
  kind: 'cli-image',
  image: 'ghcr.io/cli/cli:latest',
  credential: { type: 'env' },
  requires: [{ name: 'GH_TOKEN', description: 'GitHub token', secret: true, required: true }],
  installed: false,
  installedVersion: null,
  updateAvailable: false,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function countPolls(fetchMock: ReturnType<typeof vi.spyOn>): number {
  return fetchMock.mock.calls.filter(([input]: [RequestInfo | URL, RequestInit?]) =>
    requestPath(input).endsWith('/api/v1/market/install/job-1'),
  ).length;
}

describe('InstallSheet secure action expiry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles an already-installed response without polling a null job', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onInstalled = vi.fn();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (path === '/api/v1/market/gh-cli/install') {
        return jsonResponse({ jobId: null, status: 'already_installed' });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    render(
      <I18nProvider>
        <InstallSheet entry={entry} onOpenChange={onOpenChange} onInstalled={onInstalled} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith('gh-cli'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it('stops polling and shows the expiry message when the secret link expires', async () => {
    const user = userEvent.setup();
    let installCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (path === '/api/v1/market/gh-cli/install') {
        installCalls += 1;
        return jsonResponse({ jobId: 'job-1', status: 'awaiting_secret' });
      }
      if (path === '/api/v1/market/install/job-1')
        return jsonResponse({
          id: 'job-1',
          entryId: 'gh-cli',
          status: 'failed',
          step: 'secure action expired',
          output: '',
          error: 'secure_action_expired',
        });
      throw new Error(`unexpected fetch: ${path}`);
    });

    render(
      <I18nProvider>
        <InstallSheet entry={entry} onOpenChange={vi.fn()} onInstalled={vi.fn()} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText(/link expired/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The expired job must not keep polling forever.
    const polls = countPolls(fetchMock);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pollsAfterWait = countPolls(fetchMock);
    expect(polls).toBe(1);
    expect(pollsAfterWait).toBe(1);
    expect(installCalls).toBe(1);
  });
});
