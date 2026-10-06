import { serve, type ServerType } from '@hono/node-server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { once } from 'node:events';
import { adaptModernTaskRequest } from '../../src/data-plane/task-extension.js';
import { createFixtureServer, createFixtureState } from '../fixtures/mcp-server.js';

export interface RemoteFixture {
  url: URL;
  slowCancelled(): number;
  slowStarted(): number;
  resourceUpdated(uri: string): void;
  toolsChanged(): void;
  close(): Promise<void>;
}

/**
 * Starts the remote fixture. Pass an explicit port when a test needs the same
 * address before and after the upstream becomes reachable.
 */
export async function startRemoteFixture(port = 0): Promise<RemoteFixture> {
  const state = createFixtureState();
  const handler = createMcpHandler(
    (context) =>
      createFixtureServer({
        name: 'remote',
        era: context.era,
        authorization: context.requestInfo?.headers.get('authorization') ?? null,
        state,
      }),
    { keepAliveMs: 0 },
  );
  const server = serve({
    hostname: '127.0.0.1',
    port,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/mcp') {
        return new Response('Not found', { status: 404 });
      }
      const contentType = request.headers.get('content-type') ?? '';
      if (request.method !== 'POST' || !contentType.includes('application/json')) {
        return handler.fetch(request);
      }
      const body: unknown = await request.clone().json();
      const adapted = adaptModernTaskRequest(request, body);
      return handler.fetch(adapted.request, { parsedBody: adapted.body });
    },
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Remote fixture address unavailable');

  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    slowCancelled() {
      return state.slowCancelled;
    },
    slowStarted() {
      return state.slowStarted;
    },
    resourceUpdated(uri) {
      handler.notify.resourceUpdated(uri);
    },
    toolsChanged() {
      state.dynamicTools += 1;
      handler.notify.toolsChanged();
    },
    async close() {
      await handler.close();
      await closeServer(server);
    },
  };
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
