import {
  Client,
  ProtocolError as ClientProtocolError,
  ProtocolErrorCode,
  type ClientCapabilities,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/client';
import { CallToolRequestParamsSchema } from '@modelcontextprotocol/core';
import {
  ProtocolError as ServerProtocolError,
  Server,
  createMcpHandler,
} from '@modelcontextprotocol/server';
import { serve, type ServerType } from '@hono/node-server';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerRecord } from '../../src/domain/models.js';
import { createLogger } from '../../src/observability/logger.js';
import { SecretBox } from '../../src/security/secret-box.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import {
  UpstreamAdapter,
  type BridgeContext,
  type ExecutionOptions,
} from '../../src/upstream/adapter.js';
import { UpstreamManager } from '../../src/upstream/manager.js';

const looseResultSchema = z.looseObject({});

// The fixture server validates against its registered tool (fresh contract,
// `X-Query`) while a caller can pin a stale definition that mirrors `X-Other`.
const freshTool: Tool = {
  name: 'pinned',
  description: 'Pinned contract fixture',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', 'x-mcp-header': 'X-Query' } },
    required: ['query'],
    additionalProperties: true,
  },
  outputSchema: {
    type: 'object',
    properties: { pinned: { type: 'string' } },
    required: ['pinned'],
    additionalProperties: true,
  },
};
const staleTool: Tool = {
  ...freshTool,
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', 'x-mcp-header': 'X-Other' } },
    required: ['query'],
    additionalProperties: true,
  },
};
const strictOutputTool: Tool = {
  ...freshTool,
  outputSchema: {
    type: 'object',
    properties: { pinned: { type: 'string' }, extra: { type: 'string' } },
    required: ['pinned', 'extra'],
    additionalProperties: true,
  },
};

interface PinnedFixture {
  url: URL;
  calls(): number;
  listCalls(): number;
  headers(): Record<string, string>;
  /** Serve a stale tools/list once, then the fresh contract. */
  serveStaleListOnce(): void;
  /** Reject the next tools/call with a real -32020 HeaderMismatch. */
  mismatchOnce(): void;
  close(): Promise<void>;
}

async function startPinnedFixture(): Promise<PinnedFixture> {
  const state = {
    calls: 0,
    listCalls: 0,
    headers: {} as Record<string, string>,
    staleList: false,
    throwMismatchOnce: false,
  };
  const handler = createMcpHandler(
    (context) => {
      const inbound = context.requestInfo?.headers;
      const server = new Server(
        { name: 'pinned-fixture', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler('tools/list', async () => {
        state.listCalls += 1;
        const tool = state.staleList ? staleTool : freshTool;
        state.staleList = false;
        return { tools: [tool] };
      });
      server.setRequestHandler(
        'tools/call',
        { params: CallToolRequestParamsSchema, result: looseResultSchema },
        async (request, context) => {
          const token = request._meta?.progressToken;
          if (token !== undefined) {
            await context.mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken: token, progress: 1, total: 1 },
            });
          }
          state.calls += 1;
          if (inbound) state.headers = Object.fromEntries(inbound.entries());
          if (state.throwMismatchOnce) {
            state.throwMismatchOnce = false;
            throw new ServerProtocolError(-32020, 'Simulated HeaderMismatch');
          }
          const query = request.arguments?.query;
          return {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { pinned: String(query ?? '') },
          };
        },
      );
      return server;
    },
    { keepAliveMs: 0 },
  );
  const httpServer = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => handler.fetch(request),
  });
  await once(httpServer, 'listening');
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Pinned fixture address unavailable');
  }
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    calls: () => state.calls,
    listCalls: () => state.listCalls,
    headers: () => state.headers,
    serveStaleListOnce: () => {
      state.staleList = true;
    },
    mismatchOnce: () => {
      state.throwMismatchOnce = true;
    },
    async close() {
      await handler.close();
      await closeHttpServer(httpServer);
    },
  };
}

async function closeHttpServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function bridgeContext(
  signal: AbortSignal,
  clientCapabilities: ClientCapabilities = {},
): BridgeContext {
  const context = {
    mcpReq: {
      signal,
      envelope: {},
      notify: async () => undefined,
      send: async () => ({}),
    },
  } as unknown as ServerContext;
  return { context, clientCapabilities };
}

interface Harness {
  directory: string;
  store: SqliteStore;
  server: ServerRecord;
  adapter: UpstreamAdapter;
  controller: AbortController;
}

function createHarness(
  directory: string,
  transport: ServerRecord['transport'],
  settings: Partial<ServerRecord['settings']> = {},
  kind: ServerRecord['kind'] = 'remote',
): Harness {
  const store = new SqliteStore(join(directory, 'test.sqlite'), new SecretBox('compact-adapter'));
  const server = store.createServer({
    slug: 'upstream',
    name: 'Upstream',
    kind,
    nodeId: null,
    transport,
    credentialId: null,
    enabled: true,
    settings: {
      connectTimeoutMs: 15_000,
      requestTimeoutMs: 60_000,
      maxTotalTimeoutMs: 600_000,
      maxConcurrency: 2,
      restart: 'never',
      ...settings,
    },
  });
  const adapter = new UpstreamAdapter(
    server,
    { resolve: () => ({ headers: {}, env: {} }) },
    createLogger('error', () => {}),
    () => undefined,
  );
  return { directory, store, server, adapter, controller: new AbortController() };
}

describe('UpstreamAdapter contract pinning', () => {
  let directory: string;
  let fixture: PinnedFixture;
  let harness: Harness;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'toolhome-compact-adapter-'));
    fixture = await startPinnedFixture();
    harness = createHarness(directory, {
      type: 'streamable-http',
      url: fixture.url.toString(),
      protocolMode: 'modern',
      allowSseFallback: false,
      headers: {},
    });
  });

  afterEach(async () => {
    await harness.adapter.close();
    harness.store.close();
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('mirrors the pinned header and validates the pinned output schema without discovery', async () => {
    const result = await harness.adapter.execute(
      { method: 'tools/call', params: { name: 'pinned', arguments: { query: 'abc' } } },
      bridgeContext(harness.controller.signal),
      { toolDefinition: freshTool },
    );

    expect(fixture.calls()).toBe(1);
    expect(fixture.listCalls()).toBe(0);
    expect(fixture.headers()['mcp-param-x-query']).toBe('abc');
    expect(result).toMatchObject({ structuredContent: { pinned: 'abc' } });
  });

  it('marks dispatch after connection acquisition and leaves connection failures unsubmitted', async () => {
    const dispatched = vi.fn();
    await harness.adapter.execute(
      { method: 'tools/call', params: { name: 'pinned', arguments: { query: 'abc' } } },
      bridgeContext(harness.controller.signal),
      { toolDefinition: freshTool, onDispatch: dispatched },
    );
    expect(dispatched).toHaveBeenCalledOnce();
    await harness.adapter.close();
    dispatched.mockClear();
    await expect(
      harness.adapter.execute(
        { method: 'tools/call', params: { name: 'pinned', arguments: { query: 'abc' } } },
        bridgeContext(harness.controller.signal),
        { toolDefinition: freshTool, onDispatch: dispatched },
      ),
    ).rejects.toThrow();
    expect(dispatched).not.toHaveBeenCalled();
  });

  it('suppresses the SDK HeaderMismatch auto retry when toolDefinition is pinned', async () => {
    fixture.mismatchOnce();

    const pending = harness.adapter.execute(
      { method: 'tools/call', params: { name: 'pinned', arguments: { query: 'abc' } } },
      bridgeContext(harness.controller.signal),
      { toolDefinition: staleTool },
    );

    await expect(pending).rejects.toBeInstanceOf(ClientProtocolError);
    await expect(pending).rejects.toMatchObject({ code: -32020 });
    expect(fixture.calls()).toBe(1);
    expect(fixture.listCalls()).toBe(0);
    expect(fixture.headers()['mcp-param-x-other']).toBe('abc');
    expect(fixture.headers()['mcp-param-x-query']).toBeUndefined();
  });

  it('retains the SDK refresh and resend path when no toolDefinition is passed', async () => {
    fixture.serveStaleListOnce();
    await harness.adapter.discoverSnapshot(0);
    expect(fixture.listCalls()).toBe(1);

    // The warmed cache holds the stale contract, so the first call mirrors
    // X-Other and the server answers -32020; the SDK refreshes tools/list and
    // resends once, which only succeeds because the cached contract was updated.
    fixture.mismatchOnce();
    const result = await harness.adapter.execute(
      { method: 'tools/call', params: { name: 'pinned', arguments: { query: 'abc' } } },
      bridgeContext(harness.controller.signal),
    );

    expect(fixture.calls()).toBe(2);
    expect(fixture.listCalls()).toBe(2);
    expect(result).toMatchObject({ structuredContent: { pinned: 'abc' } });
  });

  it('validates output against the pinned schema rather than the cached one', async () => {
    await harness.adapter.discoverSnapshot(0);
    const cached = await harness.adapter.execute(
      { method: 'tools/call', params: { name: 'pinned', arguments: { query: 'abc' } } },
      bridgeContext(harness.controller.signal),
    );
    expect(cached).toMatchObject({ structuredContent: { pinned: 'abc' } });

    await expect(
      harness.adapter.execute(
        { method: 'tools/call', params: { name: 'pinned', arguments: { query: 'abc' } } },
        bridgeContext(harness.controller.signal),
        { toolDefinition: strictOutputTool },
      ),
    ).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
    expect(fixture.headers()['mcp-param-x-query']).toBe('abc');
  });
});

describe('UpstreamAdapter progress delivery ordering', () => {
  it.each([
    ['modern', 'modern', false],
    ['modern', 'legacy', false],
    ['legacy', 'modern', false],
    ['legacy', 'legacy', false],
    ['modern', 'modern', true],
    ['legacy', 'modern', true],
  ] as const)(
    'flushes %s upstream progress before a %s downstream result (failure=%s)',
    async (upstream, downstream, fail) => {
      const directory = mkdtempSync(join(tmpdir(), 'toolhome-progress-order-'));
      const fixture = upstream === 'modern' ? await startPinnedFixture() : null;
      const harness = createHarness(
        directory,
        fixture
          ? {
              type: 'streamable-http',
              url: fixture.url.toString(),
              protocolMode: 'modern',
              allowSseFallback: false,
              headers: {},
            }
          : {
              type: 'stdio',
              command: process.execPath,
              args: [
                '--import',
                'tsx',
                fileURLToPath(new URL('../fixtures/compact-legacy-server.ts', import.meta.url)),
              ],
              env: {},
              protocolMode: 'legacy',
            },
        { maxConcurrency: 1 },
        fixture ? 'remote' : 'home',
      );
      let release!: () => void;
      let started!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const notificationStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const bridge = bridgeContext(harness.controller.signal);
      if (downstream === 'legacy') delete bridge.context.mcpReq.envelope;
      const notifications: unknown[] = [];
      bridge.context.mcpReq.notify = async (notification) => {
        started();
        await blocked;
        notifications.push(notification);
      };
      let received!: () => void;
      const upstreamResponse = new Promise<void>((resolve) => {
        received = resolve;
      });
      const originalRequest = Client.prototype.request;
      const requestSpy = vi.spyOn(Client.prototype, 'request').mockImplementation(async function (
        this: Client,
        ...args
      ) {
        try {
          return await originalRequest.apply(this, args);
        } finally {
          if (args[0].method === 'tools/call') received();
        }
      });
      if (fail) fixture?.mismatchOnce();
      let completed = false;
      const execution = harness.adapter
        .execute(
          {
            method: 'tools/call',
            params: {
              name: fixture ? 'pinned' : 'progress',
              arguments: { query: 'ordered', fail },
              _meta: { progressToken: 'downstream-token' },
            },
          },
          bridge,
          fixture ? { toolDefinition: freshTool } : {},
        )
        .then(
          (result) => {
            completed = true;
            return { result };
          },
          (error: unknown) => {
            completed = true;
            return { error };
          },
        );
      try {
        await notificationStarted;
        await upstreamResponse;
        await setImmediate();
        expect(completed).toBe(false);
        release();
        const result = await execution;
        expect(notifications).toEqual([
          {
            method: 'notifications/progress',
            params: { progressToken: 'downstream-token', progress: 1, total: 1 },
          },
        ]);
        if (fail)
          expect(result).toMatchObject({
            error: { message: fixture ? 'Simulated HeaderMismatch' : 'Fixture progress failure' },
          });
        expect(result).toMatchObject(
          fail
            ? { error: expect.any(Error) }
            : {
                result: fixture
                  ? { structuredContent: { pinned: 'ordered' } }
                  : { content: [{ type: 'text', text: JSON.stringify({ progressed: true }) }] },
              },
        );
      } finally {
        release();
        await execution.catch(() => undefined);
        requestSpy.mockRestore();
        await harness.adapter.close();
        harness.store.close();
        await fixture?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

describe('UpstreamAdapter progress suspension and interruption', () => {
  it.each(['suspend', 'cancel', 'timeout'] as const)(
    'handles %s while downstream progress is blocked',
    async (action) => {
      const directory = mkdtempSync(join(tmpdir(), 'toolhome-progress-suspend-'));
      const harness = createHarness(
        directory,
        {
          type: 'stdio',
          command: process.execPath,
          args: [
            '--import',
            'tsx',
            fileURLToPath(new URL('../fixtures/compact-legacy-server.ts', import.meta.url)),
          ],
          env: {},
          protocolMode: 'legacy',
        },
        {
          maxConcurrency: 1,
          requestTimeoutMs: action === 'timeout' ? 200 : 5000,
          maxTotalTimeoutMs: action === 'timeout' ? 200 : 5000,
        },
        'home',
      );
      let release!: () => void;
      let started!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const notificationStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const bridge = bridgeContext(harness.controller.signal, { elicitation: { form: {} } });
      bridge.context.mcpReq.notify = async () => {
        started();
        await blocked;
      };
      let completed = false;
      const execution = harness.adapter
        .execute(
          {
            method: 'tools/call',
            params: {
              name: 'confirm',
              arguments: { marker: 'progress' },
              _meta: { progressToken: 'suspending-token' },
            },
          },
          bridge,
        )
        .then(
          (result) => {
            completed = true;
            return { result };
          },
          (error: unknown) => {
            completed = true;
            return { error };
          },
        );
      try {
        await notificationStarted;
        await setImmediate();
        expect(completed).toBe(false);
        if (action === 'suspend') {
          release();
          const outcome = await execution;
          expect(outcome).toMatchObject({ result: { resultType: 'input_required' } });
          harness.adapter.terminateContinuation(
            ('result' in outcome
              ? (outcome.result as { requestState: string })
              : { requestState: '' }
            ).requestState,
          );
        } else {
          if (action === 'cancel') harness.controller.abort();
          expect(await execution).toMatchObject({ error: expect.any(Error) });
        }
        const state = await harness.adapter.execute(
          { method: 'tools/call', params: { name: 'state', arguments: {} } },
          bridgeContext(new AbortController().signal),
        );
        expect(state).toMatchObject({ content: [{ type: 'text' }] });
      } finally {
        release();
        await execution;
        await harness.adapter.close();
        harness.store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

describe('UpstreamAdapter legacy continuation termination', () => {
  let directory: string;
  let harness: Harness;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'toolhome-compact-legacy-'));
    const fixturePath = fileURLToPath(new URL('../fixtures/stdio-server.ts', import.meta.url));
    harness = createHarness(
      directory,
      {
        type: 'stdio',
        command: process.execPath,
        args: ['--import', 'tsx', fixturePath],
        env: {},
        protocolMode: 'legacy',
      },
      { maxConcurrency: 1 },
      'home',
    );
  });

  afterEach(async () => {
    await harness.adapter.close();
    harness.store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function suspendConfirm(): Promise<{ requestState: string; key: string }> {
    const context = bridgeContext(harness.controller.signal, { elicitation: { form: {} } });
    const initial = (await harness.adapter.execute(
      { method: 'tools/call', params: { name: 'confirm', arguments: {} } },
      context,
    )) as { resultType: string; requestState: string; inputRequests: Record<string, unknown> };
    expect(initial.resultType).toBe('input_required');
    return { requestState: initial.requestState, key: Object.keys(initial.inputRequests)[0]! };
  }

  it('resumes the held round before acquiring under maxConcurrency=1', async () => {
    const { requestState, key } = await suspendConfirm();

    const continuation = await harness.adapter.execute(
      {
        method: 'tools/call',
        params: {
          requestState,
          inputResponses: { [key]: { action: 'accept', content: { confirmed: true } } },
        },
      },
      bridgeContext(harness.controller.signal, { elicitation: { form: {} } }),
    );
    expect(continuation).toMatchObject({
      structuredContent: { confirmed: true, source: 'legacy-push' },
    });

    // The round released its slot, so a fresh call resolves instead of waiting.
    const echo = await harness.adapter.execute(
      { method: 'tools/call', params: { name: 'echo', arguments: { value: 'x' } } },
      bridgeContext(harness.controller.signal),
    );
    expect(echo).toMatchObject({ structuredContent: { server: 'home' } });
  });

  it('terminates the bound legacy round and releases its busy slot', async () => {
    const { requestState } = await suspendConfirm();

    expect(harness.adapter.terminateContinuation(requestState, 'revoked by test')).toEqual({
      kind: 'legacy',
      terminated: true,
    });

    await expect(
      harness.adapter.execute(
        { method: 'tools/call', params: { requestState, inputResponses: {} } },
        bridgeContext(harness.controller.signal, { elicitation: { form: {} } }),
      ),
    ).rejects.toMatchObject({ code: 'legacy_round_not_found' });

    const echo = await harness.adapter.execute(
      { method: 'tools/call', params: { name: 'echo', arguments: { value: 'y' } } },
      bridgeContext(harness.controller.signal),
    );
    expect(echo).toMatchObject({ structuredContent: { server: 'home' } });
  });

  it('reports no pending resource for stateless modern continuations', () => {
    expect(harness.adapter.terminateContinuation('opaque-modern-state')).toEqual({
      kind: 'unknown',
      terminated: false,
      limitation: expect.any(String),
    });
  });
});

describe('UpstreamManager execution options and termination', () => {
  let directory: string;
  let store: SqliteStore;
  let server: ServerRecord;
  let manager: UpstreamManager;
  let context: ServerContext;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'toolhome-compact-manager-'));
    store = new SqliteStore(join(directory, 'test.sqlite'), new SecretBox('compact-manager'));
    server = store.createServer({
      slug: 'upstream',
      name: 'Upstream',
      kind: 'remote',
      nodeId: null,
      transport: {
        type: 'streamable-http',
        url: 'https://example.test/mcp',
        protocolMode: 'modern',
        allowSseFallback: false,
        headers: {},
      },
      credentialId: null,
      enabled: true,
      settings: {
        connectTimeoutMs: 15_000,
        requestTimeoutMs: 60_000,
        maxTotalTimeoutMs: 600_000,
        maxConcurrency: 2,
        restart: 'never',
      },
    });
    manager = new UpstreamManager(
      store,
      { resolve: () => ({ headers: {}, env: {} }) },
      createLogger('error', () => {}),
    );
    context = bridgeContext(new AbortController().signal).context;
  });

  afterEach(async () => {
    await manager.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('passes execution options to the adapter after transforms', async () => {
    const execute = vi.spyOn(UpstreamAdapter.prototype, 'execute').mockResolvedValue({});
    const transformRequest = (request: { method: string }): { method: string } => request;

    await manager.execute(
      server.id,
      { method: 'tools/call' },
      context,
      {},
      { transformRequest },
      { toolDefinition: freshTool },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const [request, bridge, options] = execute.mock.calls[0]!;
    expect(request).toEqual({ method: 'tools/call' });
    expect(bridge.context).toBe(context);
    expect(bridge.transformRequest).toBe(transformRequest);
    expect(options).toEqual({ toolDefinition: freshTool });
  });

  it('does not change existing full calls that omit execution options', async () => {
    const execute = vi.spyOn(UpstreamAdapter.prototype, 'execute').mockResolvedValue({});

    await manager.execute(server.id, { method: 'tools/call' }, context, {});

    const [, , options] = execute.mock.calls[0]!;
    expect(options).toEqual({} satisfies ExecutionOptions);
  });

  it('delegates termination only to an adapter that already exists', async () => {
    const terminate = vi
      .spyOn(UpstreamAdapter.prototype, 'terminateContinuation')
      .mockReturnValue({ kind: 'legacy', terminated: true });

    expect(manager.terminateContinuation(server.id, 'toolhome-legacy-round:abc')).toMatchObject({
      kind: 'unknown',
      terminated: false,
    });
    expect(terminate).not.toHaveBeenCalled();

    vi.spyOn(UpstreamAdapter.prototype, 'execute').mockResolvedValue({});
    await manager.execute(server.id, { method: 'tools/call' }, context, {});

    expect(
      manager.terminateContinuation(server.id, 'toolhome-legacy-round:abc', 'revoked'),
    ).toEqual({ kind: 'legacy', terminated: true });
    expect(terminate).toHaveBeenCalledWith('toolhome-legacy-round:abc', 'revoked');
  });
});
