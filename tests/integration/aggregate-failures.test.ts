import { ListToolsResultSchema, ResultSchema } from '@modelcontextprotocol/core';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { serve } from '@hono/node-server';
import { once } from 'node:events';
import type { FetchLike } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { serverRecordSchema } from '../../src/domain/models.js';
import { UpstreamAdapter } from '../../src/upstream/adapter.js';
import { connectTestClient, waitFor, type TestMcpClient } from '../support/mcp-client.js';
import { startRemoteFixture } from '../support/remote-fixture.js';
import {
  applicationFetch,
  controlRequest,
  createTestRuntime,
  jsonResponse,
} from '../support/runtime.js';

const listMethods = ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list'];

async function setup() {
  const remote = await startRemoteFixture();
  const test = createTestRuntime();
  const clients: TestMcpClient[] = [];
  const servers = [];
  try {
    for (const slug of ['healthy', 'failing']) {
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
    const access = (await jsonResponse(
      await controlRequest(test.runtime, test.controlKey, 'POST', '/api/v1/access-keys', {
        name: 'Failure harness',
      }),
    )) as { secret: string };
    const appFetch: FetchLike = (input, init) => applicationFetch(test.runtime, input, init);
    const connect = async (path: string) => {
      const client = await connectTestClient(
        new URL(path, test.runtime.config.publicUrl),
        access.secret,
        appFetch,
      );
      clients.push(client);
      return client.client;
    };
    return {
      test,
      servers,
      connect,
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

async function lists(client: TestMcpClient['client']) {
  return [
    await client.listTools(undefined, { cacheMode: 'bypass' }),
    await client.listPrompts(undefined, { cacheMode: 'bypass' }),
    await client.listResources(undefined, { cacheMode: 'bypass' }),
    await client.listResourceTemplates(undefined, { cacheMode: 'bypass' }),
  ] as const;
}

function identifiers(results: Awaited<ReturnType<typeof lists>>) {
  return [
    results[0]!.tools.map((item) => item.name),
    results[1]!.prompts.map((item) => item.name),
    results[2]!.resources.map((item) => item.uri),
    results[3]!.resourceTemplates.map((item) => item.uriTemplate),
  ];
}

describe('aggregate upstream failure isolation', () => {
  it('serves the last known good snapshot when an upstream list fails and recovers afterwards', async () => {
    const env = await setup();
    try {
      const client = await env.connect('/mcp');
      const before = identifiers(await lists(client));
      const execute = UpstreamAdapter.prototype.execute;
      let fail = true;
      vi.spyOn(UpstreamAdapter.prototype, 'execute').mockImplementation(async function (
        this: UpstreamAdapter,
        request,
        bridge,
      ) {
        if (fail && this.server.id === env.servers[1]!.id && listMethods.includes(request.method)) {
          throw new Error('fetch failed');
        }
        return execute.call(this, request, bridge);
      });
      const partial = await lists(client);
      // Steady catalogs are what keep client pagination cursors valid, so the
      // failing upstream is served from its last known good snapshot.
      for (const result of partial) {
        expect(result._meta?.['toolhome/stale-servers']).toEqual(['failing']);
        expect(result._meta?.['toolhome/failed-servers']).toBeUndefined();
      }
      for (const [index, ids] of identifiers(partial).entries()) {
        expect(ids.length).toBeGreaterThan(0);
        expect(ids).toEqual(before[index]!);
      }
      const called = await client.callTool({ name: 'healthy_echo', arguments: { value: 'works' } });
      expect(called.isError).not.toBe(true);
      await expect(client.callTool({ name: 'failing_echo', arguments: {} })).rejects.toThrow(
        'fetch failed',
      );
      const diagnostics = (await jsonResponse(
        await controlRequest(env.test.runtime, env.test.controlKey, 'GET', '/api/v1/diagnostics'),
      )) as { ok: boolean; servers: { slug: string; status: string }[] };
      expect(diagnostics.ok).toBe(false);
      expect(diagnostics.servers.find((server) => server.slug === 'healthy')?.status).toBe('ready');
      expect(diagnostics.servers.find((server) => server.slug === 'failing')?.status).toBe(
        'unreachable',
      );
      const failedStatus = (await jsonResponse(
        await controlRequest(
          env.test.runtime,
          env.test.controlKey,
          'GET',
          `/api/v1/servers/${env.servers[1]!.id}/status`,
        ),
      )) as { runtime: { lastError: string } };
      expect(failedStatus.runtime.lastError).toBe('fetch failed');
      const individual = await env.connect('/mcp/failing');
      await expect(individual.listTools(undefined, { cacheMode: 'bypass' })).rejects.toThrow(
        'fetch failed',
      );
      fail = false;
      const recovered = await lists(client);
      expect(identifiers(recovered)).toEqual(before);
      expect(env.test.runtime.store.getRuntimeState(env.servers[1]!.id)?.status).toBe('ready');
      for (const result of recovered) {
        expect(result._meta?.['toolhome/failed-servers']).toBeUndefined();
        expect(result._meta?.['toolhome/stale-servers']).toBeUndefined();
      }
      expect(
        (await individual.listTools(undefined, { cacheMode: 'bypass' })).tools.length,
      ).toBeGreaterThan(0);
    } finally {
      await env.close();
    }
  });

  it('uses the snapshot instead of a half-read upstream list and preserves execution errors', async () => {
    const env = await setup();
    try {
      const client = await env.connect('/mcp');
      const execute = env.test.runtime.upstreams.execute.bind(env.test.runtime.upstreams);
      let pageFailure = true;
      vi.spyOn(env.test.runtime.upstreams, 'execute').mockImplementation(async (...args) => {
        if (args[0] === env.servers[1]!.id && args[1].method === 'tools/list' && pageFailure) {
          if (args[1].params?.cursor) throw new Error('second page failed');
          return {
            tools: [{ name: 'leaked', inputSchema: { type: 'object' } }],
            nextCursor: 'upstream-page-two',
          };
        }
        if (
          args[0] === env.servers[1]!.id &&
          ['tools/call', 'prompts/get', 'resources/read'].includes(args[1].method)
        ) {
          throw new Error('upstream execution failed');
        }
        return execute(...args);
      });
      const partial = await client.listTools(undefined, { cacheMode: 'bypass' });
      // The half-read upstream page is discarded in favour of the snapshot.
      expect(partial.tools.some((tool) => tool.name.includes('leaked'))).toBe(false);
      expect(partial.tools.some((tool) => tool.name.startsWith('failing_'))).toBe(true);
      expect(partial._meta?.['toolhome/stale-servers']).toEqual(['failing']);
      expect(partial._meta?.['toolhome/failed-servers']).toBeUndefined();
      pageFailure = false;
      await expect(client.callTool({ name: 'failing_echo', arguments: {} })).rejects.toThrow(
        'upstream execution failed',
      );
      await expect(
        client.getPrompt({ name: 'failing.greet', arguments: { name: 'test' } }),
      ).rejects.toThrow('upstream execution failed');
      const resource = (
        await client.listResources(undefined, { cacheMode: 'bypass' })
      ).resources.find((item) => item.uri.includes('failing'))!;
      await expect(client.readResource({ uri: resource.uri })).rejects.toThrow(
        'upstream execution failed',
      );
    } finally {
      await env.close();
    }
  });

  it('serves every upstream from its snapshot when all live lists fail', async () => {
    const env = await setup();
    try {
      const client = await env.connect('/mcp');
      const before = identifiers(await lists(client));
      vi.spyOn(env.test.runtime.upstreams, 'execute').mockRejectedValue(new Error('fetch failed'));
      const stale = await lists(client);
      expect(identifiers(stale)).toEqual(before);
      for (const result of stale) {
        expect(result._meta?.['toolhome/stale-servers']).toEqual(['failing', 'healthy']);
        expect(result._meta?.['toolhome/failed-servers']).toBeUndefined();
      }
    } finally {
      await env.close();
    }
  });

  it('reports an error when no upstream has any snapshot data to serve', async () => {
    const handler = createMcpHandler(() => {
      const server = new Server(
        { name: 'empty', version: '1.0.0' },
        { capabilities: { tools: {}, prompts: {}, resources: {} } },
      );
      server.setRequestHandler('tools/list', async () => ({ tools: [] }));
      server.setRequestHandler('prompts/list', async () => ({ prompts: [] }));
      server.setRequestHandler('resources/list', async () => ({ resources: [] }));
      server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [] }));
      return server;
    });
    const upstream = serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => handler.fetch(request),
    });
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('empty upstream address');
    const test = createTestRuntime();
    const clients: TestMcpClient[] = [];
    try {
      const server = serverRecordSchema.parse(
        await jsonResponse(
          await controlRequest(test.runtime, test.controlKey, 'POST', '/api/v1/servers', {
            slug: 'empty',
            name: 'empty',
            kind: 'remote',
            enabled: true,
            transport: {
              type: 'streamable-http',
              url: `http://127.0.0.1:${address.port}/mcp`,
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
      // The upstream disappears, and its snapshot holds no items for any surface.
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
      const access = (await jsonResponse(
        await controlRequest(test.runtime, test.controlKey, 'POST', '/api/v1/access-keys', {
          name: 'Empty harness',
        }),
      )) as { secret: string };
      const client = await connectTestClient(
        new URL('/mcp', test.runtime.config.publicUrl),
        access.secret,
        (input, init) => applicationFetch(test.runtime, input, init),
      );
      clients.push(client);
      for (const list of [
        () => client.client.listTools(),
        () => client.client.listPrompts(),
        () => client.client.listResources(),
        () => client.client.listResourceTemplates(),
      ]) {
        await expect(list()).rejects.toMatchObject({
          code: -32603,
          data: { 'toolhome/failed-servers': ['empty'] },
        });
      }
    } finally {
      vi.restoreAllMocks();
      for (const client of clients) await client.close().catch(() => undefined);
      await test.close();
    }
  });

  it('keeps cursors valid while an upstream list fails and invalidates them on a real change', async () => {
    const env = await setup();
    try {
      const client = await env.connect('/mcp');
      const execute = env.test.runtime.upstreams.execute.bind(env.test.runtime.upstreams);
      let failingListFails = true;
      const healthyToolCount = 120;
      vi.spyOn(env.test.runtime.upstreams, 'execute').mockImplementation(async (...args) => {
        if (args[1].method !== 'tools/list') return execute(...args);
        if (args[0] === env.servers[1]!.id) {
          if (failingListFails) throw new Error('fetch failed');
          return { tools: [] };
        }
        return {
          tools: Array.from({ length: healthyToolCount }, (_, index) => ({
            name: `tool${index}`,
            inputSchema: { type: 'object' },
          })),
        };
      });
      const first = await client.request(
        { method: 'tools/list', params: {} },
        ListToolsResultSchema,
      );
      expect(first.tools).toHaveLength(100);
      expect(first.nextCursor).toBeDefined();
      const second = await client.listTools({ cursor: first.nextCursor }, { cacheMode: 'bypass' });
      expect(second.tools.length).toBeGreaterThan(0);
      expect(second._meta?.['toolhome/failed-servers']).toBeUndefined();
      expect(second._meta?.['toolhome/stale-servers']).toEqual(['failing']);
      const names = new Set([...first.tools, ...second.tools].map((tool) => tool.name));
      expect(names.size).toBe(second.tools.length + 100);

      // A real catalog change still invalidates the continuation cursor.
      await jsonResponse(
        await controlRequest(
          env.test.runtime,
          env.test.controlKey,
          'PATCH',
          `/api/v1/servers/${env.servers[0]!.id}/projection`,
          { overrides: [{ tool: 'tool0', visibility: 'hidden' }] },
        ),
      );
      await expect(
        client.listTools({ cursor: first.nextCursor }, { cacheMode: 'bypass' }),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await env.close();
    }
  });

  it('serves the failing upstream from its snapshot without hiding an empty successful list', async () => {
    const env = await setup();
    try {
      const client = await env.connect('/mcp');
      const before = identifiers(await lists(client));
      vi.spyOn(env.test.runtime.upstreams, 'execute').mockImplementation(async (id, request) => {
        if (id === env.servers[1]!.id) throw new Error('fetch failed');
        const keys: Record<string, string> = {
          'tools/list': 'tools',
          'prompts/list': 'prompts',
          'resources/list': 'resources',
          'resources/templates/list': 'resourceTemplates',
        };
        return { [keys[request.method]!]: [] };
      });
      const results = await lists(client);
      const expected = before.map((ids) => ids.filter((id) => id.includes('failing')));
      expect(identifiers(results)).toEqual(expected);
      for (const result of results) {
        expect(result._meta?.['toolhome/stale-servers']).toEqual(['failing']);
        expect(result._meta?.['toolhome/failed-servers']).toBeUndefined();
        expect(result.ttlMs).toBe(0);
        expect(result.cacheScope).toBe('private');
      }
    } finally {
      await env.close();
    }
  });

  it('returns empty lists when every server is disabled', async () => {
    const env = await setup();
    try {
      const client = await env.connect('/mcp');
      for (const server of env.servers) {
        await jsonResponse(
          await controlRequest(
            env.test.runtime,
            env.test.controlKey,
            'POST',
            `/api/v1/servers/${server.id}/disable`,
          ),
        );
      }
      const results = await lists(client);
      expect(identifiers(results)).toEqual([[], [], [], []]);
      for (const method of ['constructor', '__proto__', 'unknown']) {
        await expect(client.request({ method }, ResultSchema)).rejects.toMatchObject({
          code: -32601,
        });
      }
      await expect(
        client.request(
          { method: 'tools/list', params: { cursor: 'invalid' } },
          ListToolsResultSchema,
        ),
      ).rejects.toMatchObject({ code: -32602 });
      for (const result of results)
        expect(result._meta?.['toolhome/failed-servers']).toBeUndefined();
    } finally {
      await env.close();
    }
  });

  it('preserves cancellation and leaves subsequent aggregate requests usable', async () => {
    const env = await setup();
    try {
      const client = await env.connect('/mcp');
      const controller = new AbortController();
      const execute = UpstreamAdapter.prototype.execute;
      let pending = 0;
      let aborted = 0;
      const spy = vi.spyOn(UpstreamAdapter.prototype, 'execute').mockImplementation(async function (
        this: UpstreamAdapter,
        request,
        bridge,
      ) {
        if (request.method !== 'tools/list') return execute.call(this, request, bridge);
        const signal = bridge.context.mcpReq.signal;
        return new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted += 1;
              reject(new Error('Connection closed'));
            },
            { once: true },
          );
          pending += 1;
          if (pending === 2) controller.abort();
        });
      });
      await expect(
        client.listTools(undefined, { signal: controller.signal, cacheMode: 'bypass' }),
      ).rejects.toThrow();
      await waitFor(() => aborted === 2);
      for (const server of env.servers) {
        expect(env.test.runtime.store.getRuntimeState(server.id)?.status).toBe('ready');
        expect(
          env.test.runtime.store
            .listEvents({ serverId: server.id })
            .filter((event) => event.type === 'server.error'),
        ).toEqual([]);
      }
      spy.mockRestore();
      expect(
        (await client.listTools(undefined, { cacheMode: 'bypass' })).tools.length,
      ).toBeGreaterThan(0);
    } finally {
      await env.close();
    }
  });
});
