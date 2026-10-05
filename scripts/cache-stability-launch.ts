/**
 * Real built-process check for aggregate catalog byte stability.
 *
 * Spawns `dist/server/main.js`, points it at an HTTP MCP upstream that alternates
 * equivalent schema key insertion order, and reads the aggregate `tools/list`
 * payload through a real MCP client. Two identical-semantics catalogs must
 * serialize to identical JSON-RPC result bytes so a client that embeds the
 * definitions in a model request keeps a reusable prefix.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createMcpHandler, Server, type Tool } from '@modelcontextprotocol/server';
import { serve, type ServerType } from '@hono/node-server';
import { z } from 'zod';
import type { FetchLike } from '@modelcontextprotocol/client';
import { apiKeyRecordSchema, serverRecordSchema } from '../src/domain/models.js';
import {
  connectTestClient,
  structuredResult,
  waitFor,
  type TestMcpClient,
} from '../tests/support/mcp-client.js';

const issuedKeySchema = z.object({ key: apiKeyRecordSchema, secret: z.string().min(1) });
const ORDER_MODES = ['zeta-first', 'alpha-first'] as const;
type OrderMode = (typeof ORDER_MODES)[number];

interface VaryingState {
  order: OrderMode;
  revision: number;
}

/** Same semantics across both orders: only object key insertion order rotates. */
function varyingTool(state: VaryingState): Tool {
  const keys = state.order === 'zeta-first' ? ['zeta', 'mid', 'alpha'] : ['alpha', 'mid', 'zeta'];
  const properties: Record<string, unknown> = {};
  for (const key of keys) {
    const description = `${key} property`;
    properties[key] =
      key === 'mid'
        ? state.order === 'zeta-first'
          ? { type: 'string', enum: ['y', 'x', 'z'], description }
          : { description, enum: ['y', 'x', 'z'], type: 'string' }
        : state.order === 'zeta-first'
          ? { type: 'string', description }
          : { description, type: 'string' };
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

async function startVaryingUpstream(): Promise<{
  url: URL;
  control(order: OrderMode, revision: number): Promise<void>;
  close(): Promise<void>;
}> {
  const state: VaryingState = { order: 'zeta-first', revision: 1 };
  const handler = createMcpHandler(() => {
    const server = new Server(
      { name: 'varying-fixture', version: '1.0.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: [varyingTool(state), simpleTool('aaa'), simpleTool('zzz')],
    }));
    server.setRequestHandler('tools/call', async (request) => ({
      content: [{ type: 'text', text: JSON.stringify({ name: request.params.name }) }],
      structuredContent: {
        name: request.params.name,
        args: request.params.arguments ?? {},
        revision: state.revision,
        order: state.order,
      },
    }));
    return server;
  });
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
      return handler.fetch(request);
    },
  });
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('upstream address unavailable');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  return {
    url,
    async control(order, revision) {
      const response = await fetch(new URL('/control', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ order, revision }),
      });
      if (!response.ok) throw new Error(`control failed: ${response.status}`);
    },
    async close() {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
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
    if (data === '' || data === '[DONE]') continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Ignore non-JSON frames.
    }
  }
  return messages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolsResultFromBody(body: string): string | null {
  for (const message of jsonRpcMessages(body)) {
    if (!isRecord(message)) continue;
    const result = message.result;
    if (isRecord(result) && Array.isArray(result.tools)) return JSON.stringify(result);
  }
  return null;
}

function commonPrefixBytes(values: string[]): number {
  const buffers = values.map((value) => Buffer.from(value, 'utf8'));
  const first = buffers[0];
  if (!first) return 0;
  const shortest = Math.min(...buffers.map((buffer) => buffer.length));
  let index = 0;
  while (index < shortest && buffers.every((buffer) => buffer[index] === first[index])) index += 1;
  return index;
}

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDirectory = mkdtempSync(join(tmpdir(), 'toolhome-cache-'));
const controlKey = 'tch_ctl_cache-bootstrap-control-key-0000000000000000001';
const masterKey = 'cache-stability-master-key-00000000000000000000001';
const builtEntrypoint = join(projectRoot, 'dist', 'server', 'main.js');
const clients: TestMcpClient[] = [];
const upstream = await startVaryingUpstream();
const port = await availablePort();
const baseUrl = new URL(`http://127.0.0.1:${port}`);
let output = '';

const child: ChildProcess = spawn(process.execPath, [builtEntrypoint], {
  cwd: projectRoot,
  env: {
    ...process.env,
    TOOLHOME_HOST: '127.0.0.1',
    TOOLHOME_PORT: String(port),
    TOOLHOME_PUBLIC_URL: baseUrl.toString(),
    TOOLHOME_DATA_DIR: dataDirectory,
    TOOLHOME_MASTER_KEY: masterKey,
    TOOLHOME_BOOTSTRAP_CONTROL_KEY: controlKey,
    TOOLHOME_ALLOWED_HOSTS: '127.0.0.1',
    TOOLHOME_LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout?.on('data', (chunk: unknown) => {
  output = `${output}${String(chunk)}`.slice(-16_384);
});
child.stderr?.on('data', (chunk: unknown) => {
  output = `${output}${String(chunk)}`.slice(-16_384);
});

try {
  assert.ok(existsSync(builtEntrypoint), 'build dist/server/main.js before running this check');
  await waitForHealth(new URL('/healthz', baseUrl), child);
  const server = serverRecordSchema.parse(
    await control('POST', '/api/v1/servers', {
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
    }),
  );
  await control('POST', `/api/v1/servers/${server.id}/refresh`);
  const access = issuedKeySchema.parse(
    await control('POST', '/api/v1/access-keys', { name: 'Cache stability harness' }),
  );

  const capture: string[] = [];
  const captureFetch: FetchLike = async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const body = init?.body;
    const requestBody =
      typeof body === 'string'
        ? body
        : body instanceof Uint8Array
          ? Buffer.from(body).toString('utf8')
          : null;
    if (requestBody !== null && requestBody.includes('"tools/list"')) {
      capture.push(await response.clone().text());
    }
    return response;
  };

  const aggregate = await connectTestClient(new URL('/mcp', baseUrl), access.secret, captureFetch);
  clients.push(aggregate);

  const samples: string[] = [];
  for (const [repeat, order] of ORDER_MODES.entries()) {
    await upstream.control(order, 1);
    const before = capture.length;
    await aggregate.client.listTools(undefined, { cacheMode: 'refresh' });
    await waitFor(() => capture.length > before, 10_000);
    const payload = capture
      .slice(before)
      .map((raw) => toolsResultFromBody(raw))
      .find((value): value is string => value !== null);
    assert.ok(payload, `tools/list result missing on repeat ${repeat}`);
    samples.push(payload);
  }
  // A third alternating repeat keeps the comparison honest about rotation.
  await upstream.control('zeta-first', 1);
  const beforeThird = capture.length;
  await aggregate.client.listTools(undefined, { cacheMode: 'refresh' });
  await waitFor(() => capture.length > beforeThird, 10_000);
  const third = capture
    .slice(beforeThird)
    .map((raw) => toolsResultFromBody(raw))
    .find((value): value is string => value !== null);
  assert.ok(third, 'tools/list result missing on third repeat');
  samples.push(third);

  const prefix = commonPrefixBytes(samples);
  const fullBytes = samples[0]!.length;
  process.stdout.write(
    `[cache-stability-launch] repeats=${samples.length} common-prefix-bytes=${prefix} full-bytes=${fullBytes} stable=${samples.every((sample) => sample === samples[0])}\n`,
  );
  assert.equal(samples[1], samples[0], 'equivalent catalogs must serialize identically');
  assert.equal(samples[2], samples[0], 'equivalent catalogs must serialize identically');

  const result = JSON.parse(samples[0]!) as {
    tools: Array<{
      name: string;
      description?: string;
      title?: string;
      inputSchema: { properties: Record<string, Record<string, unknown>>; required: string[] };
      annotations?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    }>;
  };
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['varying_aaa', 'varying_vary', 'varying_zzz'],
  );
  const vary = result.tools.find((tool) => tool.name === 'varying_vary');
  assert.ok(vary, 'varying_vary missing from the catalog');
  assert.deepEqual(Object.keys(vary.inputSchema.properties), ['alpha', 'mid', 'zeta']);
  assert.deepEqual(vary.inputSchema.required, ['zeta', 'mid', 'alpha']);
  assert.deepEqual(vary.inputSchema.properties.mid?.enum, ['y', 'x', 'z']);
  assert.equal(vary.description, 'Vary schema key insertion order');
  assert.equal(vary.title, 'Vary');
  assert.deepEqual(vary.annotations, { readOnlyHint: true, idempotentHint: false });
  assert.deepEqual(Object.keys(vary._meta ?? {}).sort(), ['varying/alpha', 'varying/zeta']);

  // A real semantic change must still reach the client.
  await upstream.control('zeta-first', 2);
  const beforeChange = capture.length;
  await aggregate.client.listTools(undefined, { cacheMode: 'refresh' });
  await waitFor(() => capture.length > beforeChange, 10_000);
  const changed = capture
    .slice(beforeChange)
    .map((raw) => toolsResultFromBody(raw))
    .find((value): value is string => value !== null);
  assert.ok(changed, 'changed tools/list result missing');
  assert.notEqual(changed, samples[0]);
  const changedVary = (JSON.parse(changed) as typeof result).tools.find(
    (tool) => tool.name === 'varying_vary',
  );
  assert.deepEqual(Object.keys(changedVary?.inputSchema.properties ?? {}), [
    'alpha',
    'gamma',
    'mid',
    'zeta',
  ]);

  const call = structuredResult(
    await aggregate.client.callTool({ name: 'varying_vary', arguments: { alpha: 'x' } }),
  );
  assert.equal(call.name, 'vary');
  assert.equal(call.revision, 2);
  assert.equal((call.args as Record<string, unknown>).alpha, 'x');

  const individual = await connectTestClient(
    new URL('/mcp/varying', baseUrl),
    access.secret,
    captureFetch,
  );
  clients.push(individual);
  await upstream.control('zeta-first', 2);
  const individualBefore = capture.length;
  await individual.client.listTools(undefined, { cacheMode: 'refresh' });
  await waitFor(() => capture.length > individualBefore, 10_000);
  const individualResult = capture
    .slice(individualBefore)
    .map((raw) => toolsResultFromBody(raw))
    .find((value): value is string => value !== null);
  assert.ok(individualResult, 'individual tools/list result missing');
  const rawVary = (
    JSON.parse(individualResult) as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    }
  ).tools.find((tool) => tool.name === 'vary');
  // Raw insertion order preserved (revision 2 appends `gamma`), unlike the aggregate.
  assert.deepEqual(Object.keys(rawVary?.inputSchema.properties ?? {}), [
    'zeta',
    'mid',
    'alpha',
    'gamma',
  ]);

  process.stdout.write(
    `${JSON.stringify({
      repeats: samples.length,
      commonPrefixBytes: prefix,
      fullBytes,
      stable: samples.every((sample) => sample === samples[0]),
      reusablePrefixGainBytes: fullBytes - prefix,
      tools: result.tools.map((tool) => tool.name),
      call,
      semanticChangeLive: true,
      individualRawOrder: Object.keys(rawVary?.inputSchema.properties ?? {}),
    })}\n`,
  );
} catch (error) {
  if (output !== '') process.stderr.write(`ToolHome process output:\n${output}\n`);
  throw error;
} finally {
  for (const client of clients.reverse()) await client.close().catch(() => undefined);
  await stopChild(child);
  await upstream.close();
  rmSync(dataDirectory, { recursive: true, force: true });
}

async function control(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${controlKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`control ${method} ${path} -> ${response.status}`);
  return value;
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('port unavailable');
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForHealth(url: URL, processHandle: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`ToolHome exited before becoming healthy: ${processHandle.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('ToolHome did not become healthy');
}

async function stopChild(processHandle: ChildProcess): Promise<void> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  const exited = once(processHandle, 'exit');
  processHandle.kill('SIGTERM');
  const outcome = await Promise.race([
    exited.then(() => 'exited'),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
  ]);
  if (outcome === 'timeout') {
    processHandle.kill('SIGKILL');
    await once(processHandle, 'exit');
  }
}
