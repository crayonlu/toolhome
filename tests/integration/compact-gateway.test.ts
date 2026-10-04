import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { createTestRuntime, applicationFetch } from '../support/runtime.js';
import {
  startCompactAppFixture,
  startCompactFixture,
  startCompactTaskFixture,
} from '../support/compact-fixture.js';
import { connectTestClient } from '../support/mcp-client.js';
import { aggregateToolName } from '../../src/data-plane/virtualization.js';
import { fingerprint } from '../../src/upstream/stable-json.js';

function payload(result: unknown): Record<string, unknown> {
  const parsed = z
    .object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })
    .parse(result);
  const text = parsed.content.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('Text result missing');
  return JSON.parse(text) as Record<string, unknown>;
}

async function setup(options: { app?: boolean; task?: boolean } = {}) {
  const fixture = await startCompactFixture();
  const appFixture = options.app === true ? await startCompactAppFixture() : undefined;
  const taskFixture = options.task === true ? await startCompactTaskFixture() : undefined;
  const runtime = createTestRuntime({ config: { mcpToolMode: 'compact' } });
  const record = runtime.runtime.store.createServer({
    slug: 'math',
    name: 'Arithmetic',
    kind: 'remote',
    nodeId: null,
    transport: {
      type: 'streamable-http',
      url: fixture.url.toString(),
      protocolMode: 'modern',
      allowSseFallback: false,
      headers: {},
    },
    enabled: true,
    credentialId: null,
    settings: {
      connectTimeoutMs: 5000,
      requestTimeoutMs: 5000,
      maxTotalTimeoutMs: 5000,
      maxConcurrency: 1,
      restart: 'never',
    },
  });
  await runtime.runtime.upstreams.refresh(record.id);
  let appRecord;
  if (appFixture !== undefined) {
    appRecord = runtime.runtime.store.createServer({
      slug: 'app',
      name: 'Dashboard App',
      kind: 'remote',
      nodeId: null,
      transport: {
        type: 'streamable-http',
        url: appFixture.url.toString(),
        protocolMode: 'modern',
        allowSseFallback: false,
        headers: {},
      },
      enabled: true,
      credentialId: null,
      settings: {
        connectTimeoutMs: 5000,
        requestTimeoutMs: 5000,
        maxTotalTimeoutMs: 5000,
        maxConcurrency: 1,
        restart: 'never',
      },
    });
    await runtime.runtime.upstreams.refresh(appRecord.id);
  }
  let taskRecord;
  if (taskFixture !== undefined) {
    taskRecord = runtime.runtime.store.createServer({
      slug: 'tasks',
      name: 'Task fixture',
      kind: 'remote',
      nodeId: null,
      transport: {
        type: 'streamable-http',
        url: taskFixture.url.toString(),
        protocolMode: 'legacy',
        allowSseFallback: false,
        headers: {},
      },
      enabled: true,
      credentialId: null,
      settings: {
        connectTimeoutMs: 5000,
        requestTimeoutMs: 5000,
        maxTotalTimeoutMs: 5000,
        maxConcurrency: 1,
        restart: 'never',
      },
    });
    await runtime.runtime.upstreams.refresh(taskRecord.id);
  }
  const response = await applicationFetch(
    runtime.runtime,
    new URL('/api/v1/access-keys', runtime.runtime.config.publicUrl),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.controlKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'compact-test' }),
    },
  );
  const secret = z.object({ secret: z.string() }).parse(await response.json()).secret;
  const client = await connectTestClient(
    new URL('/mcp', runtime.runtime.config.publicUrl),
    secret,
    (input, init) => applicationFetch(runtime.runtime, new URL(String(input)), init),
  );
  return {
    fixture,
    appFixture,
    taskFixture,
    runtime,
    record,
    appRecord,
    taskRecord,
    secret,
    client,
    async close() {
      await client.close();
      await runtime.close();
      await fixture.close();
      await appFixture?.close();
      await taskFixture?.close();
    },
  };
}

describe('compact HTTP gateway', () => {
  it('exposes exactly two tools with an empty catalog', async () => {
    const runtime = createTestRuntime({ config: { mcpToolMode: 'compact' } });
    let client;
    try {
      const response = await applicationFetch(
        runtime.runtime,
        new URL('/api/v1/access-keys', runtime.runtime.config.publicUrl),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${runtime.controlKey}`,
            'content-type': 'application/json',
          },
          body: '{"name":"empty"}',
        },
      );
      const key = z.object({ secret: z.string() }).parse(await response.json()).secret;
      client = await connectTestClient(
        new URL('/mcp', runtime.runtime.config.publicUrl),
        key,
        (input, init) => applicationFetch(runtime.runtime, new URL(String(input)), init),
      );
      expect((await client.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'search',
        'exec',
      ]);
      expect(
        payload(await client.client.callTool({ name: 'search', arguments: { action: 'servers' } }))
          .servers,
      ).toEqual([]);
    } finally {
      await client?.close();
      await runtime.close();
    }
  });

  it('discovers without upstream I/O, validates and calls only the selected tool with pinned headers', async () => {
    const env = await setup();
    try {
      const lists = env.fixture.state.lists;
      expect((await env.client.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'search',
        'exec',
      ]);
      const directory = payload(
        await env.client.client.callTool({ name: 'search', arguments: { action: 'servers' } }),
      );
      expect(directory.scope).toBe('host');
      const matches = payload(
        await env.client.client.callTool({
          name: 'search',
          arguments: { action: 'find', query: 'add number' },
        }),
      );
      expect(JSON.stringify(matches)).toContain('math_add-5fvalue');
      const definition = payload(
        await env.client.client.callTool({
          name: 'search',
          arguments: { action: 'describe', tool: 'math_add-5fvalue' },
        }),
      );
      expect(definition.inputSchema).toEqual(env.fixture.definition().inputSchema);
      expect(env.fixture.definition().inputSchema.properties?.value).toEqual({
        type: 'integer',
        'x-mcp-header': 'Value',
      });
      expect(env.fixture.state.lists).toBe(lists);
      const invalid = payload(
        await env.client.client.callTool({
          name: 'exec',
          arguments: { tool: 'math_add-5fvalue', arguments: { value: 'bad' } },
        }),
      );
      expect(invalid.code).toBe('invalid_arguments');
      expect(env.fixture.state.effects).toBe(0);
      const result = await env.client.client.callTool({
        name: 'exec',
        arguments: {
          tool: 'math_add-5fvalue',
          arguments: { value: 41 },
          definition: definition.definition,
        },
      });
      expect(payload(result)).toEqual({ value: 42 });
      expect(env.fixture.state.effects).toBe(1);
      expect(env.fixture.state.seenHeader).toBe('41');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const history = env.runtime.runtime.store.listToolCalls({ limit: 100, offset: 0 });
      expect(
        history.some(
          (call) =>
            call.exposedToolName === 'exec' &&
            call.upstreamToolName === 'add_value' &&
            call.serverId === env.record.id,
        ),
      ).toBe(true);
    } finally {
      await env.close();
    }
  });

  it('recovers changed definitions within the profile and prevents hidden resubmission', async () => {
    const env = await setup();
    try {
      const describe = () =>
        env.client.client
          .callTool({ name: 'search', arguments: { action: 'describe', tool: 'math_add-5fvalue' } })
          .then(payload);
      const initial = await describe();
      env.fixture.state.version = 2;
      const changed = payload(
        await env.client.client.callTool({
          name: 'exec',
          arguments: {
            tool: 'math_add-5fvalue',
            arguments: { value: 1 },
            definition: initial.definition,
          },
        }),
      );
      expect(changed.code).toBe('definition_changed');
      expect(changed.callEffect).toBe('not_started');
      expect(env.fixture.state.invocations).toBe(0);
      const current = await describe();
      expect(current.definition).not.toBe(initial.definition);
      expect(
        payload(
          await env.client.client.callTool({
            name: 'exec',
            arguments: {
              tool: 'math_add-5fvalue',
              arguments: { value: 2, increment: 3 },
              definition: current.definition,
            },
          }),
        ),
      ).toEqual({ value: 5 });
      env.fixture.state.mismatch = true;
      const before = env.fixture.state.invocations;
      const mismatch = payload(
        await env.client.client.callTool({
          name: 'exec',
          arguments: {
            tool: 'math_add-5fvalue',
            arguments: { value: 2, increment: 3 },
            definition: current.definition,
          },
        }),
      );
      expect(mismatch.code).toBe('definition_changed');
      expect(mismatch.callEffect).toBe('may_have_run');
      expect(env.fixture.state.invocations - before).toBe(1);
      env.fixture.state.outputInvalid = true;
      const failure = payload(
        await env.client.client.callTool({
          name: 'exec',
          arguments: { tool: 'math_add-5fvalue', arguments: { value: 2, increment: 3 } },
        }),
      );
      expect(failure.code).toBe('upstream_failure');
      expect(failure.callEffect).toBe('may_have_run');
    } finally {
      await env.close();
    }
  });

  it('retains modern continuation state and mixed result metadata', async () => {
    const env = await setup();
    try {
      const result = await env.client.client.callTool({
        name: 'exec',
        arguments: { tool: aggregateToolName('math', 'confirm_value'), arguments: { value: 7 } },
      });
      expect(payload(result)).toEqual({ value: 7, confirmed: true });
      expect(env.fixture.state.effects).toBe(1);
      const mixed = z.looseObject({}).parse(
        await env.client.client.callTool({
          name: 'exec',
          arguments: { tool: 'math_mixed-5fresult', arguments: {} },
        }),
      );
      expect(mixed.structuredContent).toEqual({ value: 7 });
      expect(mixed._meta).toMatchObject({ 'fixture/metadata': true });
      expect(JSON.stringify(mixed)).toContain('toolhome://');
    } finally {
      await env.close();
    }
  });

  it('rejects cross-target continuation and disabled targets without replay', async () => {
    const env = await setup();
    const manual = new Client(
      { name: 'manual', version: '1' },
      { capabilities: { elicitation: {} }, versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    try {
      await manual.connect(
        new StreamableHTTPClientTransport(new URL('/mcp', env.runtime.runtime.config.publicUrl), {
          requestInit: { headers: { authorization: `Bearer ${env.secret}` } },
          fetch: (input, init) =>
            applicationFetch(env.runtime.runtime, new URL(String(input)), init),
        }),
      );
      const pending = z
        .looseObject({})
        .parse(
          await manual.callTool(
            { name: 'exec', arguments: { tool: 'math_confirm-5fvalue', arguments: { value: 5 } } },
            { allowInputRequired: true },
          ),
        );
      expect(pending.resultType).toBe('input_required');
      const state = String(pending.requestState);
      const wrong = payload(
        await manual.request(
          {
            method: 'tools/call',
            params: {
              name: 'exec',
              arguments: { tool: 'math_add-5fvalue', arguments: {} },
              requestState: state,
            },
          },
          z.looseObject({}),
          { allowInputRequired: true },
        ),
      );
      expect(wrong.code).toBe('continuation_rejected');
      expect(env.fixture.state.effects).toBe(0);
      env.runtime.runtime.store.updateServer(env.record.id, { enabled: false });
      const revoked = payload(
        await manual.request(
          {
            method: 'tools/call',
            params: {
              name: 'exec',
              arguments: { tool: 'math_confirm-5fvalue', arguments: {} },
              requestState: state,
            },
          },
          z.looseObject({}),
          { allowInputRequired: true },
        ),
      );
      expect(revoked.code).toBe('continuation_rejected');
      expect(revoked.callEffect).toBe('may_have_run');
      expect(env.fixture.state.effects).toBe(0);
      expect(
        env.runtime.runtime.store
          .listEvents({ limit: 100 })
          .some((event) => event.type === 'compact.continuation.termination_limited'),
      ).toBe(true);
      expect(fingerprint(pending)).toHaveLength(64);
    } finally {
      await manual.close();
      await env.close();
    }
  });

  it('refuses to resume an input round with no bound upstream state instead of resubmitting', async () => {
    const env = await setup();
    try {
      const before = env.fixture.state.invocations;
      const result = payload(
        await env.client.client.callTool({
          name: 'exec',
          arguments: {
            tool: aggregateToolName('math', 'stateless_confirm'),
            arguments: { value: 5 },
          },
        }),
      );
      // The client auto-fulfills; the gateway must reject the continuation
      // because the upstream round carried no requestState to resume.
      expect(result.code).toBe('continuation_rejected');
      expect(result.callEffect).toBe('may_have_run');
      // Exactly one upstream business call: the original arguments were not replayed.
      expect(env.fixture.state.invocations - before).toBe(1);
      expect(env.fixture.state.effects).toBe(0);
    } finally {
      await env.close();
    }
  });

  it('blocks Task-required tools and accepts a Task-capable tool, without effects on rejection', async () => {
    const env = await setup({ task: true });
    try {
      const requiredId = aggregateToolName('tasks', 'task_required');
      const optionalId = aggregateToolName('tasks', 'task_optional');

      // A task-required tool is not executable through the generic exec surface.
      const required = payload(
        await env.client.client.callTool({
          name: 'exec',
          arguments: { tool: requiredId, arguments: { value: 1 } },
        }),
      );
      expect(required.code).toBe('individual_endpoint_required');
      expect(required.callEffect).toBe('not_started');
      expect(env.taskFixture?.state.effects).toBe(0);
      expect(env.taskFixture?.state.invocations).toBe(0);

      // A task-capable tool accepts the requested task and runs it once.
      const optional = payload(
        await env.client.client.request(
          {
            method: 'tools/call',
            params: {
              name: 'exec',
              arguments: { tool: optionalId, arguments: {} },
              task: { ttl: 1000 },
            },
          },
          z.looseObject({}),
        ),
      );
      expect(optional.taskSupport).toBe('optional');
      expect(env.taskFixture?.state.effects).toBe(1);
    } finally {
      await env.close();
    }
  });

  it('blocks a client-requested task against a tool with no advertised task support', async () => {
    const env = await setup();
    try {
      // `task` rides the request params (`TaskAugmentedRequestParams`), not the
      // `_meta` envelope; reading the wrong location would let this call run.
      const requested = payload(
        await env.client.client.request(
          {
            method: 'tools/call',
            params: {
              name: 'exec',
              arguments: { tool: 'math_add-5fvalue', arguments: { value: 1 } },
              task: { ttl: 1000 },
            },
          },
          z.looseObject({}),
        ),
      );
      expect(requested.code).toBe('individual_endpoint_required');
      expect(requested.callEffect).toBe('not_started');
      expect(env.fixture.state.effects).toBe(0);
      expect(env.fixture.state.invocations).toBe(0);
    } finally {
      await env.close();
    }
  });

  it('routes a whole-App server and its plain companion to the individual endpoint without effects', async () => {
    const env = await setup({ app: true });
    try {
      const openId = aggregateToolName('app', 'open_dashboard');
      const companionId = aggregateToolName('app', 'dashboard_action');

      const open = payload(
        await env.client.client.callTool({
          name: 'search',
          arguments: { action: 'describe', tool: openId },
        }),
      );
      expect(open.execution).toBe('individualEndpoint');
      expect(open.app).toEqual({ resourceUri: 'ui://fixture/dashboard' });

      const companion = payload(
        await env.client.client.callTool({
          name: 'search',
          arguments: { action: 'describe', tool: companionId },
        }),
      );
      expect(companion.execution).toBe('individualEndpoint');
      expect(companion.app).toBeUndefined();
      expect(companion.guidance).toBe('Use /mcp/app.');

      for (const tool of [openId, companionId]) {
        const blocked = payload(
          await env.client.client.callTool({
            name: 'exec',
            arguments: { tool, arguments: {} },
          }),
        );
        expect(blocked.code, tool).toBe('individual_endpoint_required');
        expect(blocked.callEffect, tool).toBe('not_started');
      }
      expect(env.appFixture?.state.effects).toBe(0);
      expect(env.appFixture?.state.invocations).toBe(0);
    } finally {
      await env.close();
    }
  });
});
