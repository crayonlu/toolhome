import { serve } from '@hono/node-server';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import {
  ListToolsResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
} from '@modelcontextprotocol/core';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { connectTestClient, waitFor } from '../support/mcp-client.js';
import {
  applicationFetch,
  controlRequest,
  createTestRuntime,
  jsonResponse,
} from '../support/runtime.js';

// A real HTTP upstream: counting its requests proves paging does not repeat discovery.
async function fixture() {
  const state = { lists: 0, version: 1, delay: 30, optionalLists: new Map<string, number>() };
  const handler = createMcpHandler(() => {
    const server = new Server(
      { name: 'slow-catalog', version: '1' },
      {
        capabilities: {
          tools: { listChanged: true },
          prompts: { listChanged: true },
          resources: { listChanged: true },
        },
      },
    );
    server.setRequestHandler('tools/list', async () => {
      state.lists++;
      await setTimeout(state.delay);
      return {
        tools: Array.from({ length: 230 }, (_, index) => ({
          name: `tool_${index}`,
          description: `version ${state.version}`,
          inputSchema: {
            type: 'object' as const,
            properties: { value: { type: 'string' as const } },
          },
        })),
      };
    });
    server.setRequestHandler('prompts/list', async () => {
      state.optionalLists.set('prompts', (state.optionalLists.get('prompts') ?? 0) + 1);
      await setTimeout(state.delay);
      return { prompts: Array.from({ length: 230 }, (_, index) => ({ name: `prompt${index}` })) };
    });
    server.setRequestHandler('resources/list', async () => {
      state.optionalLists.set('resources', (state.optionalLists.get('resources') ?? 0) + 1);
      await setTimeout(state.delay);
      return {
        resources: Array.from({ length: 230 }, (_, index) => ({
          name: `resource${index}`,
          uri: `fixture://resource/${index}`,
        })),
      };
    });
    server.setRequestHandler('resources/templates/list', async () => {
      state.optionalLists.set('templates', (state.optionalLists.get('templates') ?? 0) + 1);
      await setTimeout(state.delay);
      return {
        resourceTemplates: Array.from({ length: 230 }, (_, index) => ({
          name: `template${index}`,
          uriTemplate: `fixture://template/${index}/{value}`,
        })),
      };
    });
    server.setRequestHandler('tools/call', async (request) => ({
      content: [
        { type: 'text', text: `${request.params.name}:${request.params.arguments?.value}` },
      ],
    }));
    return server;
  });
  const http = serve({
    fetch: (request) => handler.fetch(request),
    hostname: '127.0.0.1',
    port: 0,
  });
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw Error('address missing');
  return {
    state,
    url: `http://127.0.0.1:${address.port}/mcp`,
    changed: () => handler.notify.toolsChanged(),
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

describe('aggregate discovery pagination work', () => {
  it.each(['2026-07-28', '2025-11-25'])(
    'reads a successful live catalog once per traversal (%s)',
    async (version) => {
      const upstream = await fixture();
      const env = createTestRuntime();
      const clients: Awaited<ReturnType<typeof connectTestClient>>[] = [];
      try {
        const created = (await jsonResponse(
          await controlRequest(env.runtime, env.controlKey, 'POST', '/api/v1/servers', {
            slug: 'slow',
            name: 'Slow',
            kind: 'remote',
            transport: {
              type: 'streamable-http',
              url: upstream.url,
              protocolMode: 'modern',
              headers: {},
            },
          }),
        )) as { id: string };
        await env.runtime.upstreams.refresh(created.id);
        const key = (await jsonResponse(
          await controlRequest(env.runtime, env.controlKey, 'POST', '/api/v1/access-keys', {
            name: 'discovery',
          }),
        )) as { secret: string };
        const connect = async (secret = key.secret) => {
          const c = await connectTestClient(
            new URL('/mcp', env.runtime.config.publicUrl),
            secret,
            (input, init) => applicationFetch(env.runtime, input, init),
            version,
          );
          clients.push(c);
          return c.client;
        };
        const client = await connect();
        const before = upstream.state.lists;
        const first = await client.request(
          { method: 'tools/list', params: {} },
          ListToolsResultSchema,
        );
        expect(first.tools).toHaveLength(100);
        const second = await client.request(
          { method: 'tools/list', params: { cursor: first.nextCursor } },
          ListToolsResultSchema,
        );
        const third = await client.request(
          { method: 'tools/list', params: { cursor: second.nextCursor } },
          ListToolsResultSchema,
        );
        expect([...first.tools, ...second.tools, ...third.tools]).toHaveLength(230);
        expect(
          new Set([...first.tools, ...second.tools, ...third.tools].map((t) => t.name)).size,
        ).toBe(230);
        expect(first.tools[0]?.inputSchema).toEqual({
          type: 'object',
          properties: { value: { type: 'string' } },
        });
        expect(upstream.state.lists - before).toBe(1);
        // A new traversal always rechecks the live upstream, even in the same client.
        upstream.state.version = 2;
        const next = await client.request(
          { method: 'tools/list', params: {} },
          ListToolsResultSchema,
        );
        expect(next.tools.every((t) => t.description === 'version 2')).toBe(true);
        expect(upstream.state.lists - before).toBe(2);
        const call = await client.callTool({
          name: 'slow_tool-5f0',
          arguments: { value: 'hello' },
        });
        expect(call.content).toEqual([{ type: 'text', text: 'tool_0:hello' }]);
        // A tools/list_changed notification invalidates continuation pages too.
        const notified = clients[0]!;
        upstream.state.version = 3;
        const changes = notified.listChanges.tools;
        upstream.changed();
        await waitFor(() => notified.listChanges.tools > changes);
        await expect(
          client.request(
            { method: 'tools/list', params: { cursor: next.nextCursor } },
            ListToolsResultSchema,
          ),
        ).rejects.toMatchObject({ code: -32602 });
        const refreshed = await client.request(
          { method: 'tools/list', params: {} },
          ListToolsResultSchema,
        );
        expect(refreshed.tools.every((t) => t.description === 'version 3')).toBe(true);
        // Fresh projection changes invalidate existing traversal contents immediately.
        env.runtime.store.setToolProjection(created.id, 'tool_0', 'hidden');
        const page = await client
          .request(
            { method: 'tools/list', params: { cursor: refreshed.nextCursor } },
            ListToolsResultSchema,
          )
          .catch((e) => e);
        expect(page).toMatchObject({ code: -32602 });
        const visible = await client.request(
          { method: 'tools/list', params: {} },
          ListToolsResultSchema,
        );
        expect(visible.tools.some((t) => t.name === 'slow_tool-5f0')).toBe(false);
        // Another access key must do its own upstream discovery.
        const otherKey = (await jsonResponse(
          await controlRequest(env.runtime, env.controlKey, 'POST', '/api/v1/access-keys', {
            name: 'other',
          }),
        )) as { secret: string };
        const other = await connect(otherKey.secret);
        const isolatedBefore = upstream.state.lists;
        await other
          .request(
            { method: 'tools/list', params: { cursor: visible.nextCursor } },
            ListToolsResultSchema,
          )
          .catch(() => undefined);
        expect(upstream.state.lists).toBeGreaterThan(isolatedBefore);
        for (const [method, field, schema, counter] of [
          ['prompts/list', 'prompts', ListPromptsResultSchema, 'prompts'],
          ['resources/list', 'resources', ListResourcesResultSchema, 'resources'],
          [
            'resources/templates/list',
            'resourceTemplates',
            ListResourceTemplatesResultSchema,
            'templates',
          ],
        ] as const) {
          const count = upstream.state.optionalLists.get(counter) ?? 0;
          const a = await client.request({ method, params: {} }, schema);
          const b = await client.request({ method, params: { cursor: a.nextCursor } }, schema);
          const c = await client.request({ method, params: { cursor: b.nextCursor } }, schema);
          const items = [
            ...(Reflect.get(a, field) as { name: string }[]),
            ...(Reflect.get(b, field) as { name: string }[]),
            ...(Reflect.get(c, field) as { name: string }[]),
          ];
          expect(items).toHaveLength(230);
          expect(new Set(items.map((item) => item.name)).size).toBe(230);
          expect(upstream.state.optionalLists.get(counter)! - count).toBe(1);
        }
      } finally {
        for (const client of clients) await client.close();
        await env.close();
        await upstream.close();
      }
    },
  );
});
