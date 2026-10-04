import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { createTestRuntime, applicationFetch } from '../support/runtime.js';

const resultSchema = z.looseObject({});
function payload(result: unknown): Record<string, unknown> {
  const parsed = z
    .object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })
    .parse(result);
  return JSON.parse(parsed.content.find((item) => item.type === 'text')!.text!) as Record<
    string,
    unknown
  >;
}
async function setup(maxTotalTimeoutMs = 5000) {
  const runtime = createTestRuntime({ config: { mcpToolMode: 'compact' } });
  const record = runtime.runtime.store.createServer({
    slug: 'legacy',
    name: 'Legacy',
    kind: 'home',
    nodeId: null,
    transport: {
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
    enabled: true,
    credentialId: null,
    settings: {
      connectTimeoutMs: 5000,
      requestTimeoutMs: maxTotalTimeoutMs,
      maxTotalTimeoutMs,
      maxConcurrency: 1,
      restart: 'never',
    },
  });
  await runtime.runtime.upstreams.refresh(record.id);
  const response = await applicationFetch(
    runtime.runtime,
    new URL('/api/v1/access-keys', runtime.runtime.config.publicUrl),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.controlKey}`,
        'content-type': 'application/json',
      },
      body: '{"name":"manual"}',
    },
  );
  const secret = z.object({ secret: z.string() }).parse(await response.json()).secret;
  const client = new Client(
    { name: 'continuation', version: '1' },
    {
      capabilities: { elicitation: { form: {} }, roots: {}, sampling: {} },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  );
  client.setRequestHandler('roots/list', async () => ({
    roots: [{ uri: 'file:///fixture-root', name: 'Fixture root' }],
  }));
  client.setRequestHandler('sampling/createMessage', async () => ({
    model: 'fixture-model',
    role: 'assistant',
    content: { type: 'text', text: 'Fixture sampled response' },
  }));
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', runtime.runtime.config.publicUrl), {
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
      fetch: (input, init) => applicationFetch(runtime.runtime, new URL(String(input)), init),
    }),
  );
  const call = (
    tool: string,
    arguments_: Record<string, unknown> = {},
    control: Record<string, unknown> = {},
  ) =>
    client.request(
      {
        method: 'tools/call',
        params: {
          name: 'exec',
          arguments: { tool, arguments: arguments_ },
          ...control,
        },
      },
      resultSchema,
      { allowInputRequired: true, timeout: 2000 },
    );
  return {
    runtime,
    record,
    client,
    call,
    async close() {
      await client.close();
      await runtime.close();
    },
  };
}

describe('compact legacy continuation-first dispatch', () => {
  it('resumes within two seconds under maxConcurrency=1 without discovery or effects replay', async () => {
    const env = await setup();
    try {
      const pending = await env.call('legacy_confirm', { marker: 'original' });
      expect(pending.resultType).toBe('input_required');
      const requests = pending.inputRequests as Record<string, unknown>;
      const key = Object.keys(requests)[0]!;
      const started = performance.now();
      const result = payload(
        await env.call(
          'legacy_confirm',
          {},
          {
            requestState: pending.requestState,
            inputResponses: { [key]: { action: 'accept', content: { confirmed: true } } },
          },
        ),
      );
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result.effects).toBe(1);
      expect(result.calls).toBe(1);
      expect(result.accepted).toBe(true);
      const state = payload(await env.call('legacy_state'));
      expect(Number(state.lists) - Number(result.lists)).toBe(1);
      expect(state.effects).toBe(1);
      const replay = payload(
        await env.call(
          'legacy_confirm',
          {},
          {
            requestState: pending.requestState,
            inputResponses: { [key]: { action: 'accept', content: { confirmed: true } } },
          },
        ),
      );
      expect(replay.code).toBe('continuation_rejected');
      expect(replay.callEffect).toBe('may_have_run');
      expect(payload(await env.call('legacy_state')).effects).toBe(1);
    } finally {
      await env.close();
    }
  });

  it('bridges roots, sampling and progress through compact legacy execution', async () => {
    const env = await setup();
    try {
      const roots = payload(
        await env.client.callTool({
          name: 'exec',
          arguments: { tool: 'legacy_roots', arguments: {} },
        }),
      );
      expect(roots.roots).toEqual([{ uri: 'file:///fixture-root', name: 'Fixture root' }]);
      const sampled = payload(
        await env.client.callTool({
          name: 'exec',
          arguments: { tool: 'legacy_sample', arguments: {} },
        }),
      );
      expect(sampled.model).toBe('fixture-model');
      const progress: number[] = [];
      const result = payload(
        await env.client.callTool(
          { name: 'exec', arguments: { tool: 'legacy_progress', arguments: {} } },
          {
            onprogress: (update) => {
              progress.push(update.progress);
            },
          },
        ),
      );
      expect(result.progressed).toBe(true);
      expect(progress).toContain(1);
    } finally {
      await env.close();
    }
  });

  it('expires suspended invocations and releases the single upstream slot', async () => {
    const env = await setup(300);
    try {
      const pending = await env.call('legacy_confirm');
      await new Promise((resolve) => setTimeout(resolve, 450));
      const expired = payload(
        await env.call('legacy_confirm', {}, { requestState: pending.requestState }),
      );
      expect(expired.code).toBe('continuation_rejected');
      expect(expired.callEffect).toBe('may_have_run');
      const state = payload(await env.call('legacy_state'));
      expect(state.effects).toBe(1);
      expect(state.calls).toBe(1);
    } finally {
      await env.close();
    }
  });

  it('keeps the active continuation locked after concurrent and cross-target rejection', async () => {
    const env = await setup();
    try {
      const pending = await env.call('legacy_confirm', { marker: 'delayed' });
      const key = Object.keys(pending.inputRequests as Record<string, unknown>)[0]!;
      const control = {
        requestState: pending.requestState,
        inputResponses: { [key]: { action: 'accept', content: { confirmed: true } } },
      };
      const resumed = env.call('legacy_confirm', {}, control);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const wrong = payload(
        await env.call('legacy_state', {}, { requestState: pending.requestState }),
      );
      expect(wrong.code).toBe('continuation_rejected');
      const duplicate = payload(await env.call('legacy_confirm', {}, control));
      expect(duplicate.code).toBe('continuation_rejected');
      const result = payload(await resumed);
      expect(result.effects).toBe(1);
      expect(result.calls).toBe(1);
      expect(result.accepted).toBe(true);
    } finally {
      await env.close();
    }
  });

  it('cancels an active invocation and permits a subsequent call under maxConcurrency=1', async () => {
    const env = await setup();
    try {
      const controller = new AbortController();
      let started!: () => void;
      const upstreamStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = env.client
        .callTool(
          { name: 'exec', arguments: { tool: 'legacy_slow', arguments: {} } },
          { signal: controller.signal, onprogress: () => started() },
        )
        .then(
          () => 'completed',
          () => 'cancelled',
        );
      await upstreamStarted;
      controller.abort(new Error('Cancel fixture request'));
      expect(await pending).toBe('cancelled');
      const state = payload(await env.call('legacy_state'));
      expect(state.effects).toBe(1);
      expect(state.calls).toBe(1);
    } finally {
      await env.close();
    }
  });

  it('rejects cross-target tokens, releases a revoked pending slot and preserves effect uncertainty', async () => {
    const env = await setup();
    try {
      const pending = await env.call('legacy_confirm');
      const wrong = payload(
        await env.call('legacy_state', {}, { requestState: pending.requestState }),
      );
      expect(wrong.code).toBe('continuation_rejected');
      env.runtime.runtime.store.setToolProjection(env.record.id, 'confirm', 'hidden');
      const revoked = payload(
        await env.call('legacy_confirm', {}, { requestState: pending.requestState }),
      );
      expect(revoked.code).toBe('continuation_rejected');
      expect(revoked.callEffect).toBe('may_have_run');
      const state = payload(await env.call('legacy_state'));
      expect(state.effects).toBe(1);
      expect(state.calls).toBe(1);
    } finally {
      await env.close();
    }
  });
});
