import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  type ServerContext,
} from '@modelcontextprotocol/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/domain/errors.js';
import type { RuntimeState, ServerRecord } from '../../src/domain/models.js';
import { createLogger } from '../../src/observability/logger.js';
import { SecretBox } from '../../src/security/secret-box.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { UpstreamAdapter } from '../../src/upstream/adapter.js';
import { UpstreamManager } from '../../src/upstream/manager.js';

function requestContext(signal: AbortSignal): ServerContext {
  return { mcpReq: { signal } } as ServerContext;
}

const connectionErrors = [
  new Error('Connection closed'),
  new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed'),
  new TypeError('fetch failed'),
  new AppError('upstream_closed', 'Upstream adapter is closed', 503),
];

describe('UpstreamManager.execute health accounting', () => {
  let directory: string;
  let store: SqliteStore;
  let server: ServerRecord;
  let manager: UpstreamManager;
  let controller: AbortController;
  let context: ServerContext;
  let initialState: RuntimeState;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'toolhome-upstream-manager-'));
    store = new SqliteStore(join(directory, 'test.sqlite'), new SecretBox('manager-test-key'));
    server = store.createServer({
      slug: 'upstream',
      name: 'Upstream',
      kind: 'remote',
      nodeId: null,
      transport: {
        type: 'streamable-http',
        url: 'https://example.test/mcp',
        protocolMode: 'modern',
        allowSseFallback: false,
        headers: {},
      },
      credentialId: null,
      enabled: true,
      settings: {
        connectTimeoutMs: 15_000,
        requestTimeoutMs: 60_000,
        maxTotalTimeoutMs: 600_000,
        maxConcurrency: 2,
        restart: 'never',
      },
    });
    initialState = store.saveRuntimeState({
      serverId: server.id,
      status: 'ready',
      protocolVersion: '2026-07-28',
      protocolEra: 'modern',
      processId: null,
      restartCount: 0,
      lastSuccessAt: '2026-01-01T00:00:00.000Z',
      lastError: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    manager = new UpstreamManager(
      store,
      { resolve: () => ({ headers: {}, env: {} }) },
      createLogger('error', () => {}),
    );
    controller = new AbortController();
    context = requestContext(controller.signal);
  });

  afterEach(async () => {
    await manager.close();
    vi.restoreAllMocks();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  for (const timing of ['before execution', 'during execution'] as const) {
    it.each(connectionErrors)(
      `preserves health when cancelled ${timing} and rejected with $message`,
      async (error) => {
        if (timing === 'before execution') controller.abort();
        vi.spyOn(UpstreamAdapter.prototype, 'execute').mockImplementation(async () => {
          if (timing === 'during execution') controller.abort();
          throw error;
        });

        await expect(
          manager.execute(server.id, { method: 'tools/call' }, context, {}),
        ).rejects.toBe(error);

        expect(store.getRuntimeState(server.id)).toEqual(initialState);
        expect(store.listEvents({ serverId: server.id })).toEqual([]);
      },
    );
  }

  it('preserves health for an SDK-wrapped cancellation reason containing connection text', async () => {
    const reason = new Error('Downstream connection closed');
    const error = new SdkError(SdkErrorCode.RequestTimeout, String(reason));
    vi.spyOn(UpstreamAdapter.prototype, 'execute').mockImplementation(async () => {
      controller.abort(reason);
      throw error;
    });

    await expect(manager.execute(server.id, { method: 'tools/call' }, context, {})).rejects.toBe(
      error,
    );

    expect(store.getRuntimeState(server.id)).toEqual(initialState);
    expect(store.listEvents({ serverId: server.id })).toEqual([]);
  });

  it.each(connectionErrors)('marks an uncancelled $message error unreachable', async (error) => {
    vi.spyOn(UpstreamAdapter.prototype, 'execute').mockRejectedValue(error);

    await expect(manager.execute(server.id, { method: 'tools/call' }, context, {})).rejects.toBe(
      error,
    );

    expect(store.getRuntimeState(server.id)).toMatchObject({
      status: 'unreachable',
      lastError: error.message,
    });
    expect(store.listEvents({ serverId: server.id })).toEqual([
      expect.objectContaining({ type: 'server.error', detail: { error: error.message } }),
    ]);
  });

  it.each([
    new Error('Invalid tool arguments'),
    new ProtocolError(-32603, 'Tool failed: fetch failed'),
    new AppError('upstream_jsonrpc_error', 'Tool failed: connection closed'),
  ])('does not treat an ordinary request error as a health failure: $message', async (error) => {
    vi.spyOn(UpstreamAdapter.prototype, 'execute').mockRejectedValue(error);

    await expect(manager.execute(server.id, { method: 'tools/call' }, context, {})).rejects.toBe(
      error,
    );

    expect(store.getRuntimeState(server.id)).toEqual(initialState);
    expect(store.listEvents({ serverId: server.id })).toEqual([]);
  });

  it.each(['Unauthorized', 'Unexpected status 401'])(
    'still marks an uncancelled authentication error auth-required: %s',
    async (message) => {
      const error = new Error(message);
      vi.spyOn(UpstreamAdapter.prototype, 'execute').mockRejectedValue(error);

      await expect(manager.execute(server.id, { method: 'tools/call' }, context, {})).rejects.toBe(
        error,
      );

      expect(store.getRuntimeState(server.id)).toMatchObject({
        status: 'auth-required',
        lastError: message,
      });
      expect(store.listEvents({ serverId: server.id })).toEqual([
        expect.objectContaining({ type: 'server.error', detail: { error: message } }),
      ]);
    },
  );

  it('returns a late successful result without marking a cancelled request ready', async () => {
    initialState = store.saveRuntimeState({
      ...initialState,
      status: 'unreachable',
      lastError: 'Previous connection failure',
    });
    const result = { content: [{ type: 'text', text: 'ok' }] };
    vi.spyOn(UpstreamAdapter.prototype, 'execute').mockImplementation(async () => {
      controller.abort();
      return result;
    });

    await expect(manager.execute(server.id, { method: 'tools/call' }, context, {})).resolves.toBe(
      result,
    );

    expect(store.getRuntimeState(server.id)).toEqual(initialState);
    expect(store.listEvents({ serverId: server.id })).toEqual([]);
  });

  it('still marks an uncancelled successful request ready', async () => {
    store.saveRuntimeState({ ...initialState, status: 'unreachable', lastError: 'fetch failed' });
    const result = {};
    vi.spyOn(UpstreamAdapter.prototype, 'execute').mockResolvedValue(result);

    await expect(manager.execute(server.id, { method: 'tools/call' }, context, {})).resolves.toBe(
      result,
    );

    expect(store.getRuntimeState(server.id)).toMatchObject({ status: 'ready', lastError: null });
    expect(store.listEvents({ serverId: server.id })).toEqual([]);
  });

  it('does not suppress a concurrent genuine failure or let a cancelled result clear it', async () => {
    const started = Promise.withResolvers<void>();
    const cancelledResult = Promise.withResolvers<unknown>();
    const error = new TypeError('fetch failed');
    vi.spyOn(UpstreamAdapter.prototype, 'execute').mockImplementation(async (_request, bridge) => {
      if (bridge.context === context) {
        started.resolve();
        return cancelledResult.promise;
      }
      throw error;
    });
    const pending = manager.execute(server.id, { method: 'tools/call' }, context, {});
    await started.promise;
    controller.abort();

    await expect(
      manager.execute(
        server.id,
        { method: 'tools/call' },
        requestContext(new AbortController().signal),
        {},
      ),
    ).rejects.toBe(error);
    const failedState = store.getRuntimeState(server.id);
    expect(failedState).toMatchObject({ status: 'unreachable', lastError: error.message });

    const result = {};
    cancelledResult.resolve(result);
    await expect(pending).resolves.toBe(result);
    expect(store.getRuntimeState(server.id)).toEqual(failedState);
    expect(store.listEvents({ serverId: server.id })).toEqual([
      expect.objectContaining({ type: 'server.error', detail: { error: error.message } }),
    ]);
  });
});
