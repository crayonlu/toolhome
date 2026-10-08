import type { FetchLike } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { serverRecordSchema } from '../../src/domain/models.js';
import { UpstreamAdapter } from '../../src/upstream/adapter.js';
import { connectTestClient, type TestMcpClient } from '../support/mcp-client.js';
import { startRemoteFixture } from '../support/remote-fixture.js';
import {
  applicationFetch,
  controlRequest,
  createTestRuntime,
  jsonResponse,
} from '../support/runtime.js';

/**
 * One fixture backs many server records, so the aggregate catalog spans more
 * than one 100-tool page. A transient upstream list failure must not change the
 * catalog between pages: the continuation cursor is keyed by the page-1 tool
 * set, so any churn makes a real client fail with "Cursor is invalid or stale".
 */
const serverCount = 40;

async function setup() {
  const remote = await startRemoteFixture();
  const test = createTestRuntime();
  const clients: TestMcpClient[] = [];
  const servers = [];
  try {
    for (let index = 0; index < serverCount; index += 1) {
      const slug = `page${String(index).padStart(3, '0')}`;
      const server = serverRecordSchema.parse(
        await jsonResponse(
          await controlRequest(test.runtime, test.controlKey, 'POST', '/api/v1/servers', {
            slug,
            name: slug,
            kind: 'remote',
            enabled: true,
            transport: {
              type: 'streamable-http',
              url: remote.url.toString(),
              protocolMode: 'modern',
              headers: {},
            },
          }),
        ),
      );
      await jsonResponse(
        await controlRequest(
          test.runtime,
          test.controlKey,
          'POST',
          `/api/v1/servers/${server.id}/refresh`,
        ),
      );
      servers.push(server);
    }
    // Two access keys, so a second read is a distinct cache principal and
    // therefore always performs its own traversal instead of reusing the
    // 30-second continuation cache of the first read.
    const secrets: string[] = [];
    for (const name of ['Pagination stability harness A', 'Pagination stability harness B']) {
      const access = (await jsonResponse(
        await controlRequest(test.runtime, test.controlKey, 'POST', '/api/v1/access-keys', {
          name,
        }),
      )) as { secret: string };
      secrets.push(access.secret);
    }
    const appFetch: FetchLike = (input, init) => applicationFetch(test.runtime, input, init);
    return {
      test,
      servers,
      async connect(secretIndex = 0): Promise<TestMcpClient['client']> {
        const client = await connectTestClient(
          new URL('/mcp', test.runtime.config.publicUrl),
          secrets[secretIndex]!,
          appFetch,
        );
        clients.push(client);
        return client.client;
      },
      async close() {
        vi.restoreAllMocks();
        for (const client of clients) await client.close().catch(() => undefined);
        await test.close();
        await remote.close();
      },
    };
  } catch (error) {
    await test.close();
    await remote.close();
    throw error;
  }
}

function namesFrom(tools: Array<{ name: string }>): string {
  return tools.map((tool) => tool.name).join(',');
}

describe('aggregate pagination under a transient upstream list failure', () => {
  it('keeps a paginated catalog read valid when one upstream list call fails once', async () => {
    const env = await setup();
    try {
      const healthy = await (await env.connect(0)).listTools(undefined, { cacheMode: 'refresh' });
      expect(healthy.tools.length).toBeGreaterThan(100);

      // Exactly the production failure: one upstream's first list call fails,
      // then that upstream answers again for the continuation page.
      const execute = UpstreamAdapter.prototype.execute;
      let remainingFailures = 1;
      vi.spyOn(UpstreamAdapter.prototype, 'execute').mockImplementation(async function (
        this: UpstreamAdapter,
        request,
        bridge,
      ) {
        if (
          remainingFailures > 0 &&
          this.server.id === env.servers[0]!.id &&
          request.method.endsWith('/list')
        ) {
          remainingFailures -= 1;
          throw new Error('fetch failed');
        }
        return execute.call(this, request, bridge);
      });

      const duringFailure = await (
        await env.connect(1)
      ).listTools(undefined, {
        cacheMode: 'refresh',
      });
      expect(namesFrom(duringFailure.tools)).toBe(namesFrom(healthy.tools));
      expect(duringFailure._meta?.['toolhome/failed-servers']).toBeUndefined();
      expect(duringFailure._meta?.['toolhome/stale-servers']).toEqual([env.servers[0]!.slug]);
    } finally {
      await env.close();
    }
  });

  it('still prefers a live list over the snapshot when the upstream answers', async () => {
    const env = await setup();
    try {
      const execute = UpstreamAdapter.prototype.execute;
      vi.spyOn(UpstreamAdapter.prototype, 'execute').mockImplementation(async function (
        this: UpstreamAdapter,
        request,
        bridge,
      ) {
        const raw = (await execute.call(this, request, bridge)) as {
          tools?: Array<Record<string, unknown>>;
        };
        if (this.server.id === env.servers[0]!.id && request.method === 'tools/list' && raw.tools) {
          return {
            ...raw,
            tools: [...raw.tools, { name: 'liveonlytool', inputSchema: { type: 'object' } }],
          };
        }
        return raw;
      });

      const listed = await (await env.connect(1)).listTools(undefined, { cacheMode: 'refresh' });
      expect(listed.tools.some((tool) => tool.name.includes('liveonlytool'))).toBe(true);
      expect(listed._meta?.['toolhome/stale-servers']).toBeUndefined();
      expect(listed._meta?.['toolhome/failed-servers']).toBeUndefined();
    } finally {
      await env.close();
    }
  });
});
