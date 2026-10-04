import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlClient } from '../../src/control/client.js';
import type { ServerRecord } from '../../src/domain/models.js';
import { syncLocalProjections } from '../../src/node/local-gateway.js';
import { SecretBox } from '../../src/security/secret-box.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const settings = {
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  maxTotalTimeoutMs: 600_000,
  maxConcurrency: 1,
  restart: 'on-failure' as const,
};

const stdio = {
  type: 'stdio' as const,
  command: 'node',
  args: [],
  env: {},
  protocolMode: 'auto' as const,
};

/** A control-plane record whose id differs from the mirrored server's local id. */
function controlServer(slug: string): ServerRecord {
  const timestamp = '2026-10-04T00:00:00.000Z';
  return {
    id: randomUUID(),
    slug,
    name: slug,
    kind: 'node',
    nodeId: 'laptop',
    transport: stdio,
    credentialId: null,
    enabled: true,
    settings,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createMirror(directory: string, slug: string): SqliteStore {
  const store = new SqliteStore(join(directory, 'node.sqlite'), new SecretBox('local-projection'));
  store.createServer({
    slug,
    name: slug,
    kind: 'node',
    nodeId: 'laptop',
    transport: stdio,
    credentialId: null,
    enabled: true,
    settings,
  });
  return store;
}

describe('local projection synchronization', () => {
  it('mirrors the control projection onto the local id resolved by slug', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-local-projection-'));
    const store = createMirror(directory, 'laptop-chrome');
    const local = store.getServerBySlug('laptop-chrome');
    if (local === null) throw new Error('mirror server missing');
    // Stale rows prove the previous sync is replaced, not merged.
    store.setServerProjection(local.id, 'visible');
    store.setToolProjection(local.id, 'stale-tool', 'hidden');
    const control = controlServer('laptop-chrome');
    const seen: string[] = [];
    const client: Pick<ControlClient, 'request'> = {
      request: async (method, path) => {
        seen.push(`${method} ${path}`);
        return {
          serverId: control.id,
          defaultVisibility: 'hidden',
          overrides: { greet: 'visible' },
          tools: [],
        };
      },
    };

    try {
      await expect(syncLocalProjections(client, store, [control])).resolves.toEqual([
        { slug: 'laptop-chrome', ok: true },
      ]);
      expect(seen).toEqual([`GET /api/v1/servers/${control.id}/projection`]);
      expect(store.getServerProjection(local.id)?.defaultVisibility).toBe('hidden');
      expect(
        store
          .listToolProjections(local.id)
          .map((entry) => [entry.upstreamToolName, entry.visibility]),
      ).toEqual([['greet', 'visible']]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when a projection cannot be read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-local-projection-'));
    const store = createMirror(directory, 'laptop-chrome');
    const local = store.getServerBySlug('laptop-chrome');
    if (local === null) throw new Error('mirror server missing');
    store.setServerProjection(local.id, 'visible');
    store.setToolProjection(local.id, 'greet', 'visible');
    const client: Pick<ControlClient, 'request'> = {
      request: async () => {
        throw new Error('control unavailable');
      },
    };

    try {
      const results = await syncLocalProjections(client, store, [controlServer('laptop-chrome')]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ slug: 'laptop-chrome', ok: false });
      expect(results[0]?.error).toContain('control unavailable');
      expect(store.getServerProjection(local.id)?.defaultVisibility).toBe('hidden');
      expect(store.listToolProjections(local.id)).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports a control server that has no local mirror without hiding others', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-local-projection-'));
    const store = createMirror(directory, 'laptop-chrome');
    const client: Pick<ControlClient, 'request'> = {
      request: async () => {
        throw new Error('must not request a missing mirror');
      },
    };

    try {
      await expect(
        syncLocalProjections(client, store, [controlServer('missing')]),
      ).resolves.toEqual([
        { slug: 'missing', ok: false, error: 'not present in the local mirror' },
      ]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
