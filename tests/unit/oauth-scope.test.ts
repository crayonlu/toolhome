import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OAuthCredentialPayload } from '../../src/domain/models.js';
import { SecretBox } from '../../src/security/secret-box.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { StoredOAuthProvider } from '../../src/upstream/oauth-provider.js';

describe('OAuth requested vs granted scope', () => {
  let directory: string;
  let store: SqliteStore;
  let credentialId: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'toolhome-oauth-scope-'));
    store = new SqliteStore(join(directory, 'test.sqlite'), new SecretBox('oauth-scope-key'));
    credentialId = store.createCredential({
      name: 'Upstream',
      payload: { type: 'oauth', tokenType: 'Bearer' },
    }).id;
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const provider = () => new StoredOAuthProvider(store, credentialId, new URL('https://toolhome.test'));
  const payload = () => store.getCredentialPayload(credentialId) as OAuthCredentialPayload;

  const grant = (scope: string) =>
    provider().saveTokens({
      access_token: 'access-token',
      token_type: 'Bearer',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      scope,
    });

  it('never turns a grant into the scope requested next time', () => {
    grant('read write legacy:bind');

    // The grant is recorded, but the request field stays empty: replaying the
    // granted list is what made Cloudflare's authorize fail with invalid_scope
    // once they stopped accepting a scope they still advertise.
    expect(payload().scope).toBeUndefined();
    expect(payload().grantedScope).toBe('read write legacy:bind');
  });

  it('preserves an explicitly requested scope across a grant', () => {
    store.updateCredential(credentialId, {
      payload: { type: 'oauth', tokenType: 'Bearer', scope: 'read write' },
    });

    grant('read write legacy:bind');

    expect(payload().scope).toBe('read write');
    expect(payload().grantedScope).toBe('read write legacy:bind');
  });

  it('reports the granted scope to the SDK when tokens are read back', () => {
    grant('read write');

    expect(provider().tokens()?.scope).toBe('read write');
  });

  it('falls back to the requested scope when a server returns none', () => {
    store.updateCredential(credentialId, {
      payload: { type: 'oauth', tokenType: 'Bearer', scope: 'read' },
    });
    provider().saveTokens({
      access_token: 'access-token',
      token_type: 'Bearer',
    });

    expect(payload().scope).toBe('read');
    expect(payload().grantedScope).toBeUndefined();
  });
});
