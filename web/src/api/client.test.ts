import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, streamNdjson } from './client';

describe('api error responses', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unwraps the backend error envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'market_operation_in_progress',
            message: 'Market entry is busy',
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(api.post('/api/v1/market/gh-cli/install', { values: {} })).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        code: 'market_operation_in_progress',
        message: 'Market entry is busy',
      }),
    );
  });

  it('passes an abort signal to the NDJSON stream request', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"type":"exit"}\n', { status: 200 }));

    await streamNdjson('/cli/host-shell/exec', { argv: ['--version'] }, () => {}, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      '/cli/host-shell/exec',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
