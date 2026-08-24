import type { FetchLike } from '@modelcontextprotocol/client';
import { credentialRecordSchema, serverRecordSchema } from '../../src/domain/models.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  connectTestClient,
  structuredResult,
  waitFor,
  type TestMcpClient,
} from '../support/mcp-client.js';
import { startRemoteFixture } from '../support/remote-fixture.js';
import {
  applicationFetch,
  controlRequest,
  createTestRuntime,
  jsonResponse,
} from '../support/runtime.js';

const issuedKeySchema = z.object({
  key: z.object({ id: z.string(), scope: z.string().nullable() }),
  secret: z.string().min(1),
});

const managementToolNames = [
  'home_status',
  'server_list',
  'server_get',
  'market_search',
  'tool_list',
  'calls_query',
  'server_set_enabled',
  'server_refresh',
  'server_restart',
  'market_install',
  'tool_set_visibility',
];

describe('management MCP', () => {
  it('serves read + write tools to control keys, rejects access keys, excludes from aggregate, audits writes and elicits secrets via URL', async () => {
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
            { name: 'Remote bearer', payload: { type: 'bearer', token: 'remote-fixture-token' } },
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
      const control = issuedKeySchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/control-keys',
            { name: 'Manage harness', scope: 'admin' },
          ),
        ),
      );
      const access = issuedKeySchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/access-keys',
            { name: 'Manage harness access' },
          ),
        ),
      );

      const appFetch: FetchLike = (input, init) =>
        applicationFetch(testRuntime.runtime, input, init);

      // Access keys are rejected at /manage/mcp.
      const accessDenied = await appFetch(
        new URL('/manage/mcp', testRuntime.runtime.config.publicUrl),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${access.secret}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'access-test', version: '1' },
            },
          }),
        },
      );
      expect(accessDenied.status).toBe(401);

      // Aggregate endpoint never exposes management tools.
      const aggregate = await connectTestClient(
        new URL('/mcp', testRuntime.runtime.config.publicUrl),
        access.secret,
        appFetch,
      );
      clients.push(aggregate);
      const aggregateTools = (await aggregate.client.listTools()).tools.map((tool) => tool.name);
      for (const name of managementToolNames) {
        expect(aggregateTools, `aggregate must not expose ${name}`).not.toContain(name);
      }

      // Management MCP via a control key.
      const manage = await connectTestClient(
        new URL('/manage/mcp', testRuntime.runtime.config.publicUrl),
        control.secret,
        appFetch,
      );
      clients.push(manage);
      const tools = (await manage.client.listTools()).tools.map((tool) => tool.name);
      for (const name of managementToolNames) {
        expect(tools).toContain(name);
      }

      // Read tools.
      const status = structuredResult(await manage.client.callTool({ name: 'home_status', arguments: {} }));
      expect(status.overview).toBeDefined();
      expect(String(status.managementEndpoint)).toContain('/manage/mcp');

      const servers = structuredResult(await manage.client.callTool({ name: 'server_list', arguments: {} }));
      expect((servers.servers as { slug: string }[]).map((item) => item.slug)).toContain('remote');

      const serverGet = structuredResult(
        await manage.client.callTool({ name: 'server_get', arguments: { server_id: server.id } }),
      );
      expect((serverGet.server as { id: string }).id).toBe(server.id);
      expect((serverGet.server as { toolCount: number }).toolCount).toBeGreaterThan(0);

      const search = structuredResult(
        await manage.client.callTool({ name: 'market_search', arguments: { query: 'context7' } }),
      );
      expect((search.entries as { id: string }[]).some((entry) => entry.id === 'context7')).toBe(true);

      const tools2 = structuredResult(
        await manage.client.callTool({ name: 'tool_list', arguments: { server_id: server.id } }),
      );
      expect((tools2.tools as { name: string }[]).map((tool) => tool.name)).toContain('echo');

      const calls = structuredResult(
        await manage.client.callTool({ name: 'calls_query', arguments: { limit: 10 } }),
      );
      expect(Array.isArray(calls.calls)).toBe(true);

      // Idempotent write: enable twice produces no error and no state change.
      const enable = structuredResult(
        await manage.client.callTool({
          name: 'server_set_enabled',
          arguments: { server_id: server.id, enabled: true },
        }),
      );
      expect(enable.ok).toBe(true);
      const disable = structuredResult(
        await manage.client.callTool({
          name: 'server_set_enabled',
          arguments: { server_id: server.id, enabled: false },
        }),
      );
      expect(disable.ok).toBe(true);
      const reenable = structuredResult(
        await manage.client.callTool({
          name: 'server_set_enabled',
          arguments: { server_id: server.id, enabled: true },
        }),
      );
      expect(reenable.ok).toBe(true);

      await manage.client.callTool({ name: 'server_refresh', arguments: { server_id: server.id } });
      await manage.client.callTool({ name: 'server_restart', arguments: { server_id: server.id } });

      // Idempotent visibility write.
      const vis = structuredResult(
        await manage.client.callTool({
          name: 'tool_set_visibility',
          arguments: { server_id: server.id, tool: 'echo', visibility: 'hidden' },
        }),
      );
      expect(vis.ok).toBe(true);
      const visAgain = structuredResult(
        await manage.client.callTool({
          name: 'tool_set_visibility',
          arguments: { server_id: server.id, tool: 'echo', visibility: 'hidden' },
        }),
      );
      expect(visAgain.unchanged).toBe(true);

      // market_install: secret-free entry installs; repeat is idempotent.
      const installed = structuredResult(
        await manage.client.callTool({
          name: 'market_install',
          arguments: { entry_id: 'context7', values: { CONTEXT7_API_KEY: 'ctx-test' } },
        }),
      );
      expect(installed.status).toBe('installing');
      const installedAgain = structuredResult(
        await manage.client.callTool({
          name: 'market_install',
          arguments: { entry_id: 'context7', values: { CONTEXT7_API_KEY: 'ctx-test' } },
        }),
      );
      expect(installedAgain.status).toBe('already_installed');

      // market_install on a secret-requiring entry returns a one-time URL and never the secret.
      const elicit = structuredResult(
        await manage.client.callTool({ name: 'market_install', arguments: { entry_id: 'exa' } }),
      );
      expect(elicit.status).toBe('awaiting_secret');
      expect(String(elicit.actionUrl)).toMatch(/^http:\/\/toolhome\.test\/market\/actions\//);
      expect(JSON.stringify(elicit)).not.toContain('EXA_API_KEY');

      // Completing the action through the control session stores the secret and installs.
      const url = new URL(String(elicit.actionUrl));
      const actionId = url.pathname.split('/').pop();
      const token = url.searchParams.get('token') ?? '';
      const completed = await controlRequest(
        testRuntime.runtime,
        control.secret,
        'POST',
        `/api/v1/secure-actions/${actionId}/complete`,
        { token, values: { EXA_API_KEY: 'exa-secret-value' } },
      );
      expect(completed.status).toBe(200);
      await waitFor(async () => {
        const exaJob = (await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            control.secret,
            'GET',
            `/api/v1/market/install/${elicit.jobId}`,
          ),
        )) as { status: string };
        return exaJob.status === 'completed' || exaJob.status === 'failed';
      });
      const exaServer = (await jsonResponse(
        await controlRequest(testRuntime.runtime, control.secret, 'GET', '/api/v1/servers'),
      )) as { slug: string }[];
      expect(exaServer.some((item) => item.slug === 'exa')).toBe(true);
      // Newly installed server surfaces to connected clients via list_changed.
      await waitFor(() => aggregate.listChanges.tools > 0);

      // Completing the same action twice is rejected (one-time use).
      const replay = await controlRequest(
        testRuntime.runtime,
        control.secret,
        'POST',
        `/api/v1/secure-actions/${actionId}/complete`,
        { token, values: { EXA_API_KEY: 'again' } },
      );
      expect(replay.status).toBe(400);

      // Every management write is audited in the call log.
      await waitFor(async () => {
        const audit = (await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            control.secret,
            'GET',
            '/api/v1/calls?limit=100&endpoint_type=management',
          ),
        )) as { total: number; items: { exposedToolName: string; status: string; principalKind: string }[] };
        return (
          audit.total >= 10 &&
          audit.items.some((item) => item.exposedToolName === 'server_set_enabled') &&
          audit.items.some((item) => item.exposedToolName === 'market_install') &&
          audit.items.some((item) => item.exposedToolName === 'tool_set_visibility') &&
          audit.items.every((item) => item.principalKind === 'control_key')
        );
      });

      // Installed entries are recorded with source + pinned version.
      const installations = (await jsonResponse(
        await controlRequest(
          testRuntime.runtime,
          control.secret,
          'GET',
          '/api/v1/market/installations',
        ),
      )) as { entryId: string; source: string }[];
      expect(installations.find((item) => item.entryId === 'context7')?.source).toBe('curated');

      // Series endpoint returns zero-filled buckets for the chart.
      const now = Date.now();
      const series = (await jsonResponse(
        await controlRequest(
          testRuntime.runtime,
          control.secret,
          'GET',
          `/api/v1/calls/series?bucket=1h&from=${encodeURIComponent(new Date(now - 3 * 3_600_000).toISOString())}&to=${encodeURIComponent(new Date(now).toISOString())}`,
        ),
      )) as { bucketSeconds: number; points: { bucket: string; total: number }[] };
      expect(series.bucketSeconds).toBe(3600);
      expect(series.points.length).toBeGreaterThanOrEqual(3);
    } finally {
      for (const client of clients) await client.close().catch(() => undefined);
      await testRuntime.close();
      await remote.close();
    }
  });
});
