import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ControlClient } from '../../src/control/client.js';
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
