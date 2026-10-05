import type { FetchLike } from '@modelcontextprotocol/client';
import { CallToolRequestParamsSchema } from '@modelcontextprotocol/core';
import { createMcpHandler, Server, type Tool } from '@modelcontextprotocol/server';
import { serve, type ServerType } from '@hono/node-server';
import { once } from 'node:events';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { adaptModernTaskRequest } from '../../src/data-plane/task-extension.js';
import { apiKeyRecordSchema, serverRecordSchema } from '../../src/domain/models.js';
import {
  connectTestClient,
  structuredResult,
  waitFor,
  type TestMcpClient,
} from '../support/mcp-client.js';
import {
  applicationFetch,
  controlRequest,
  createTestRuntime,
  jsonResponse,
} from '../support/runtime.js';

const issuedKeySchema = z.object({
  key: apiKeyRecordSchema,
  secret: z.string().min(1),
});

type OrderMode = 'zeta-first' | 'alpha-first';

interface VaryingState {
  order: OrderMode;
  revision: number;
}

interface VaryingUpstream {
  url: URL;
  control(order: OrderMode, revision: number): Promise<void>;
  close(): Promise<void>;
}

const propertyKeys = (order: OrderMode): string[] =>
  order === 'zeta-first' ? ['zeta', 'mid', 'alpha'] : ['alpha', 'mid', 'zeta'];

function simpleTool(name: string): Tool {
  return {
    name,
    description: `${name} fixture tool`,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
  };
}

function varyingTool(state: VaryingState): Tool {
  const keys = propertyKeys(state.order);
  const properties: Record<string, unknown> = {};
  for (const key of keys) {
    if (key === 'mid') {
      // Array-valued keywords must survive canonicalization unchanged.
      properties[key] =
        state.order === 'zeta-first'
          ? { type: 'string', enum: ['y', 'x', 'z'], description: 'mid property' }
          : { description: 'mid property', enum: ['y', 'x', 'z'], type: 'string' };
    } else {
      properties[key] =
        state.order === 'zeta-first'
          ? { type: 'string', description: `${key} property` }
          : { description: `${key} property`, type: 'string' };
    }
  }
  if (state.revision >= 2) properties.gamma = { type: 'boolean', description: 'gamma property' };
  const inputSchema =
    state.order === 'zeta-first'
      ? {
          type: 'object',
          additionalProperties: false,
          required: ['zeta', 'mid', 'alpha'],
          properties,
        }
      : {
          additionalProperties: false,
          properties,
          required: ['zeta', 'mid', 'alpha'],
          type: 'object',
        };
  return {
    name: 'vary',
    description: 'Vary schema key insertion order',
    title: 'Vary',
    inputSchema: inputSchema as Tool['inputSchema'],
    annotations: { readOnlyHint: true, idempotentHint: false },
    _meta:
      state.order === 'zeta-first'
        ? { 'varying/zeta': 1, 'varying/alpha': 2 }
        : { 'varying/alpha': 2, 'varying/zeta': 1 },
  };
}

function createVaryingServer(state: VaryingState): Server {
  const looseResult = z.looseObject({});
  const server = new Server(
    { name: 'varying-fixture', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler('tools/list', async () => ({
    tools: [varyingTool(state), simpleTool('aaa'), simpleTool('zzz')],
  }));
  server.setRequestHandler(
    'tools/call',
    { params: CallToolRequestParamsSchema, result: looseResult },
    async (request) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ name: request.name, args: request.arguments ?? {} }),
        },
      ],
      structuredContent: {
        name: request.name,
        args: request.arguments ?? {},
        revision: state.revision,
        order: state.order,
      },
    }),
  );
  return server;
}

async function startVaryingUpstream(): Promise<VaryingUpstream> {
  const state: VaryingState = { order: 'zeta-first', revision: 1 };
  const handler = createMcpHandler(() => createVaryingServer(state), { keepAliveMs: 0 });
  const http: ServerType = serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/control') {
        const body = (await request.json()) as { order?: OrderMode; revision?: number };
        if (body.order) state.order = body.order;
        if (typeof body.revision === 'number') state.revision = body.revision;
        return Response.json({ order: state.order, revision: state.revision });
      }
      if (path !== '/mcp') return new Response('Not found', { status: 404 });
      const contentType = request.headers.get('content-type') ?? '';
      if (request.method !== 'POST' || !contentType.includes('application/json')) {
        return handler.fetch(request);
      }
      const body: unknown = await request.clone().json();
      const adapted = adaptModernTaskRequest(request, body);
      return handler.fetch(adapted.request, { parsedBody: adapted.body });
    },
  });
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') {
    throw new Error('Varying upstream address unavailable');
  }
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  return {
    url,
    async control(order, revision) {
      const response = await fetch(new URL('/control', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ order, revision }),
      });
      if (!response.ok) throw new Error(`Control failed: ${response.status}`);
    },
    async close() {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

interface Capture {
  fetch: FetchLike;
  entries: Array<{ requestBody: string | null; text: Promise<string> }>;
}

function captureFetch(inner: FetchLike): Capture {
  const entries: Capture['entries'] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const response = await inner(input, init);
    const body = init?.body;
    const requestBody =
      typeof body === 'string'
        ? body
        : body instanceof Uint8Array
          ? Buffer.from(body).toString('utf8')
          : null;
    entries.push({ requestBody, text: response.clone().text() });
    return response;
  };
  return { fetch: fetchFn, entries };
}

function jsonRpcMessages(body: string): unknown[] {
  const messages: unknown[] = [];
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // Fall through to SSE line parsing.
    }
  }
  for (const line of body.split('\n')) {
    const value = line.trim();
    if (!value.startsWith('data:')) continue;
    const data = value.slice('data:'.length).trim();
    if (data.length === 0 || data === '[DONE]') continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Ignore non-JSON keep-alive frames.
    }
  }
  return messages;
}

function toolsResultFromBody(body: string): Record<string, unknown> | null {
  for (const message of jsonRpcMessages(body)) {
    if (!isRecord(message)) continue;
    const result = message.result;
    if (isRecord(result) && Array.isArray(result.tools)) return result;
  }
  return null;
}

async function listCatalogJson(client: TestMcpClient['client'], capture: Capture): Promise<string> {
  const before = capture.entries.length;
  await client.listTools(undefined, { cacheMode: 'refresh' });
  await waitFor(() => capture.entries.length > before);
  const fresh = capture.entries.slice(before);
  for (const entry of fresh) {
    if (entry.requestBody !== null && !entry.requestBody.includes('"tools/list"')) continue;
    const result = toolsResultFromBody(await entry.text);
    if (result) return JSON.stringify(result);
  }
  throw new Error('tools/list result missing from captured aggregate response');
}

function commonPrefixBytes(values: string[]): number {
  if (values.length === 0) return 0;
  const buffers = values.map((value) => Buffer.from(value, 'utf8'));
  const first = buffers[0]!;
  const shortest = Math.min(...buffers.map((buffer) => buffer.length));
  let index = 0;
  while (index < shortest && buffers.every((buffer) => buffer[index] === first[index])) {
    index += 1;
  }
  return index;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface CatalogTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema: { properties: Record<string, Record<string, unknown>>; required: string[] };
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

function catalogTools(json: string): CatalogTool[] {
  const result = JSON.parse(json) as { tools: CatalogTool[] };
  return result.tools;
}

function findTool(json: string, name: string): CatalogTool {
  const tool = catalogTools(json).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool missing from catalog`);
  return tool;
}

describe('aggregate catalog stability', () => {
  it('emits a stable tools/list catalog for equivalent upstream schema key orders', async () => {
    const upstream = await startVaryingUpstream();
    const testRuntime = createTestRuntime();
    const clients: TestMcpClient[] = [];
    try {
      const server = serverRecordSchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/servers',
            {
              slug: 'varying',
              name: 'Varying fixture',
              kind: 'remote',
              transport: {
                type: 'streamable-http',
                url: upstream.url.toString(),
                protocolMode: 'modern',
                allowSseFallback: false,
                headers: {},
              },
              enabled: true,
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
            { name: 'Catalog harness' },
          ),
        ),
      );

      const aggregateCapture = captureFetch((input, init) =>
        applicationFetch(testRuntime.runtime, input, init),
      );
      const aggregate = await connectTestClient(
        new URL('/mcp', testRuntime.runtime.config.publicUrl),
        access.secret,
        aggregateCapture.fetch,
      );
      clients.push(aggregate);

      await upstream.control('zeta-first', 1);
      const first = await listCatalogJson(aggregate.client, aggregateCapture);
      await upstream.control('alpha-first', 1);
      const second = await listCatalogJson(aggregate.client, aggregateCapture);
      await upstream.control('zeta-first', 1);
      const third = await listCatalogJson(aggregate.client, aggregateCapture);

      const prefix = commonPrefixBytes([first, second, third]);
      console.log(
        `[catalog-stability] repeats=3 common-prefix-bytes=${prefix} full-bytes=${first.length} stable=${first === second && second === third}`,
      );

      // Same semantics with rotating upstream key insertion order must serialize identically.
      expect(second).toBe(first);
      expect(third).toBe(first);

      const tool = findTool(first, 'varying_vary');
      // Aggregate emits canonical object key order.
      expect(Object.keys(tool.inputSchema.properties)).toEqual(['alpha', 'mid', 'zeta']);
      // Arrays keep their original order: not sorted, not deduplicated.
      expect(tool.inputSchema.required).toEqual(['zeta', 'mid', 'alpha']);
      expect(tool.inputSchema.properties.mid?.enum).toEqual(['y', 'x', 'z']);
      // Every tool field survives canonicalization.
      expect(tool.description).toBe('Vary schema key insertion order');
      expect(tool.title).toBe('Vary');
      expect(tool.annotations).toEqual({ readOnlyHint: true, idempotentHint: false });
      expect(Object.keys(tool._meta ?? {}).sort()).toEqual(['varying/alpha', 'varying/zeta']);
      // Tool array order stays sorted by aggregate name.
      expect(catalogTools(first).map((candidate) => candidate.name)).toEqual([
        'varying_aaa',
        'varying_vary',
        'varying_zzz',
      ]);

      // A real schema change must stay live in the emitted catalog.
      await upstream.control('zeta-first', 2);
      const changed = await listCatalogJson(aggregate.client, aggregateCapture);
      expect(changed).not.toBe(first);
      expect(Object.keys(findTool(changed, 'varying_vary').inputSchema.properties)).toEqual([
        'alpha',
        'gamma',
        'mid',
        'zeta',
      ]);

      // The aggregated tool still executes.
      const call = structuredResult(
        await aggregate.client.callTool({ name: 'varying_vary', arguments: { alpha: 'x' } }),
      );
      expect(call).toMatchObject({ name: 'vary', revision: 2 });
      expect((call.args as Record<string, unknown>).alpha).toBe('x');

      // Per-server passthrough is untouched: the individual endpoint keeps the
      // upstream key insertion order instead of the aggregate canonical order.
      const individualCapture = captureFetch((input, init) =>
        applicationFetch(testRuntime.runtime, input, init),
      );
      const individual = await connectTestClient(
        new URL('/mcp/varying', testRuntime.runtime.config.publicUrl),
        access.secret,
        individualCapture.fetch,
      );
      clients.push(individual);

      await upstream.control('zeta-first', 2);
      const individualZeta = findTool(
        await listCatalogJson(individual.client, individualCapture),
        'vary',
      );
      expect(Object.keys(individualZeta.inputSchema.properties)).toEqual([
        'zeta',
        'mid',
        'alpha',
        'gamma',
      ]);
      expect(Object.keys(individualZeta._meta ?? {})).toEqual(['varying/zeta', 'varying/alpha']);

      await upstream.control('alpha-first', 2);
      const individualAlpha = findTool(
        await listCatalogJson(individual.client, individualCapture),
        'vary',
      );
      expect(Object.keys(individualAlpha.inputSchema.properties)).toEqual([
        'alpha',
        'mid',
        'zeta',
        'gamma',
      ]);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await testRuntime.close();
      await upstream.close();
    }
  });
});
