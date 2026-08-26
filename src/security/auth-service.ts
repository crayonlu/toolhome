import type { AuthInfo } from '@modelcontextprotocol/server';
import { AppError } from '../domain/errors.js';
import type { ApiKeyKind, ApiKeyRecord, ControlScope } from '../domain/models.js';
import type { Store } from '../storage/store.js';
import type { ApiKeyHasher } from './api-keys.js';

export interface IssuedApiKey {
  key: ApiKeyRecord;
  secret: string;
}

export interface AuthPrincipal {
  id: string;
  kind: ApiKeyKind;
  name: string;
  /** Control keys carry a scope; access keys have null. */
  scope: ControlScope | null;
}

export class AuthService {
  readonly #lastTouched = new Map<string, number>();
  readonly #store: Store;
  readonly #hasher: ApiKeyHasher;

  constructor(store: Store, hasher: ApiKeyHasher) {
    this.#store = store;
    this.#hasher = hasher;
  }

  ensureBootstrapControlKey(secret: string | undefined): void {
    if (this.#store.listApiKeys('control').some((key) => key.revokedAt === null)) return;
    if (!secret) {
      throw new AppError(
        'bootstrap_key_required',
        'TOOLHOME_BOOTSTRAP_CONTROL_KEY is required on first start',
        500,
      );
    }
    this.#store.createApiKey({
      kind: 'control',
      name: 'bootstrap',
      prefix: secret.slice(0, 16),
      digest: this.#hasher.digest(secret),
      scope: 'admin',
    });
  }

  issue(kind: ApiKeyKind, name: string, scope?: ControlScope | null): IssuedApiKey {
    const generated = this.#hasher.generate(kind);
    return {
      key: this.#store.createApiKey({
        kind,
        name,
        prefix: generated.prefix,
        digest: generated.digest,
        scope: kind === 'control' ? (scope ?? 'admin') : null,
      }),
      secret: generated.secret,
    };
  }

  authenticate(kind: ApiKeyKind, secret: string): AuthPrincipal {
    if (this.#hasher.kindFor(secret) !== kind) {
      throw new AppError('unauthorized', 'Invalid or revoked credential', 401);
    }
    const key = this.#store.getApiKeyByDigest(kind, this.#hasher.digest(secret));
    if (!key || !this.#hasher.verify(secret, key.digest)) {
      throw new AppError('unauthorized', 'Invalid or revoked credential', 401);
    }
    const timestamp = Date.now();
    const lastTouched = this.#lastTouched.get(key.id) ?? 0;
    if (timestamp - lastTouched >= 60_000) {
      this.#store.touchApiKey(key.id);
      this.#lastTouched.set(key.id, timestamp);
    }
    return { id: key.id, kind, name: key.name, scope: key.scope };
  }

  authenticateBearer(kind: ApiKeyKind, request: Request): AuthPrincipal {
    const token = bearerToken(request);
    if (!token) throw new AppError('unauthorized', 'Bearer credential required', 401);
    return this.authenticate(kind, token);
  }

  toMcpAuthInfo(principal: AuthPrincipal, token: string, resource: URL): AuthInfo {
    return {
      token,
      clientId: principal.id,
      scopes: ['mcp:use'],
      resource,
      extra: { credentialKind: principal.kind, name: principal.name },
    };
  }
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization) return null;
  const match = /^Bearer[\t ]+([^\s].*)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}
