import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerRecord } from '../../src/domain/models.js';
import { createLogger } from '../../src/observability/logger.js';
import { SecretBox } from '../../src/security/secret-box.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { UpstreamManager } from '../../src/upstream/manager.js';
import { UpstreamOAuthService } from '../../src/upstream/oauth-service.js';

/** Minimal upstream that publishes no OAuth metadata at all. */
async function startPublicUpstream(): Promise<{ url: URL; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === '/mcp') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not Found');
  });
  return listen(server);
}

/** Upstream that publishes protected-resource and authorization-server metadata. */
async function startOAuthUpstream(): Promise<{ url: URL; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (request.url === '/mcp') {
      response.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      });
      response.end('{}');
      return;
    }
    if (request.url === '/.well-known/oauth-protected-resource/mcp') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
      return;
    }
    if (request.url === '/.well-known/oauth-authorization-server') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
      return;
    }
    if (request.url === '/register' && request.method === 'POST') {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          client_id: 'fixture-client',
          redirect_uris: [`${origin}/oauth/upstream/callback/fixture`],
          token_endpoint_auth_method: 'none',
        }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not Found');
  });
  return listen(server);
}

async function listen(server: Server): Promise<{ url: URL; close(): Promise<void> }> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture address missing');
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe('upstream OAuth authorization preflight', () => {
  let directory: string;
  let store: SqliteStore;
  let manager: UpstreamManager;
  let service: UpstreamOAuthService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'toolhome-oauth-preflight-'));
    store = new SqliteStore(join(directory, 'test.sqlite'), new SecretBox('oauth-preflight-key'));
    const logger = createLogger('error', () => undefined);
    manager = new UpstreamManager(store, { resolve: () => ({ headers: {}, env: {} }) }, logger);
    service = new UpstreamOAuthService(store, new URL('https://toolhome.test'), manager, logger);
  });

  afterEach(async () => {
    await manager.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function attach(url: URL): { server: ServerRecord; credentialId: string } {
    const credential = store.createCredential({
      name: 'Upstream',
      payload: { type: 'oauth', tokenType: 'Bearer' },
    });
    const server = store.createServer({
      slug: 'upstream',
      name: 'Upstream',
      kind: 'remote',
      nodeId: null,
      transport: {
        type: 'streamable-http',
        url: url.toString(),
        protocolMode: 'auto',
        allowSseFallback: false,
        headers: {},
      },
      credentialId: credential.id,
      enabled: true,
      settings: {
        connectTimeoutMs: 5_000,
        requestTimeoutMs: 5_000,
        maxTotalTimeoutMs: 10_000,
        maxConcurrency: 1,
        restart: 'never',
      },
    });
    return { server, credentialId: credential.id };
  }

  it('reports an actionable error for an upstream that publishes no authorization server', async () => {
    const upstream = await startPublicUpstream();
    try {
      const { credentialId } = attach(upstream.url);
      await expect(service.begin(credentialId)).rejects.toMatchObject({
        code: 'oauth_not_supported',
        status: 400,
      });
      // The credential is untouched, so an operator can simply delete it.
      expect(store.getCredential(credentialId)?.status).toBe('pending');
    } finally {
      await upstream.close();
    }
  });

  it('starts the flow for an upstream that publishes authorization-server metadata', async () => {
    const upstream = await startOAuthUpstream();
    try {
      const { credentialId } = attach(upstream.url);
      const result = await service.begin(credentialId);
      expect(result).toMatchObject({ status: 'authorization-required' });
      expect(typeof (result as { authorizationUrl?: unknown }).authorizationUrl === 'string').toBe(
        true,
      );
    } finally {
      await upstream.close();
    }
  });
});
