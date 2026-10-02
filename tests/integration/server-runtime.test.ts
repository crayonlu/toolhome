import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  controlRequest,
  createTestRuntime,
  jsonResponse,
  type TestRuntime,
} from '../support/runtime.js';

const idSchema = z.object({ id: z.uuid() });

const runtimeSchema = z.object({
  serverId: z.uuid(),
  slug: z.string(),
  kind: z.enum(['remote', 'home', 'node']),
  nodeId: z.string().nullable(),
  transport: z.object({ type: z.literal('stdio'), command: z.string() }).passthrough(),
  credentialEnv: z.record(z.string(), z.string()),
});

const eventSchema = z.object({
  type: z.string(),
  serverId: z.uuid().nullable(),
  detail: z.record(z.string(), z.unknown()),
});

/** Create a resource with the bootstrap control key and return its id. */
async function create(testRuntime: TestRuntime, path: string, body: unknown): Promise<string> {
  const response = await controlRequest(
    testRuntime.runtime,
    testRuntime.controlKey,
    'POST',
    path,
    body,
  );
  return idSchema.parse(await jsonResponse(response)).id;
}

/**
 * `toolhome mcp` on a client machine reads this endpoint to spawn a stdio server,
 * so it must return the launch environment for node- and home-hosted servers,
 * refuse HTTP servers, and never leak credential values into the audit trail.
 */
describe('server launch runtime', () => {
  it('materializes the environment for a node server and audits only the names', async () => {
    const testRuntime = createTestRuntime();
    try {
      const credentialId = await create(testRuntime, '/api/v1/credentials', {
        name: 'Local chrome',
        payload: { type: 'env', variables: { CHROME_TOKEN: 'super-secret-value' } },
      });
      const serverId = await create(testRuntime, '/api/v1/servers', {
        slug: 'laptop-chrome',
        name: 'Local Chrome',
        kind: 'node',
        nodeId: 'laptop',
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'chrome-devtools-mcp@1.6.0'],
          env: { CHROME_DEBUG: '1' },
        },
        credentialId,
        // Disabled so creating the server does not spawn an upstream; the launch
        // runtime is placement metadata and does not require a running server.
        enabled: false,
        settings: { restart: 'on-failure' },
      });

      const response = await controlRequest(
        testRuntime.runtime,
        testRuntime.controlKey,
        'GET',
        `/api/v1/servers/${serverId}/runtime`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const runtime = runtimeSchema.parse(await response.json());
      expect(runtime).toMatchObject({ slug: 'laptop-chrome', kind: 'node', nodeId: 'laptop' });
      expect(runtime.transport.command).toBe('npx');
      expect(runtime.credentialEnv).toEqual({ CHROME_TOKEN: 'super-secret-value' });

      const events = z
        .array(eventSchema)
        .parse(
          await jsonResponse(
            await controlRequest(
              testRuntime.runtime,
              testRuntime.controlKey,
              'GET',
              '/api/v1/events?limit=50',
            ),
          ),
        )
        .filter((event) => event.type === 'server.runtime_read');
      expect(events).toHaveLength(1);
      // Names are recorded, values are not.
      expect(events[0]!.detail).toMatchObject({
        credentialEnvKeys: ['CHROME_TOKEN'],
        nodeId: 'laptop',
      });
      expect(JSON.stringify(events[0]!.detail)).not.toContain('super-secret-value');
    } finally {
      await testRuntime.close();
    }
  });

  it('refuses a remote server and requires an admin control key', async () => {
    const testRuntime = createTestRuntime();
    try {
      const serverId = await create(testRuntime, '/api/v1/servers', {
        slug: 'remote-only',
        name: 'Remote only',
        kind: 'remote',
        transport: {
          type: 'streamable-http',
          url: 'https://example.test/mcp',
          protocolMode: 'modern',
          allowSseFallback: false,
          headers: {},
        },
        enabled: false,
      });

      const response = await controlRequest(
        testRuntime.runtime,
        testRuntime.controlKey,
        'GET',
        `/api/v1/servers/${serverId}/runtime`,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'server_has_no_local_runtime' },
      });

      const unauthorized = await controlRequest(
        testRuntime.runtime,
        'tch_ctl_not-a-real-key',
        'GET',
        `/api/v1/servers/${serverId}/runtime`,
      );
      expect(unauthorized.status).toBe(401);
    } finally {
      await testRuntime.close();
    }
  });

  it('does not host a node server, and readiness ignores it', async () => {
    const testRuntime = createTestRuntime();
    try {
      // Enabled, with a command that cannot possibly run here. If the host tried
      // to spawn it, this test would see a failed upstream and a 503.
      const serverId = await create(testRuntime, '/api/v1/servers', {
        slug: 'laptop-ghidra',
        name: 'Local Ghidra',
        kind: 'node',
        nodeId: 'laptop',
        transport: { type: 'stdio', command: '/nonexistent/bridge-mcp-ghidra', args: [] },
        enabled: true,
      });

      await new Promise((resolve) => setTimeout(resolve, 250));

      const diagnostics = z
        .object({
          ok: z.boolean(),
          database: z.string(),
          servers: z.array(z.object({ slug: z.string(), status: z.string() })),
        })
        .parse(
          await jsonResponse(
            await controlRequest(
              testRuntime.runtime,
              testRuntime.controlKey,
              'GET',
              '/api/v1/diagnostics',
            ),
          ),
        );
      expect(diagnostics).toMatchObject({ ok: true, database: 'ok' });
      const entry = diagnostics.servers.find((candidate) => candidate.slug === 'laptop-ghidra');
      expect(entry?.status).toBe('unknown');

      const ready = await controlRequest(
        testRuntime.runtime,
        testRuntime.controlKey,
        'GET',
        '/readyz',
      );
      expect(ready.status).toBe(200);

      // Operations that would connect on this host refuse instead.
      const refresh = await controlRequest(
        testRuntime.runtime,
        testRuntime.controlKey,
        'POST',
        `/api/v1/servers/${serverId}/refresh`,
      );
      expect(refresh.status).toBe(409);
      expect(await refresh.json()).toMatchObject({ error: { code: 'server_not_hosted_here' } });

      // The launcher still resolves its runtime, which is the whole point.
      const runtime = await controlRequest(
        testRuntime.runtime,
        testRuntime.controlKey,
        'GET',
        `/api/v1/servers/${serverId}/runtime`,
      );
      expect(runtime.status).toBe(200);
    } finally {
      await testRuntime.close();
    }
  });

  it('keeps the node placement across an unrelated update and refuses a misplaced nodeId', async () => {
    const testRuntime = createTestRuntime();
    try {
      const serverId = await create(testRuntime, '/api/v1/servers', {
        slug: 'laptop-ghidra',
        name: 'Local Ghidra',
        kind: 'node',
        nodeId: 'laptop',
        transport: { type: 'stdio', command: '/usr/local/bin/bridge-mcp-ghidra', args: [] },
        enabled: false,
      });

      const updated = await jsonResponse(
        await controlRequest(
          testRuntime.runtime,
          testRuntime.controlKey,
          'PATCH',
          `/api/v1/servers/${serverId}`,
          { name: 'Renamed Ghidra' },
        ),
      );
      expect(updated).toMatchObject({ name: 'Renamed Ghidra', kind: 'node', nodeId: 'laptop' });

      const moved = await controlRequest(
        testRuntime.runtime,
        testRuntime.controlKey,
        'PATCH',
        `/api/v1/servers/${serverId}`,
        { nodeId: null },
      );
      expect(moved.status).toBe(400);
    } finally {
      await testRuntime.close();
    }
  });
});
