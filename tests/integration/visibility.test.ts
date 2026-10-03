import type { FetchLike } from '@modelcontextprotocol/client';
import { credentialRecordSchema, serverRecordSchema } from '../../src/domain/models.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { connectTestClient, waitFor, type TestMcpClient } from '../support/mcp-client.js';
import { startRemoteFixture } from '../support/remote-fixture.js';
import {
  applicationFetch,
  controlRequest,
  createTestRuntime,
  jsonResponse,
} from '../support/runtime.js';

const issuedKeySchema = z.object({
  key: z.object({ id: z.string() }),
  secret: z.string().min(1),
});

describe('tool visibility projection', () => {
  it('hides tools at the aggregate endpoint only, and records calls', async () => {
    const remote = await startRemoteFixture();
    const testRuntime = createTestRuntime();
    const clients: TestMcpClient[] = [];
    try {
      const credential = credentialRecordSchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/credentials',
            {
              name: 'Remote bearer',
              payload: { type: 'bearer', token: 'remote-fixture-token' },
            },
          ),
        ),
      );
      const server = serverRecordSchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/servers',
            {
              slug: 'remote',
              name: 'Remote fixture',
              kind: 'remote',
              transport: {
                type: 'streamable-http',
                url: remote.url.toString(),
                protocolMode: 'modern',
                allowSseFallback: false,
                headers: {},
              },
              credentialId: credential.id,
              enabled: true,
              settings: { maxConcurrency: 2 },
            },
          ),
        ),
      );
      await jsonResponse(
        await controlRequest(
          testRuntime.runtime,
          testRuntime.controlKey,
          'POST',
          `/api/v1/servers/${server.id}/refresh`,
        ),
      );

      const access = issuedKeySchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/access-keys',
            { name: 'Visibility harness' },
          ),
        ),
      );

      const appFetch: FetchLike = (input, init) =>
        applicationFetch(testRuntime.runtime, input, init);
      const aggregate = await connectTestClient(
        new URL('/mcp', testRuntime.runtime.config.publicUrl),
        access.secret,
        appFetch,
      );
      clients.push(aggregate);

      // Before hiding: echo is listed and callable at the aggregate.
      const before = await aggregate.client.listTools();
      expect(before.tools.map((tool) => tool.name)).toContain('remote_echo');
      await aggregate.client.callTool({ name: 'remote_echo', arguments: { value: 1 } });

      // Hide the upstream echo tool through the control API.
      const projection = (await jsonResponse(
        await controlRequest(
          testRuntime.runtime,
          testRuntime.controlKey,
          'PATCH',
          `/api/v1/servers/${server.id}/projection`,
          { overrides: [{ tool: 'echo', visibility: 'hidden' }] },
        ),
      )) as { tools: { name: string; visible: boolean }[] };
      expect(projection.tools.find((tool) => tool.name === 'echo')?.visible).toBe(false);

      // Connected clients get tools/list_changed.
      await waitFor(() => aggregate.listChanges.tools > 0);

      // Aggregate list no longer exposes the hidden tool.
      const after = await aggregate.client.listTools();
      const names = after.tools.map((tool) => tool.name);
      expect(names).not.toContain('remote_echo');
      expect(names).toContain('remote_progress');

      // Aggregate call to a hidden tool is rejected (never forwarded).
      await expect(
        aggregate.client.callTool({ name: 'remote_echo', arguments: {} }),
      ).rejects.toThrow();

      // Individual endpoint stays lossless.
      const individual = await connectTestClient(
        new URL('/mcp/remote', testRuntime.runtime.config.publicUrl),
        access.secret,
        appFetch,
      );
      clients.push(individual);
      const individualTools = await individual.client.listTools();
      expect(individualTools.tools.map((tool) => tool.name)).toContain('echo');
      await individual.client.callTool({ name: 'echo', arguments: { value: 2 } });

      // Records land for aggregate success, aggregate rejection and individual.
      await waitFor(async () => {
        const result = (await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'GET',
            '/api/v1/calls?limit=50',
          ),
        )) as { total: number };
        return result.total >= 3;
      });
      const calls = (await jsonResponse(
        await controlRequest(
          testRuntime.runtime,
          testRuntime.controlKey,
          'GET',
          '/api/v1/calls?limit=50',
        ),
      )) as {
        items: {
          endpointType: string;
          exposedToolName: string;
          status: string;
          principalKind: string;
        }[];
      };
      const byEndpoint = Object.groupBy(calls.items, (call) => call.endpointType);
      const aggregateCalls = byEndpoint.aggregate ?? [];
      const individualCalls = byEndpoint.individual ?? [];
      expect(aggregateCalls.length).toBeGreaterThanOrEqual(2);
      expect(individualCalls.length).toBeGreaterThanOrEqual(1);
      expect(calls.items.every((call) => call.principalKind === 'access_key')).toBe(true);
      expect(
        aggregateCalls.some(
          (call) => call.exposedToolName === 'remote_echo' && call.status === 'protocol_error',
        ),
      ).toBe(true);

      // Stats endpoint aggregates the same rows.
      const stats = (await jsonResponse(
        await controlRequest(
          testRuntime.runtime,
          testRuntime.controlKey,
          'GET',
          '/api/v1/calls/stats',
        ),
      )) as { total: number; success: number; topTools: { tool: string; count: number }[] };
      expect(stats.total).toBeGreaterThanOrEqual(3);
      expect(stats.success).toBeGreaterThanOrEqual(2);
      expect(stats.topTools.some((item) => item.tool === 'echo')).toBe(true);
    } finally {
      for (const client of clients) await client.close().catch(() => undefined);
      await testRuntime.close();
      await remote.close();
    }
  });
});
