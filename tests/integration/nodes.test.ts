import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { controlRequest, createTestRuntime, jsonResponse } from '../support/runtime.js';
import { SecretBox } from '../../src/security/secret-box.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const serverSchema = z
  .object({
    slug: z.string(),
    kind: z.enum(['remote', 'home', 'node']),
    nodeId: z.string().nullable(),
    nodeReport: z
      .object({
        status: z.string(),
        probeOk: z.boolean().nullable(),
        probeDetail: z.string().nullable(),
        tools: z.number().nullable(),
        stale: z.boolean(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

async function seed(
  rt: ReturnType<typeof createTestRuntime>,
): Promise<{ nodeId: string; remoteId: string }> {
  const nodeId = z.object({ id: z.string() }).parse(
    await jsonResponse(
      await controlRequest(rt.runtime, rt.controlKey, 'POST', '/api/v1/servers', {
        slug: 'chrome-devtools',
        name: 'Local Chrome',
        kind: 'node',
        nodeId: 'crayons-air',
        transport: { type: 'stdio', command: 'npx', args: ['chrome-devtools-mcp@1.6.0'] },
        enabled: true,
        settings: {},
      }),
    ),
  ).id;
  const remoteId = z.object({ id: z.string() }).parse(
    await jsonResponse(
      await controlRequest(rt.runtime, rt.controlKey, 'POST', '/api/v1/servers', {
        slug: 'firecrawl',
        name: 'Firecrawl',
        kind: 'remote',
        transport: { type: 'streamable-http', url: 'https://mcp.firecrawl.dev/v2/mcp' },
        enabled: true,
        settings: {},
      }),
    ),
  ).id;
  return { nodeId, remoteId };
}

async function listServers(rt: ReturnType<typeof createTestRuntime>) {
  return z
    .array(serverSchema)
    .parse(
      await jsonResponse(
        await controlRequest(rt.runtime, rt.controlKey, 'GET', '/api/v1/servers'),
      ),
    );
}

describe('node reports', () => {
  it('shows what the machine reports, and nothing for other placements', async () => {
    const rt = createTestRuntime();
    try {
      await seed(rt);
      const response = z
        .object({
          nodeId: z.string(),
          accepted: z.array(z.object({ slug: z.string(), status: z.string() })),
          rejected: z.array(z.object({ slug: z.string(), reason: z.string() })),
        })
        .parse(
          await jsonResponse(
            await controlRequest(
              rt.runtime,
              rt.controlKey,
              'POST',
              '/api/v1/nodes/crayons-air/report',
              {
                servers: [
                  {
                    slug: 'chrome-devtools',
                    status: 'ready',
                    probeOk: true,
                    probeDetail: 'npx',
                    tools: 26,
                  },
                ],
              },
            ),
          ),
        );
      expect(response.accepted).toEqual([{ slug: 'chrome-devtools', status: 'ready' }]);
      expect(response.rejected).toEqual([]);

      const servers = await listServers(rt);
      const node = servers.find((server) => server.slug === 'chrome-devtools');
      expect(node?.nodeReport).toMatchObject({
        status: 'ready',
        probeOk: true,
        tools: 26,
        stale: false,
      });
      // A host-run server never gets a node report.
      expect(servers.find((server) => server.slug === 'firecrawl')?.nodeReport ?? null).toBeNull();
      // The host's own measurement for a node server stays absent by design.
      const raw = servers.find((server) => server.slug === 'chrome-devtools');
      expect(raw).toBeDefined();
    } finally {
      await rt.close();
    }
  });

  it('refuses reports for servers this machine does not run', async () => {
    const rt = createTestRuntime();
    try {
      await seed(rt);
      const response = z
        .object({
          accepted: z.array(z.unknown()),
          rejected: z.array(z.object({ slug: z.string(), reason: z.string() })),
        })
        .parse(
          await jsonResponse(
            await controlRequest(
              rt.runtime,
              rt.controlKey,
              'POST',
              '/api/v1/nodes/crayons-air/report',
              {
                servers: [
                  { slug: 'firecrawl', status: 'ready' },
                  { slug: 'chrome-devtools', status: 'ready' },
                ],
              },
            ),
          ),
        );
      expect(response.accepted).toEqual([{ slug: 'chrome-devtools', status: 'ready' }]);
      expect(response.rejected).toEqual([
        { slug: 'firecrawl', reason: 'not placed on node "crayons-air"' },
      ]);

      // Another machine cannot claim this node's servers either.
      const other = z
        .object({ rejected: z.array(z.object({ reason: z.string() })) })
        .parse(
          await jsonResponse(
            await controlRequest(
              rt.runtime,
              rt.controlKey,
              'POST',
              '/api/v1/nodes/R9000P/report',
              { servers: [{ slug: 'chrome-devtools', status: 'ready' }] },
            ),
          ),
        );
      expect(other.rejected[0]?.reason).toContain('R9000P');
    } finally {
      await rt.close();
    }
  });

  it('ages a report rather than presenting a silent machine as current', async () => {
    const rt = createTestRuntime();
    try {
      const { nodeId } = await seed(rt);
      // Reach into the same database to backdate the report past the TTL.
      const store = new SqliteStore(
        join(rt.directory, 'toolhome.sqlite'),
        new SecretBox('test-master-encryption-key-0000000000000000000001'),
      );
      store.saveNodeReport({
        serverId: nodeId,
        nodeId: 'crayons-air',
        status: 'ready',
        lastError: null,
        probeOk: true,
        probeDetail: 'npx',
        tools: 3,
        reportedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
      store.close();

      const node = (await listServers(rt)).find((server) => server.slug === 'chrome-devtools');
      expect(node?.nodeReport).toMatchObject({ status: 'ready', stale: true });
    } finally {
      await rt.close();
    }
  });
});
