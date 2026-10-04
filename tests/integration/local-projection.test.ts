import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlClient } from '../../src/control/client.js';
import { prepareLocalGateway, type LocalGatewayRuntime } from '../../src/node/local-gateway.js';
import { controlRequest, createTestRuntime, jsonResponse } from '../support/runtime.js';

function mirrorId(gateway: LocalGatewayRuntime): string {
  const mirrored = gateway.store.getServerBySlug('local-fixture');
  if (mirrored === null) throw new Error('mirror server missing');
  return mirrored.id;
}

describe('local gateway projection mirroring', () => {
  it('mirrors control visibility for compact and leaves full untouched', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-local-projection-'));
    const runtime = createTestRuntime({ config: { allowedHosts: ['toolhome.test', '127.0.0.1'] } });
    const server = serve({ fetch: runtime.runtime.app.fetch, hostname: '127.0.0.1', port: 0 });
    let first: LocalGatewayRuntime | undefined;
    let second: LocalGatewayRuntime | undefined;
    let third: LocalGatewayRuntime | undefined;
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test address unavailable');
      const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
      const created = (await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/servers', {
          slug: 'local-fixture',
          name: 'Local fixture',
          kind: 'node',
          nodeId: 'local-test',
          transport: {
            type: 'stdio',
            command: process.execPath,
            args: ['--version'],
            protocolMode: 'legacy',
          },
        }),
      )) as { id: string };
      const setProjection = async (
        defaultVisibility: 'visible' | 'hidden',
        toolVisibility: 'visible' | 'hidden' | 'inherit',
      ): Promise<void> => {
        await jsonResponse(
          await controlRequest(
            runtime.runtime,
            runtime.controlKey,
            'PATCH',
            `/api/v1/servers/${created.id}/projection`,
            { defaultVisibility, overrides: [{ tool: 'echo', visibility: toolVisibility }] },
          ),
        );
      };
      await setProjection('hidden', 'visible');

      const client = new ControlClient(baseUrl, runtime.controlKey);
      const storePath = join(directory, 'node.sqlite');

      // Compact mirrors the control projection onto the local mirror.
      first = await prepareLocalGateway({
        client,
        nodeId: 'local-test',
        storePath,
        toolMode: 'compact',
      });
      expect(first.store.getServerProjection(mirrorId(first))?.defaultVisibility).toBe('hidden');
      expect(
        first.store
          .listToolProjections(mirrorId(first))
          .map((entry) => [entry.upstreamToolName, entry.visibility]),
      ).toEqual([['echo', 'visible']]);
      await first.close();
      first.store.close();
      first = undefined;

      // Full mode clears compact rows instead of syncing: control says hidden,
      // but full exposure must stay all-visible.
      await setProjection('hidden', 'inherit');
      second = await prepareLocalGateway({ client, nodeId: 'local-test', storePath });
      expect(second.store.getServerProjection(mirrorId(second))?.defaultVisibility).toBe('visible');
      expect(second.store.listToolProjections(mirrorId(second))).toEqual([]);
      await second.close();
      second.store.close();
      second = undefined;

      // A later compact start re-mirrors the hidden control projection.
      third = await prepareLocalGateway({
        client,
        nodeId: 'local-test',
        storePath,
        toolMode: 'compact',
      });
      expect(third.store.getServerProjection(mirrorId(third))?.defaultVisibility).toBe('hidden');
      expect(third.store.listToolProjections(mirrorId(third))).toEqual([]);
    } finally {
      await first?.close().catch(() => undefined);
      await second?.close().catch(() => undefined);
      await third?.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
