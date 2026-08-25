import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import type { SecureActionRecord } from '../domain/models.js';
import type { Store } from '../storage/store.js';

const ACTION_TTL_MS = 15 * 60 * 1000;

/**
 * One-time, short-lived, principal-bound actions used for URL-mode secret
 * elicitation. The URL only ever carries the action id + an HMAC signature;
 * the secret itself never leaves the user's browser/control session and never
 * travels through tool arguments or results.
 */
export class SecureActionService {
  readonly #store: Store;
  readonly #key: Buffer;
  readonly #publicUrl: URL;

  constructor(store: Store, masterKey: string, publicUrl: URL) {
    this.#store = store;
    this.#key = createHash('sha256').update(masterKey).digest();
    this.#publicUrl = publicUrl;
  }

  create(
    kind: 'market_install',
    target: string,
    principalId: string,
    ttlMs = ACTION_TTL_MS,
  ): { action: SecureActionRecord; token: string; url: string } {
    const action = this.#store.createSecureAction({
      kind,
      target,
      principalId,
      status: 'pending',
      valuesJson: '{}',
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      completedAt: null,
    });
    const token = this.#mint(action);
    return { action, token, url: this.#url(action, token) };
  }

  /** Verify token + expiry + one-time use; the token carries the principal binding. */
  verify(id: string, token: string, principalId?: string): SecureActionRecord {
    const action = this.#store.getSecureAction(id);
    if (!action) throw new AppError('secure_action_not_found', 'Secure action not found', 404);
    if (action.status !== 'pending') {
      throw new AppError('secure_action_used', 'Secure action was already used', 400);
    }
    if (Date.parse(action.expiresAt) < Date.now()) {
      throw new AppError('secure_action_expired', 'Secure action has expired', 400);
    }
    this.#verifyToken(action, token, principalId);
    return action;
  }

  complete(
    id: string,
    token: string,
    principalId: string | undefined,
    values: Record<string, string>,
  ): SecureActionRecord {
    this.verify(id, token, principalId);
    return this.#store.completeSecureAction(id, JSON.stringify(values), new Date().toISOString());
  }

  #verifyToken(action: SecureActionRecord, token: string, principalId?: string): void {
    if (principalId !== undefined && action.principalId !== principalId) {
      throw new AppError('forbidden', 'Secure action belongs to another principal', 403);
    }
    const expected = this.#mint(action);
    const actual = Buffer.from(token);
    const check = Buffer.from(expected);
    if (actual.length !== check.length || !timingSafeEqual(actual, check)) {
      throw new AppError('secure_action_invalid', 'Invalid secure action token', 400);
    }
  }

  #mint(action: SecureActionRecord): string {
    const payload = `${action.id}.${action.kind}.${action.target}.${action.principalId}.${action.expiresAt}`;
    return createHmac('sha256', this.#key).update(payload).digest('hex');
  }

  #url(action: SecureActionRecord, token: string): string {
    return new URL(
      `/market/actions/${action.id}?token=${encodeURIComponent(token)}`,
      this.#publicUrl,
    ).toString();
  }
}
