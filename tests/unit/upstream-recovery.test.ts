import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeState, ServerRecord } from '../../src/domain/models.js';
import { createLogger } from '../../src/observability/logger.js';
import { SecretBox } from '../../src/security/secret-box.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { UpstreamManager } from '../../src/upstream/manager.js';
import { startRemoteFixture, type RemoteFixture } from '../support/remote-fixture.js';

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Test port unavailable');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForStatus(
  store: SqliteStore,
  serverId: string,
  status: RuntimeState['status'],
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (store.getRuntimeState(serverId)?.status === status) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `status for ${serverId} is ${store.getRuntimeState(serverId)?.status}, expected ${status}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('UpstreamManager transient failure recovery', () => {
  let directory: string;
  let store: SqliteStore;
  let manager: UpstreamManager;
  let fixture: RemoteFixture | null;

  afterEach(async () => {
    await manager.close();
    await fixture?.close().catch(() => undefined);
    fixture = null;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function setupRemoteServer(port: number, name: string): ServerRecord {
    directory = mkdtempSync(join(tmpdir(), 'toolhome-upstream-recovery-'));
    store = new SqliteStore(join(directory, 'test.sqlite'), new SecretBox('recovery-test-key'));
    return store.createServer({
      slug: name,
      name,
      kind: 'remote',
      nodeId: null,
      transport: {
        type: 'streamable-http',
        url: `http://127.0.0.1:${port}/mcp`,
        protocolMode: 'modern',
        allowSseFallback: false,
        headers: {},
      },
      credentialId: null,
      enabled: true,
      settings: {
        connectTimeoutMs: 5_000,
        requestTimeoutMs: 30_000,
        maxTotalTimeoutMs: 60_000,
        maxConcurrency: 1,
        restart: 'never',
      },
    });
  }

  it('self-heals an unreachable remote server once the upstream answers again', async () => {
    const port = await freePort();
    const server = setupRemoteServer(port, 'flapping');
    manager = new UpstreamManager(
      store,
      { resolve: () => ({ headers: {}, env: {} }) },
      createLogger('error', () => {}),
      { recoveryDelaysMs: [25] },
    );

    await expect(manager.refresh(server.id)).rejects.toThrow();
    expect(store.getRuntimeState(server.id)).toMatchObject({
      status: 'unreachable',
      lastError: expect.stringContaining('fetch failed'),
    });
    // The recorded failure keeps the underlying network reason instead of the
    // bare `fetch failed` that undici reports.
    expect(store.getRuntimeState(server.id)?.lastError).toMatch(
      /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/,
    );

    // The upstream comes back with no operator action and no client request.
    fixture = await startRemoteFixture(port);
    await waitForStatus(store, server.id, 'ready');

    const snapshot = store.getSnapshot(server.id);
    expect(snapshot?.tools.length ?? 0).toBeGreaterThan(0);
    expect(store.getRuntimeState(server.id)).toMatchObject({ status: 'ready', lastError: null });
  });

  it('stops retrying after the bounded schedule and keeps reporting the failure', async () => {
    const port = await freePort();
    const server = setupRemoteServer(port, 'offline');
    manager = new UpstreamManager(
      store,
      { resolve: () => ({ headers: {}, env: {} }) },
      createLogger('error', () => {}),
      { recoveryDelaysMs: [20, 20] },
    );

    await expect(manager.refresh(server.id)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const errors = store
      .listEvents({ serverId: server.id })
      .filter((event) => event.type === 'server.error');
    expect(errors).toHaveLength(3);
    expect(store.getRuntimeState(server.id)).toMatchObject({ status: 'unreachable' });
  });
});
