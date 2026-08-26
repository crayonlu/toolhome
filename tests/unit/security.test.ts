import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ControlClient } from '../../src/control/client.js';
import { ApiKeyHasher } from '../../src/security/api-keys.js';
import { AuthService } from '../../src/security/auth-service.js';
import { OAuthServer } from '../../src/security/oauth-server.js';
import { SecretBox } from '../../src/security/secret-box.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

describe('security primitives', () => {
  it('encrypts credential payloads with authenticated, randomized ciphertext', () => {
    const secrets = new SecretBox('unit-test-master-key-0000000000000000000001');
    const value = { type: 'bearer', token: 'private-token' };
    const first = secrets.encrypt(value);
    const second = secrets.encrypt(value);
    expect(first).not.toBe(second);
    expect(secrets.decrypt(first)).toEqual(value);
    const tamperIndex = Math.floor(first.length / 2);
    const replacement = first[tamperIndex] === 'A' ? 'B' : 'A';
    const tampered = `${first.slice(0, tamperIndex)}${replacement}${first.slice(tamperIndex + 1)}`;
    expect(() => secrets.decrypt(tampered)).toThrow();
  });

  it('separates control and access API key domains', () => {
    const hasher = new ApiKeyHasher('unit-test-pepper');
    const control = hasher.generate('control');
    const access = hasher.generate('access');
    expect(control.secret).toMatch(/^tch_ctl_/);
    expect(access.secret).toMatch(/^tch_mcp_/);
    expect(hasher.kindFor('mch_ctl_legacy-control-key')).toBeNull();
    expect(hasher.kindFor('mch_mcp_legacy-access-key')).toBeNull();
    expect(hasher.kindFor(control.secret)).toBe('control');
    expect(hasher.kindFor(access.secret)).toBe('access');
    expect(hasher.verify(control.secret, control.digest)).toBe(true);
    expect(hasher.verify(access.secret, control.digest)).toBe(false);
  });

  it('rejects legacy API key prefixes even when the key is stored', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-prefix-cutover-'));
    const store = new SqliteStore(
      join(directory, 'prefix-cutover.sqlite'),
      new SecretBox('unit-test-prefix-cutover-key-00000000000001'),
    );
    try {
      const hasher = new ApiKeyHasher('unit-test-prefix-cutover-pepper');
      const auth = new AuthService(store, hasher);
      const legacySecret = 'mch_ctl_legacy-control-key-0000000000000000001';
      store.createApiKey({
        kind: 'control',
        name: 'legacy',
        prefix: legacySecret.slice(0, 16),
        digest: hasher.digest(legacySecret),
        scope: 'admin',
      });
      expect(() => auth.authenticate('control', legacySecret)).toThrow('Invalid or revoked');
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never sends a Control API key outside the configured origin', async () => {
    const client = new ControlClient(
      new URL('https://mcp.example.test'),
      'control-key-that-must-not-leave-the-origin',
    );
    await expect(
      client.request('GET', 'https://attacker.example/api/v1/servers'),
    ).rejects.toMatchObject({
      code: 'invalid_control_path',
    });
  });

  it('stores only encrypted credentials and rolls transactions back atomically', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-store-'));
    const databasePath = join(directory, 'store.sqlite');
    const store = new SqliteStore(
      databasePath,
      new SecretBox('unit-test-store-key-00000000000000000000001'),
    );
    try {
      const credential = store.createCredential({
        name: 'Secret credential',
        payload: { type: 'bearer', token: 'plaintext-must-not-be-stored' },
      });
      expect(store.getCredentialPayload(credential.id)).toEqual({
        type: 'bearer',
        token: 'plaintext-must-not-be-stored',
      });
      const inspection = new DatabaseSync(databasePath, { readOnly: true });
      const row = z
        .object({ encrypted_payload: z.string() })
        .parse(
          inspection
            .prepare('SELECT encrypted_payload FROM credentials WHERE id = ?')
            .get(credential.id),
        );
      inspection.close();
      expect(row.encrypted_payload).not.toContain('plaintext-must-not-be-stored');

      expect(() =>
        store.transaction(() => {
          store.createCredential({
            name: 'Rolled back',
            payload: { type: 'headers', headers: { 'x-secret': 'rollback' } },
          });
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
      expect(store.listCredentials().map((item) => item.name)).not.toContain('Rolled back');
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails fast when the configured master key cannot decrypt stored credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-key-check-'));
    const databasePath = join(directory, 'store.sqlite');
    const store = new SqliteStore(
      databasePath,
      new SecretBox('unit-test-original-key-000000000000000000001'),
    );
    store.createCredential({
      name: 'Encrypted credential',
      payload: { type: 'bearer', token: 'stored-token' },
    });
    store.close();
    try {
      expect(
        () =>
          new SqliteStore(
            databasePath,
            new SecretBox('unit-test-different-key-0000000000000000001'),
          ),
      ).toThrow('cannot be decrypted');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('detects a changed master key before any credentials exist', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-empty-key-check-'));
    const databasePath = join(directory, 'store.sqlite');
    new SqliteStore(
      databasePath,
      new SecretBox('unit-test-empty-original-key-00000000000000001'),
    ).close();
    try {
      expect(
        () =>
          new SqliteStore(
            databasePath,
            new SecretBox('unit-test-empty-different-key-0000000000000001'),
          ),
      ).toThrow('cannot be decrypted');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('binds OAuth access tokens to one exact MCP resource', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-oauth-'));
    const store = new SqliteStore(
      join(directory, 'oauth.sqlite'),
      new SecretBox('unit-test-oauth-key-00000000000000000000001'),
    );
    try {
      const controlKey = 'tch_ctl_oauth-control-key-00000000000000000000000001';
      const hasher = new ApiKeyHasher('oauth-test-pepper');
      const auth = new AuthService(store, hasher);
      auth.ensureBootstrapControlKey(controlKey);
      const registrar = new OAuthServer(
        new URL('https://mcp.example.test'),
        'oauth-server-master-key-000000000000000000001',
        auth,
      );
      const registered = z
        .object({ client_id: z.string() })
        .passthrough()
        .parse(
          registrar.register({
            client_name: 'Unit test client',
            redirect_uris: ['http://127.0.0.1/callback'],
            token_endpoint_auth_method: 'none',
          }),
        );
      const oauth = new OAuthServer(
        new URL('https://mcp.example.test'),
        'oauth-server-master-key-000000000000000000001',
        auth,
      );
      const verifier = 'v'.repeat(64);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const authorize = new URL('https://mcp.example.test/oauth/authorize');
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('client_id', registered.client_id);
      authorize.searchParams.set('redirect_uri', 'http://127.0.0.1/callback');
      authorize.searchParams.set('code_challenge', challenge);
      authorize.searchParams.set('code_challenge_method', 'S256');
      authorize.searchParams.set('resource', 'https://mcp.example.test/mcp');
      authorize.searchParams.set('scope', 'mcp:use');
      const privateMetadata = new URL(authorize);
      privateMetadata.searchParams.set('client_id', 'https://127.0.0.1/client.json');
      await expect(oauth.beginAuthorization(privateMetadata)).rejects.toMatchObject({
        code: 'invalid_client',
      });
      const page = await oauth.beginAuthorization(authorize);
      const html = await page.text();
      const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
      if (!requestId) throw new Error('OAuth request ID unavailable');
      const approval = new FormData();
      approval.set('request_id', requestId);
      approval.set('control_key', controlKey);
      approval.set('decision', 'approve');
      const redirect = oauth.approveAuthorization(approval);
      const location = redirect.headers.get('location');
      if (!location) throw new Error('OAuth redirect unavailable');
      const code = new URL(location).searchParams.get('code');
      if (!code) throw new Error('OAuth code unavailable');
      const tokenForm = new FormData();
      tokenForm.set('grant_type', 'authorization_code');
      tokenForm.set('code', code);
      tokenForm.set('client_id', registered.client_id);
      tokenForm.set('redirect_uri', 'http://127.0.0.1/callback');
      tokenForm.set('code_verifier', verifier);
      const tokenResponse = await oauth.token(tokenForm);
      const token = z
        .object({ access_token: z.string(), refresh_token: z.string() })
        .parse(await tokenResponse.json());
      const principal = await oauth.verifyAccessToken(
        token.access_token,
        new URL('https://mcp.example.test/mcp'),
      );
      expect(principal.clientId).toBe(registered.client_id);
      await expect(
        oauth.verifyAccessToken(token.access_token, new URL('https://mcp.example.test/mcp/remote')),
      ).rejects.toMatchObject({ code: 'invalid_token' });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
