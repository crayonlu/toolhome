import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { OAuthCredentialPayload } from '../../src/domain/models.js';
import { waitFor } from '../support/mcp-client.js';
import { startOAuthAuthServer, type OAuthAuthServerFixture } from '../support/oauth-auth-server.js';
import { controlRequest, createTestRuntime, jsonResponse } from '../support/runtime.js';

const HOUR = 3_600_000;

const fullSettings = {
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  maxTotalTimeoutMs: 600_000,
  maxConcurrency: 1,
  restart: 'on-failure',
} as const;

function expiredIso(): string {
  return new Date(Date.now() - HOUR).toISOString();
}

function futureIso(): string {
  return new Date(Date.now() + HOUR).toISOString();
}

function oauthPayload(
  fixture: OAuthAuthServerFixture,
  overrides: Partial<OAuthCredentialPayload> = {},
): OAuthCredentialPayload {
  return {
    type: 'oauth',
    accessToken: 'seed-access-token',
    refreshToken: 'seed-refresh-token',
    tokenType: 'Bearer',
    expiresAt: expiredIso(),
    issuer: fixture.origin,
    clientInformation: { client_id: 'test-client', issuer: fixture.origin },
    ...overrides,
  };
}

const credentialTestSchema = z.object({
  valid: z.boolean(),
  requiresAuthorization: z.boolean(),
  servers: z.array(z.object({ ok: z.boolean() }).passthrough()).optional(),
});

const authorizeSchema = z.object({
  status: z.string(),
  authorizationUrl: z.string(),
});

describe('OAuth credential auto-refresh sweep', () => {
  it('fires by itself and refreshes an expired credential through the refresh grant', async () => {
    const fixture = await startOAuthAuthServer({ requireAuth: true });
    const testRuntime = createTestRuntime({ config: { oauthRefreshIntervalSeconds: 1 } });
    try {
      const payload = oauthPayload(fixture);
      const credential = testRuntime.runtime.store.createCredential({
        name: 'Expired OAuth fixture',
        payload,
      });
      const server = testRuntime.runtime.store.createServer({
        slug: 'oauth-expired',
        name: 'OAuth remote fixture',
        kind: 'remote',
        nodeId: null,
        transport: {
          type: 'streamable-http',
          url: fixture.url.toString(),
          protocolMode: 'modern',
          allowSseFallback: false,
          headers: {},
        },
        credentialId: credential.id,
        enabled: true,
        settings: fullSettings,
      });

      // No control API call and no console action: the scheduled sweep must
      // perform the refresh entirely by itself.
      await waitFor(async () => {
        const current = testRuntime.runtime.store.getCredentialPayload(credential.id);
        if (current?.type !== 'oauth' || current.accessToken === 'seed-access-token') {
          return false;
        }
        if (testRuntime.runtime.store.getRuntimeState(server.id)?.status !== 'ready') {
          return false;
        }
        return testRuntime.runtime.store
          .listEvents()
          .some((event) => event.type === 'credential.auto_refreshed');
      }, 20_000);

      const refreshed = testRuntime.runtime.store.getCredentialPayload(credential.id);
      expect(refreshed?.type).toBe('oauth');
      if (refreshed?.type !== 'oauth') throw new Error('payload lost during refresh');
      expect(refreshed.accessToken).not.toBe('seed-access-token');
      expect(fixture.issuedTokens()).toContain(refreshed.accessToken);
      expect(refreshed.expiresAt).toBeDefined();
      expect(Date.parse(refreshed.expiresAt!)).toBeGreaterThan(Date.now());
      expect(refreshed.authorizationUrl).toBeUndefined();
      expect(fixture.refreshAttempts()).toBeGreaterThanOrEqual(1);

      const record = testRuntime.runtime.store.getCredential(credential.id);
      expect(record?.status).toBe('ready');

      const state = testRuntime.runtime.store.getRuntimeState(server.id);
      expect(state?.status).toBe('ready');

      const events = testRuntime.runtime.store.listEvents();
      expect(events.some((event) => event.type === 'credential.auto_refreshed')).toBe(true);
      expect(events.some((event) => event.type === 'credential.auto_refresh_failed')).toBe(false);
    } finally {
      await testRuntime.close();
      await fixture.close();
    }
  });

  it('leaves an expired credential without a refresh token expired and logs the failure', async () => {
    const fixture = await startOAuthAuthServer({ requireAuth: true });
    const testRuntime = createTestRuntime({ config: { oauthRefreshIntervalSeconds: 1 } });
    try {
      const payload = oauthPayload(fixture, { refreshToken: undefined });
      const credential = testRuntime.runtime.store.createCredential({
        name: 'Expired unrefreshable OAuth fixture',
        payload,
      });
      testRuntime.runtime.store.createServer({
        slug: 'oauth-unrefreshable',
        name: 'OAuth remote fixture',
        kind: 'remote',
        nodeId: null,
        transport: {
          type: 'streamable-http',
          url: fixture.url.toString(),
          protocolMode: 'modern',
          allowSseFallback: false,
          headers: {},
        },
        credentialId: credential.id,
        enabled: true,
        settings: fullSettings,
      });

      await waitFor(() => {
        const events = testRuntime.runtime.store.listEvents();
        return events.some((event) => event.type === 'credential.auto_refresh_failed');
      }, 20_000);

      expect(testRuntime.runtime.store.getCredential(credential.id)?.status).toBe('expired');
      const current = testRuntime.runtime.store.getCredentialPayload(credential.id);
      expect(current?.type === 'oauth' && current.accessToken).toBe('seed-access-token');
      expect(fixture.refreshAttempts()).toBe(0);

      const tested = credentialTestSchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            `/api/v1/credentials/${credential.id}/test`,
          ),
        ),
      );
      expect(tested.valid).toBe(false);
      expect(tested.requiresAuthorization).toBe(true);

      const authorized = authorizeSchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            `/api/v1/credentials/${credential.id}/authorize`,
          ),
        ),
      );
      expect(authorized.status).toBe('authorization-required');
      expect(authorized.authorizationUrl).toContain(`${fixture.origin}/oauth/authorize`);
    } finally {
      await testRuntime.close();
      await fixture.close();
    }
  });

  it('keeps the credential expired and logs the failure when the refresh grant is rejected', async () => {
    const fixture = await startOAuthAuthServer({ requireAuth: true });
    fixture.setRejectRefresh(true);
    const testRuntime = createTestRuntime({ config: { oauthRefreshIntervalSeconds: 1 } });
    try {
      const payload = oauthPayload(fixture);
      const credential = testRuntime.runtime.store.createCredential({
        name: 'Rejected refresh OAuth fixture',
        payload,
      });
      testRuntime.runtime.store.createServer({
        slug: 'oauth-rejected',
        name: 'OAuth remote fixture',
        kind: 'remote',
        nodeId: null,
        transport: {
          type: 'streamable-http',
          url: fixture.url.toString(),
          protocolMode: 'modern',
          allowSseFallback: false,
          headers: {},
        },
        credentialId: credential.id,
        enabled: true,
        settings: fullSettings,
      });

      await waitFor(() => {
        const events = testRuntime.runtime.store.listEvents();
        return events.some(
          (event) =>
            event.type === 'credential.auto_refresh_failed' &&
            event.detail?.reason === 'refresh-rejected',
        );
      }, 20_000);

      expect(testRuntime.runtime.store.getCredential(credential.id)?.status).toBe('expired');
      const current = testRuntime.runtime.store.getCredentialPayload(credential.id);
      expect(current?.type === 'oauth' && current.accessToken).toBe('seed-access-token');
      expect(current?.type === 'oauth' && current.refreshToken).toBe('seed-refresh-token');
      const events = testRuntime.runtime.store.listEvents();
      expect(events.some((event) => event.type === 'credential.auto_refreshed')).toBe(false);

      const tested = credentialTestSchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            `/api/v1/credentials/${credential.id}/test`,
          ),
        ),
      );
      expect(tested.valid).toBe(false);
      expect(tested.requiresAuthorization).toBe(true);

      const authorized = authorizeSchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            `/api/v1/credentials/${credential.id}/authorize`,
          ),
        ),
      );
      expect(authorized.status).toBe('authorization-required');
      expect(authorized.authorizationUrl).toContain(`${fixture.origin}/oauth/authorize`);
    } finally {
      await testRuntime.close();
      await fixture.close();
    }
  });

  it('leaves healthy credentials completely untouched across repeated sweeps', async () => {
    const fixture = await startOAuthAuthServer({ requireAuth: true });
    const testRuntime = createTestRuntime({ config: { oauthRefreshIntervalSeconds: 1 } });
    try {
      const payload = oauthPayload(fixture, {
        accessToken: 'healthy-access-token',
        expiresAt: futureIso(),
      });
      const credential = testRuntime.runtime.store.createCredential({
        name: 'Healthy OAuth fixture',
        payload,
      });
      const server = testRuntime.runtime.store.createServer({
        slug: 'oauth-healthy',
        name: 'OAuth remote fixture',
        kind: 'remote',
        nodeId: null,
        transport: {
          type: 'streamable-http',
          url: fixture.url.toString(),
          protocolMode: 'modern',
          allowSseFallback: false,
          headers: {},
        },
        credentialId: credential.id,
        enabled: true,
        settings: fullSettings,
      });

      // Let several sweep intervals pass.
      await new Promise((resolve) => setTimeout(resolve, 3_500));

      const current = testRuntime.runtime.store.getCredentialPayload(credential.id);
      expect(current?.type === 'oauth' && current.accessToken).toBe('healthy-access-token');
      expect(current?.type === 'oauth' && current.expiresAt).toBe(payload.expiresAt);
      expect(testRuntime.runtime.store.getCredential(credential.id)?.status).toBe('ready');
      // Never connected or reconnected: the runtime state stays at the
      // initial 'unknown' the store seeds on server creation.
      expect(testRuntime.runtime.store.getRuntimeState(server.id)?.status).toBe('unknown');
      expect(fixture.refreshAttempts()).toBe(0);
      const events = testRuntime.runtime.store.listEvents();
      expect(
        events.some(
          (event) =>
            event.type === 'credential.auto_refreshed' ||
            event.type === 'credential.auto_refresh_failed',
        ),
      ).toBe(false);
    } finally {
      await testRuntime.close();
      await fixture.close();
    }
  });
});
