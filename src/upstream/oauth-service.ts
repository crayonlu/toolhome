import {
  assertSecureTokenEndpoint,
  auth,
  type StoredOAuthClientInformation,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { ServerRecord } from '../domain/models.js';
import type { Logger } from '../observability/logger.js';
import type { Store } from '../storage/store.js';
import type { UpstreamManager } from './manager.js';
import { StoredOAuthProvider } from './oauth-provider.js';

const beginInputSchema = z.object({
  serverId: z.uuid().optional(),
  force: z.boolean().default(false),
});

export class UpstreamOAuthService {
  readonly #store: Store;
  readonly #publicUrl: URL;
  readonly #upstreams: UpstreamManager;
  readonly #logger: Logger;
  readonly #urlClientId: boolean;

  constructor(
    store: Store,
    publicUrl: URL,
    upstreams: UpstreamManager,
    logger: Logger,
    urlClientId = true,
  ) {
    this.#store = store;
    this.#publicUrl = publicUrl;
    this.#upstreams = upstreams;
    this.#logger = logger;
    this.#urlClientId = urlClientId;
  }

  #provider(credentialId: string, urlClientId = this.#urlClientId) {
    return new StoredOAuthProvider(this.#store, credentialId, this.#publicUrl, {
      urlClientId,
    });
  }

  metadata(credentialId: string) {
    return this.#provider(credentialId).clientMetadata;
  }

  async begin(credentialId: string, value: unknown = {}) {
    const input = beginInputSchema.parse(value);
    const server = this.#serverFor(credentialId, input.serverId);
    const provider = this.#provider(
      credentialId,
      server.settings.urlClientId ?? this.#urlClientId,
    );
    const payload = this.#oauthPayload(credentialId);
    if (!(await this.#advertisesAuthorizationServer(server))) {
      throw new AppError(
        'oauth_not_supported',
        `${server.transport.url} publishes no OAuth authorization server, so this credential cannot be authorized. If the server needs no credentials, delete the credential and keep the server.`,
        400,
      );
    }
    if (input.force) {
      // A forced flow starts over: discard any previously registered client so
      // the next authorization re-registers under the current configuration
      // (e.g. DCR instead of URL-based client metadata).
      provider.invalidateCredentials('client');
    }
    const result = await auth(provider, {
      serverUrl: server.transport.url,
      ...(payload.scope === undefined ? {} : { scope: payload.scope }),
      ...(input.force ? { forceReauthorization: true } : {}),
    });
    if (result === 'AUTHORIZED') {
      const connection = await this.#reload(server);
      return {
        status: 'authorized',
        credential: this.#store.getCredential(credentialId),
        serverId: server.id,
        connection,
      };
    }
    const authorizationUrl = provider.authorizationUrl();
    if (!authorizationUrl) {
      throw new AppError(
        'oauth_redirect_missing',
        'Authorization server did not return a redirect',
        502,
      );
    }
    await this.#upstreams.invalidate(server.id);
    this.#store.appendEvent({
      level: 'info',
      type: 'credential.authorization_started',
      serverId: server.id,
      message: `Started OAuth authorization for ${server.slug}`,
      detail: { credentialId },
    });
    return {
      status: 'authorization-required',
      credential: this.#store.getCredential(credentialId),
      serverId: server.id,
      authorizationUrl,
      callbackUrl: provider.redirectUrl.toString(),
    };
  }

  async callback(credentialId: string, input: { code: string; state: string; iss?: string }) {
    const server = this.#serverFor(credentialId);
    const provider = this.#provider(
      credentialId,
      server.settings.urlClientId ?? this.#urlClientId,
    );
    provider.validateCallbackState(input.state);
    const payload = this.#oauthPayload(credentialId);
    const result = await auth(provider, {
      serverUrl: server.transport.url,
      authorizationCode: input.code,
      ...(input.iss === undefined ? {} : { iss: input.iss }),
      ...(payload.scope === undefined ? {} : { scope: payload.scope }),
    });
    if (result !== 'AUTHORIZED') {
      throw new AppError('oauth_exchange_incomplete', 'OAuth authorization did not complete', 502);
    }
    const connection = await this.#reload(server);
    this.#store.appendEvent({
      level: 'info',
      type: 'credential.authorized',
      serverId: server.id,
      message: `Authorized ${server.slug}`,
      detail: { credentialId },
    });
    return {
      status: 'authorized',
      server,
      credential: this.#store.getCredential(credentialId),
      connection,
    };
  }

  async revoke(credentialId: string) {
    const server = this.#serverFor(credentialId);
    const provider = this.#provider(
      credentialId,
      server.settings.urlClientId ?? this.#urlClientId,
    );
    const payload = this.#oauthPayload(credentialId);
    const metadata = payload.discoveryState?.authorizationServerMetadata;
    const endpointValue = metadata ? Reflect.get(metadata, 'revocation_endpoint') : undefined;
    const endpoint = typeof endpointValue === 'string' ? endpointValue : undefined;
    const clientInformation = provider.clientInformation();
    const attempts: {
      tokenType: 'refresh_token' | 'access_token';
      ok: boolean;
      status?: number;
    }[] = [];
    if (endpoint) {
      assertSecureTokenEndpoint(endpoint);
      if (payload.refreshToken) {
        attempts.push(
          await this.#revokeToken(
            endpoint,
            payload.refreshToken,
            'refresh_token',
            clientInformation,
          ),
        );
      }
      if (payload.accessToken) {
        attempts.push(
          await this.#revokeToken(endpoint, payload.accessToken, 'access_token', clientInformation),
        );
      }
    }
    provider.invalidateCredentials('tokens');
    provider.invalidateCredentials('verifier');
    await this.#upstreams.invalidate(server.id);
    this.#store.appendEvent({
      level: attempts.some((attempt) => !attempt.ok) ? 'warn' : 'info',
      type: 'credential.revoked',
      serverId: server.id,
      message: `Revoked OAuth credential for ${server.slug}`,
      detail: { credentialId, remoteRevocationSupported: endpoint !== undefined, attempts },
    });
    return {
      revoked: true,
      remoteRevocationSupported: endpoint !== undefined,
      remoteRevoked: attempts.length > 0 && attempts.every((attempt) => attempt.ok),
      attempts,
      credential: this.#store.getCredential(credentialId),
    };
  }

  async #revokeToken(
    endpoint: string,
    token: string,
    tokenType: 'refresh_token' | 'access_token',
    clientInformation: StoredOAuthClientInformation | undefined,
  ) {
    const body = new URLSearchParams({ token, token_type_hint: tokenType });
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
    if (clientInformation?.client_secret) {
      const user = formEncode(clientInformation.client_id);
      const password = formEncode(clientInformation.client_secret);
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
      );
    } else if (clientInformation) {
      body.set('client_id', clientInformation.client_id);
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      return { tokenType, ok: response.ok, status: response.status };
    } catch (error) {
      this.#logger.warn('Remote OAuth token revocation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { tokenType, ok: false };
    }
  }

  #serverFor(
    credentialId: string,
    serverId?: string,
  ): ServerRecord & {
    transport: Extract<ServerRecord['transport'], { type: 'streamable-http' }>;
  } {
    const candidates = this.#store
      .listServers()
      .filter((server) => server.credentialId === credentialId);
    const server = serverId
      ? candidates.find((candidate) => candidate.id === serverId)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!server) {
      throw new AppError(
        'oauth_server_required',
        candidates.length === 0
          ? 'Attach the OAuth credential to a remote MCP server first'
          : 'OAuth credential must be attached to exactly one remote MCP server',
        400,
      );
    }
    if (server.transport.type !== 'streamable-http') {
      throw new AppError(
        'oauth_remote_only',
        'OAuth is only available for remote MCP servers',
        400,
      );
    }
    return { ...server, transport: server.transport };
  }

  #oauthPayload(credentialId: string) {
    const payload = this.#store.getCredentialPayload(credentialId);
    if (!payload || payload.type !== 'oauth') {
      throw new AppError('oauth_credential_invalid', 'Credential is not OAuth', 400);
    }
    return payload;
  }

  /**
   * Whether the upstream publishes enough OAuth metadata to authorize against.
   *
   * A resource that declares protected-resource metadata naming an
   * authorization server, publishes authorization-server metadata itself, or
   * answers with a `resource_metadata` challenge can be authorized. An upstream
   * that does none of these has no authorization server at all (for example a
   * public endpoint that needs no credentials): starting a flow against it only
   * fails later inside dynamic client registration, leaving the credential
   * permanently pending.
   */
  async #advertisesAuthorizationServer(
    server: ServerRecord & {
      transport: Extract<ServerRecord['transport'], { type: 'streamable-http' }>;
    },
  ): Promise<boolean> {
    const resource = new URL(server.transport.url);
    const protectedResource = [
      new URL(`/.well-known/oauth-protected-resource${resource.pathname}`, resource.origin),
      new URL('/.well-known/oauth-protected-resource', resource.origin),
    ];
    for (const url of protectedResource) {
      const body = await this.#fetchJson(url);
      const issuers = body?.authorization_servers;
      if (!Array.isArray(issuers)) continue;
      for (const issuer of issuers) {
        if (typeof issuer !== 'string') continue;
        if (await this.#publishesAuthorizationServer(new URL(issuer))) return true;
      }
    }
    if (await this.#publishesAuthorizationServer(new URL(resource.origin))) return true;
    try {
      // Some servers skip the metadata documents and reply 401 with a
      // `resource_metadata` challenge; treat that as authorization-capable so a
      // supported provider is never blocked here.
      const response = await fetch(resource, {
        method: 'GET',
        redirect: 'follow',
        headers: { accept: 'application/json, text/event-stream' },
        signal: AbortSignal.timeout(8_000),
      });
      const challenge = response.headers.get('www-authenticate');
      return challenge !== null && /resource_metadata/i.test(challenge);
    } catch {
      return false;
    }
  }

  async #publishesAuthorizationServer(issuer: URL): Promise<boolean> {
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]) {
      const body = await this.#fetchJson(new URL(path, issuer));
      if (typeof body?.authorization_endpoint === 'string') return true;
    }
    return false;
  }

  async #fetchJson(url: URL): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async #reload(server: ServerRecord) {
    await this.#upstreams.remove(server.id);
    if (!server.enabled) return { refreshed: false, reason: 'server-disabled' };
    try {
      await this.#upstreams.refresh(server.id);
      return { refreshed: true };
    } catch (error) {
      this.#logger.warn('OAuth completed but the upstream MCP refresh failed', {
        serverId: server.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        refreshed: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice('value='.length);
}
