import type { FetchLike } from '@modelcontextprotocol/client';
import { credentialRecordSchema, serverRecordSchema } from '../../src/domain/models.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { connectTestClient } from '../support/mcp-client.js';
import {
  applicationFetch,
  controlRequest,
  createTestRuntime,
  jsonResponse,
} from '../support/runtime.js';
import { startRemoteFixture } from '../support/remote-fixture.js';

const issuedKeySchema = z.object({
  key: z.object({ id: z.string(), scope: z.string().nullable() }),
  secret: z.string().min(1),
});

describe('control key scopes', () => {
  it('agents can read and operate but are denied admin routes; admin keys keep full access', async () => {
    const remote = await startRemoteFixture();
    const testRuntime = createTestRuntime();
    try {
      // A server to operate on (needed for operate + delete-denial assertions).
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

      const admin = issuedKeySchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/control-keys',
            { name: 'Admin harness', scope: 'admin' },
          ),
        ),
      );
      const agent = issuedKeySchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/control-keys',
            { name: 'Agent harness', scope: 'agent' },
          ),
        ),
      );
      expect(admin.key.scope).toBe('admin');
      expect(agent.key.scope).toBe('agent');

      const withAgent = (method: string, path: string, body?: unknown) =>
        controlRequestWith(testRuntime, agent.secret, method, path, body);
      const withAdmin = (method: string, path: string, body?: unknown) =>
        controlRequestWith(testRuntime, admin.secret, method, path, body);

      // Agent CAN read and operate.
      expect((await withAgent('GET', '/api/v1/overview')).status).toBe(200);
      expect((await withAgent('GET', '/api/v1/servers')).status).toBe(200);
      expect((await withAgent('GET', `/api/v1/servers/${server.id}`)).status).toBe(200);
      expect((await withAgent('POST', `/api/v1/servers/${server.id}/restart`)).status).toBe(200);
      expect((await withAgent('POST', `/api/v1/servers/${server.id}/disable`)).status).toBe(200);
      expect(
        (
          await withAgent('PATCH', `/api/v1/servers/${server.id}/projection`, {
            overrides: [{ tool: 'echo', visibility: 'hidden' }],
          })
        ).status,
      ).toBe(200);

      // Agent DENIED admin routes (403).
      const denied: [string, string, unknown?][] = [
        ['GET', '/api/v1/credentials'],
        ['POST', '/api/v1/credentials', { name: 'x', payload: { type: 'bearer', token: 'x' } }],
        ['GET', '/api/v1/control-keys'],
        ['POST', '/api/v1/control-keys', { name: 'x' }],
        ['GET', '/api/v1/access-keys'],
        ['POST', '/api/v1/access-keys', { name: 'x' }],
        ['GET', '/api/v1/config/export?includeSecrets=true'],
        ['GET', `/api/v1/servers/${server.id}/runtime`],
        ['DELETE', `/api/v1/servers/${server.id}`],
      ];
      for (const [method, path, body] of denied) {
        const response = await withAgent(method, path, body);
        expect(response.status, `${method} ${path}`).toBe(403);
      }

      // Non-secret export is still fine for agents.
      expect((await withAgent('GET', '/api/v1/config/export')).status).toBe(200);

      // Admin key keeps full access to the same routes.
      expect((await withAdmin('GET', '/api/v1/credentials')).status).toBe(200);
      expect((await withAdmin('GET', '/api/v1/control-keys')).status).toBe(200);
      expect((await withAdmin('GET', '/api/v1/access-keys')).status).toBe(200);
      expect((await withAdmin('GET', '/api/v1/config/export?includeSecrets=true')).status).toBe(
        200,
      );

      // Agent control key can use the management MCP surface.
      const appFetch: FetchLike = (input, init) =>
        applicationFetch(testRuntime.runtime, input, init);
      const manage = await connectTestClient(
        new URL('/manage/mcp', testRuntime.runtime.config.publicUrl),
        agent.secret,
        appFetch,
      );
      const manageTools = (await manage.client.listTools()).tools.map((tool) => tool.name);
      expect(manageTools).toContain('home_status');
      await manage.close();
    } finally {
      await testRuntime.close();
      await remote.close();
    }
  });
});

function controlRequestWith(
  testRuntime: { runtime: import('../../src/app.js').ApplicationRuntime },
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return controlRequest(testRuntime.runtime, key, method, path, body);
}
