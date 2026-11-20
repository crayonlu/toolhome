import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCredential } from './queries';

const pending = {
  id: 'c1',
  name: 'cloudflare',
  type: 'oauth',
  status: 'pending',
  expiresAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const ready = { ...pending, status: 'ready' };

function wrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useCredential polling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps reading until the OAuth callback flips the credential to ready', async () => {
    let reads = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      reads += 1;
      // The callback lands on the third read, so the first two must not settle
      // the hook: only polling reaches `ready`.
      const body = reads < 3 ? pending : ready;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const { result } = renderHook(() => useCredential('c1', { pollMs: 20 }), {
      wrapper: wrapper(),
    });

    // Without polling this would never become ready: one shot, then nothing.
    await waitFor(() => expect(result.current.data?.status).toBe('ready'), { timeout: 3_000 });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('reads once when no poll interval is asked for', async () => {
    let reads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      reads += 1;
      return new Response(JSON.stringify(pending), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const { result } = renderHook(() => useCredential('c1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.status).toBe('pending'));
    await new Promise((done) => setTimeout(done, 120));
    expect(reads).toBe(1);
  });
});
