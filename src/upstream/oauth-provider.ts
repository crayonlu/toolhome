import {
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { randomBytes } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { oauthCredentialPayloadSchema, type OAuthCredentialPayload } from '../domain/models.js';
import type { Store } from '../storage/store.js';

const FLOW_TTL_MS = 10 * 60 * 1_000;

export interface StoredOAuthProviderOptions {
  /**
   * Whether to advertise URL-based client metadata (RFC 9728
   * `client_id_metadata_document_supported`) to upstream authorization
   * servers. When disabled, dynamic client registration is used instead.
   * Some providers (e.g. Cloudflare's hosted MCP) fail to fetch metadata
   * documents from proxied origins, so DCR is the reliable fallback.
   */
  urlClientId?: boolean;
}

export class StoredOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  readonly #store: Store;
  readonly #credentialId: string;
  readonly #publicUrl: URL;

  constructor(
    store: Store,
    credentialId: string,
    publicUrl: URL,
    options: StoredOAuthProviderOptions = {},
  ) {
    this.#store = store;
    this.#credentialId = credentialId;
    this.#publicUrl = publicUrl;
    if (publicUrl.protocol === 'https:' && (options.urlClientId ?? true)) {
      this.clientMetadataUrl = new URL(
        `/oauth/upstream/client/${credentialId}`,
        publicUrl,
      ).toString();
    }
    this.#payload();
  }

  get redirectUrl(): URL {
    return new URL(`/oauth/upstream/callback/${this.#credentialId}`, this.#publicUrl);
  }

  get clientMetadata(): OAuthClientMetadata {
    const payload = this.#payload();
    return {
      redirect_uris: [this.redirectUrl.toString()],
      token_endpoint_auth_method: payload.clientSecret ? 'client_secret_basic' : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'ToolHome',
      client_uri: this.#publicUrl.toString(),
      software_id: 'toolhome',
      software_version: '0.1.0',
      ...(payload.scope === undefined ? {} : { scope: payload.scope }),
    };
  }

  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    // The SDK discovers protected-resource metadata from the path-scoped
    // well-known document, which some providers (e.g. Notion) publish with a
    // different resource identifier than their authorization server accepts.
    // Prefer the origin's well-known declaration when it is available, and
    // fall back to the SDK-discovered value otherwise.
    try {
      const origin = new URL('/', serverUrl);
      const response = await fetch(new URL('/.well-known/oauth-protected-resource', origin), {
        headers: { Accept: 'application/json' },
        redirect: 'follow',
      });
      if (response.ok) {
        const body = (await response.json()) as { resource?: unknown };
        if (typeof body.resource === 'string' && body.resource.length > 0) {
          return new URL(body.resource);
        }
      }
    } catch {
      // Fall through to the SDK-discovered resource.
    }
    if (resource !== undefined) return new URL(resource);
    return new URL(serverUrl);
  }

  async state(): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    this.#update({ state });
    return state;
  }

  clientInformation(
    context?: OAuthClientInformationContext,
  ): StoredOAuthClientInformation | undefined {
    const payload = this.#payload();
    const saved = payload.clientInformation;
    if (saved) {
      if (context && saved.issuer && saved.issuer !== context.issuer) return undefined;
      return saved;
    }
    if (!payload.clientId) return undefined;
    if (context && payload.issuer && payload.issuer !== context.issuer) return undefined;
    return {
      client_id: payload.clientId,
      ...(payload.clientSecret === undefined ? {} : { client_secret: payload.clientSecret }),
      ...(payload.issuer === undefined ? {} : { issuer: payload.issuer }),
    };
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation): void {
    this.#update({
      clientInformation,
      clientId: clientInformation.client_id,
      clientSecret: clientInformation.client_secret,
    });
  }

  tokens(context?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    const payload = this.#payload();
    if (!payload.accessToken) return undefined;
    if (context && payload.issuer && payload.issuer !== context.issuer) return undefined;
    const expiresIn = payload.expiresAt
      ? Math.max(0, Math.floor((Date.parse(payload.expiresAt) - Date.now()) / 1_000))
      : payload.expiresIn;
    return {
      access_token: payload.accessToken,
      token_type: payload.tokenType,
      ...(payload.refreshToken === undefined ? {} : { refresh_token: payload.refreshToken }),
      ...(payload.idToken === undefined ? {} : { id_token: payload.idToken }),
      ...(payload.scope === undefined ? {} : { scope: payload.scope }),
      ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
      ...(payload.issuer === undefined ? {} : { issuer: payload.issuer }),
    };
  }

  saveTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext): void {
    const current = this.#payload();
    const expiresAt =
      tokens.expires_in === undefined
        ? undefined
        : new Date(Date.now() + tokens.expires_in * 1_000).toISOString();
    this.#update({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? current.refreshToken,
      idToken: tokens.id_token,
      tokenType: tokens.token_type,
      expiresIn: tokens.expires_in,
      expiresAt,
      scope: tokens.scope ?? current.scope,
      issuer: tokens.issuer ?? context?.issuer ?? current.issuer,
      authorizationUrl: undefined,
      pendingExpiresAt: undefined,
      state: undefined,
      codeVerifier: undefined,
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.#update({
      authorizationUrl: authorizationUrl.toString(),
      pendingExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString(),
    });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#update({ codeVerifier });
  }

  codeVerifier(): string {
    const verifier = this.#payload().codeVerifier;
    if (!verifier) {
      throw new AppError('oauth_flow_expired', 'OAuth authorization flow has expired', 400);
    }
    return verifier;
  }

  saveAuthorizationServerUrl(authorizationServerUrl: string): void {
    this.#update({ authorizationServerUrl });
  }

  authorizationServerUrl(): string | undefined {
    return this.#payload().authorizationServerUrl;
  }

  saveResourceUrl(resourceUrl: string): void {
    this.#update({ resourceUrl });
  }

  resourceUrl(): string | undefined {
    return this.#payload().resourceUrl;
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    this.#update({ discoveryState });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#payload().discoveryState;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') {
      this.#update({
        clientInformation: undefined,
        clientId: undefined,
        clientSecret: undefined,
      });
    }
    if (scope === 'all' || scope === 'tokens') {
      this.#update({
        accessToken: undefined,
        refreshToken: undefined,
        idToken: undefined,
        expiresAt: undefined,
        expiresIn: undefined,
        issuer: undefined,
      });
    }
    if (scope === 'all' || scope === 'verifier') {
      this.#update({
        authorizationUrl: undefined,
        pendingExpiresAt: undefined,
        state: undefined,
        codeVerifier: undefined,
      });
    }
    if (scope === 'all' || scope === 'discovery') {
      this.#update({
        discoveryState: undefined,
        authorizationServerUrl: undefined,
        resourceUrl: undefined,
      });
    }
  }

  authorizationUrl(): string | undefined {
    return this.#payload().authorizationUrl;
  }

  validateCallbackState(state: string): void {
    const payload = this.#payload();
    if (!payload.state || payload.state !== state) {
      throw new AppError('oauth_state_mismatch', 'OAuth callback state is invalid', 400);
    }
    if (!payload.pendingExpiresAt || Date.parse(payload.pendingExpiresAt) <= Date.now()) {
      throw new AppError('oauth_flow_expired', 'OAuth authorization flow has expired', 400);
    }
  }

  #payload(): OAuthCredentialPayload {
    const payload = this.#store.getCredentialPayload(this.#credentialId);
    if (!payload || payload.type !== 'oauth') {
      throw new AppError('oauth_credential_invalid', 'OAuth credential is unavailable', 404);
    }
    return payload;
  }

  #update(changes: Record<string, unknown>): OAuthCredentialPayload {
    const next = oauthCredentialPayloadSchema.parse({ ...this.#payload(), ...changes });
    this.#store.updateCredential(this.#credentialId, { payload: next });
    return next;
  }
}
