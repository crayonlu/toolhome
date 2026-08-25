import type { AuthProvider, OAuthClientProvider } from '@modelcontextprotocol/client';
import { AppError } from '../domain/errors.js';
import { materializeCredentialPayload } from '../security/credential-materializer.js';
import type { CredentialPayload, ServerRecord } from '../domain/models.js';
import type { Store } from '../storage/store.js';
import { StoredOAuthProvider } from './oauth-provider.js';

export interface ResolvedCredential {
  headers: Record<string, string>;
  env: Record<string, string>;
  authProvider?: AuthProvider | OAuthClientProvider;
}

export class CredentialResolver {
  readonly #store: Store;
  readonly #publicUrl: URL;
  readonly #urlClientId: boolean;

  constructor(store: Store, publicUrl: URL, urlClientId = true) {
    this.#store = store;
    this.#publicUrl = publicUrl;
    this.#urlClientId = urlClientId;
  }

  resolve(server: ServerRecord): ResolvedCredential {
    const credentialId = server.credentialId;
    if (credentialId === null) return { headers: {}, env: {} };
    const payload = this.#store.getCredentialPayload(credentialId);
    if (!payload) throw new AppError('credential_not_found', 'Server credential not found', 400);
    return this.#resolvePayload(server, payload, credentialId);
  }

  #resolvePayload(
    server: ServerRecord,
    payload: CredentialPayload,
    credentialId: string,
  ): ResolvedCredential {
    switch (payload.type) {
      case 'bearer':
      case 'api-key':
      case 'headers':
      case 'env': {
        const materialized = materializeCredentialPayload(payload);
        return {
          headers: materialized.headers,
          env: materialized.env,
          ...(materialized.bearerToken === undefined
            ? {}
            : { authProvider: { token: async () => materialized.bearerToken } }),
        };
      }
      case 'oauth':
        if (server.transport.type !== 'streamable-http') {
          throw new AppError(
            'oauth_remote_only',
            'OAuth credentials require a remote MCP server',
            400,
          );
        }
        if (
          this.#store
            .listServers()
            .some(
              (candidate) => candidate.id !== server.id && candidate.credentialId === credentialId,
            )
        ) {
          throw new AppError(
            'oauth_credential_reused',
            'OAuth credentials cannot be shared between MCP servers',
            400,
          );
        }
        return {
          headers: {},
          env: {},
          authProvider: new StoredOAuthProvider(this.#store, credentialId, this.#publicUrl, {
            urlClientId: server.settings.urlClientId ?? this.#urlClientId,
          }),
        };
    }
  }
}
