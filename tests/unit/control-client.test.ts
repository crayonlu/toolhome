import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ControlClient, transportFailureReason } from '../../src/control/client.js';
import type { CliExecFrame } from '../../src/cli-plane/frames.js';

function ndjson(frames: unknown[]): string {
  return frames.map((frame) => `${JSON.stringify(frame)}\n`).join('');
}

describe('ControlClient.execStream', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  afterAll(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it('parses NDJSON frames and returns the exit frame outcome', async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe('/cli/host-shell/exec');
      expect(request.headers.authorization).toBe('Bearer k');
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(
        ndjson([
          { type: 'stdout', data: 'hello' },
          { type: 'stderr', data: 'warn' },
          { type: 'exit', code: 0, durationMs: 12, result: 'ok' },
        ]),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const client = new ControlClient(new URL(`http://127.0.0.1:${address.port}`), 'k');

    const frames: CliExecFrame[] = [];
    const outcome = await client.execStream('host-shell', { argv: ['-c', 'echo hello'] }, (frame) =>
      frames.push(frame),
    );

    expect(frames.map((frame) => frame.type)).toEqual(['stdout', 'stderr', 'exit']);
    expect(outcome).toEqual({ code: 0, durationMs: 12, result: 'ok' });
  });

  it('rejects when the response status is an error', async () => {
    const server = createServer((request, response) => {
      void request;
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'forbidden', message: 'nope' } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const client = new ControlClient(new URL(`http://127.0.0.1:${address.port}`), 'k');

    await expect(client.execStream('host-shell', { argv: ['x'] }, () => {})).rejects.toMatchObject({
      status: 403,
      message: 'nope',
    });
  });

  it('rejects when a non-exit terminal state arrives without an exit frame', async () => {
    const server = createServer((request, response) => {
      void request;
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(ndjson([{ type: 'stdout', data: 'partial' }]));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const client = new ControlClient(new URL(`http://127.0.0.1:${address.port}`), 'k');

    await expect(client.execStream('host-shell', { argv: ['x'] }, () => {})).rejects.toThrow(
      /ended without an exit frame/i,
    );
  });

  it('aborts the request when the caller signals', async () => {
    let sawAbort = false;
    const server = createServer((request, response) => {
      request.on('aborted', () => {
        sawAbort = true;
      });
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(ndjson([{ type: 'stdout', data: 'chunk' }]));
      // Never end: the client must abort.
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const client = new ControlClient(new URL(`http://127.0.0.1:${address.port}`), 'k');

    const controller = new AbortController();
    const pending = client.execStream(
      'host-shell',
      { argv: ['tail'] },
      () => {
        controller.abort();
      },
      controller.signal,
    );
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(sawAbort).toBe(true));
  });
});

describe('transport failure reporting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the errno behind a bare "fetch failed"', () => {
    const dns = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND tool.example.com'), {
        code: 'ENOTFOUND',
      }),
    });
    expect(transportFailureReason(dns)).toBe('ENOTFOUND: getaddrinfo ENOTFOUND tool.example.com');
  });

  it('reads a cause nested in an AggregateError, the shape undici uses for dual-stack connects', () => {
    const aggregate = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new AggregateError([], 'all attempts failed'), {
        errors: [
          Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3344'), {
            code: 'ECONNREFUSED',
          }),
        ],
      }),
    });
    expect(transportFailureReason(aggregate)).toContain('ECONNREFUSED');
  });

  it('still answers when there is nothing to inspect', () => {
    expect(transportFailureReason(new TypeError('fetch failed'))).toBe('the connection failed');
  });

  it('reports an unreachable control plane as such instead of a protocol error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ETIMEDOUT 123.56.83.28:443'), {
          code: 'ETIMEDOUT',
        }),
      }),
    );
    const client = new ControlClient(new URL('https://tool.example.com'), 'tch_ctl_test');
    await expect(client.request('GET', '/api/v1/servers')).rejects.toMatchObject({
      code: 'control_api_unreachable',
      message:
        'cannot reach https://tool.example.com/api/v1/servers: ETIMEDOUT: connect ETIMEDOUT 123.56.83.28:443',
      status: 502,
    });
  });

  it('keeps a real HTTP response a protocol error, not a transport one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid control key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new ControlClient(new URL('https://tool.example.com'), 'tch_ctl_test');
    await expect(client.request('GET', '/api/v1/servers')).rejects.toMatchObject({
      code: 'control_api_error',
      status: 401,
    });
  });
});
