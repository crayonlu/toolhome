import { describe, expect, it } from 'vitest';
import type { CredentialPayload, CredentialRecord, ServerRecord } from '../../src/domain/models.js';
import {
  OAUTH_REFRESH_GRACE_SECONDS,
  selectDueOAuthCredentials,
  selectExpiredUnrefreshableOAuthCredentials,
} from '../../src/upstream/oauth-refresh.js';

const HOUR = 3_600_000;

function credential(id: string, payload: CredentialPayload): CredentialRecord {
  return {
    id,
    name: `Credential ${id}`,
    type: payload.type,
    status: 'ready',
    expiresAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function oauthPayload(overrides: Partial<Extract<CredentialPayload, { type: 'oauth' }>> = {}) {
  return {
    type: 'oauth' as const,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
    ...overrides,
  } as Extract<CredentialPayload, { type: 'oauth' }>;
}

function remoteServer(id: string, credentialId: string | null, enabled = true): ServerRecord {
  return {
    id,
    slug: `server-${id}`,
    name: `Server ${id}`,
    kind: 'remote',
    nodeId: null,
    transport: {
      type: 'streamable-http',
      url: 'https://mcp.example.test/mcp',
      protocolMode: 'auto',
      allowSseFallback: false,
      headers: {},
    },
    credentialId,
    enabled,
    settings: {
      connectTimeoutMs: 15_000,
      requestTimeoutMs: 60_000,
      maxTotalTimeoutMs: 600_000,
      maxConcurrency: 1,
      restart: 'on-failure',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function homeServer(id: string, credentialId: string | null): ServerRecord {
  return {
    id,
    slug: `home-${id}`,
    name: `Home ${id}`,
    kind: 'home',
    nodeId: null,
    transport: {
      type: 'stdio',
      command: 'node',
      args: [],
      env: {},
      protocolMode: 'auto',
    },
    credentialId,
    enabled: true,
    settings: {
      connectTimeoutMs: 15_000,
      requestTimeoutMs: 60_000,
      maxTotalTimeoutMs: 600_000,
      maxConcurrency: 1,
      restart: 'on-failure',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function select(
  credentials: CredentialRecord[],
  payloads: Map<string, CredentialPayload>,
  servers: ServerRecord[],
  now = Date.now(),
) {
  return selectDueOAuthCredentials({
    credentials,
    payloads,
    servers,
    now,
    graceSeconds: OAUTH_REFRESH_GRACE_SECONDS,
  });
}

describe('selectDueOAuthCredentials', () => {
  it('selects an expired refreshable credential attached to an enabled remote server', () => {
    const payload = oauthPayload({ expiresAt: new Date(Date.now() - HOUR).toISOString() });
    const payloads = new Map([['cred-1', payload]]);
    const due = select([credential('cred-1', payload)], payloads, [
      remoteServer('server-1', 'cred-1'),
    ]);
    expect(due).toEqual([{ credentialId: 'cred-1', server: remoteServer('server-1', 'cred-1') }]);
  });

  it('selects a credential expiring within the grace window', () => {
    const payload = oauthPayload({
      expiresAt: new Date(Date.now() + OAUTH_REFRESH_GRACE_SECONDS * 500).toISOString(),
    });
    const payloads = new Map([['cred-1', payload]]);
    const due = select([credential('cred-1', payload)], payloads, [
      remoteServer('server-1', 'cred-1'),
    ]);
    expect(due.map((c) => c.credentialId)).toEqual(['cred-1']);
  });

  it('leaves a still-valid credential untouched', () => {
    const payload = oauthPayload({
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    const payloads = new Map([['cred-1', payload]]);
    const due = select([credential('cred-1', payload)], payloads, [
      remoteServer('server-1', 'cred-1'),
    ]);
    expect(due).toEqual([]);
  });

  it('excludes expired credentials without a refresh token', () => {
    const payload = oauthPayload({
      refreshToken: undefined,
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const payloads = new Map([['cred-1', payload]]);
    const due = select([credential('cred-1', payload)], payloads, [
      remoteServer('server-1', 'cred-1'),
    ]);
    expect(due).toEqual([]);
  });

  it('excludes credentials without an expiresAt (unschedulable)', () => {
    const payload = oauthPayload({ expiresAt: undefined });
    const payloads = new Map([['cred-1', payload]]);
    const due = select([credential('cred-1', payload)], payloads, [
      remoteServer('server-1', 'cred-1'),
    ]);
    expect(due).toEqual([]);
  });

  it('excludes credentials not attached to any server', () => {
    const payload = oauthPayload({ expiresAt: new Date(Date.now() - HOUR).toISOString() });
    const payloads = new Map([['cred-1', payload]]);
    const due = select([credential('cred-1', payload)], payloads, []);
    expect(due).toEqual([]);
  });

  it('excludes credentials attached to a disabled server', () => {
    const payload = oauthPayload({ expiresAt: new Date(Date.now() - HOUR).toISOString() });
    const payloads = new Map([['cred-1', payload]]);
    const due = select([credential('cred-1', payload)], payloads, [
      remoteServer('server-1', 'cred-1', false),
    ]);
    expect(due).toEqual([]);
  });

  it('excludes credentials attached to more than one server', () => {
    const payload = oauthPayload({ expiresAt: new Date(Date.now() - HOUR).toISOString() });
    const payloads = new Map([['cred-1', payload]]);
    const due = select([credential('cred-1', payload)], payloads, [
      remoteServer('server-1', 'cred-1'),
      remoteServer('server-2', 'cred-1'),
    ]);
    expect(due).toEqual([]);
  });

  it('excludes credentials attached to a stdio home server', () => {
    const payload = oauthPayload({ expiresAt: new Date(Date.now() - HOUR).toISOString() });
    const payloads = new Map([['cred-1', payload]]);
    const due = select([credential('cred-1', payload)], payloads, [
      homeServer('server-1', 'cred-1'),
    ]);
    expect(due).toEqual([]);
  });

  it('excludes non-OAuth credential types', () => {
    const payload: CredentialPayload = { type: 'bearer', token: 'token' };
    const payloads = new Map([['cred-1', payload]]);
    const due = select([credential('cred-1', payload)], payloads, [
      remoteServer('server-1', 'cred-1'),
    ]);
    expect(due).toEqual([]);
  });
});

describe('selectExpiredUnrefreshableOAuthCredentials', () => {
  function stalled(
    credentials: CredentialRecord[],
    payloads: Map<string, CredentialPayload>,
    servers: ServerRecord[],
  ) {
    return selectExpiredUnrefreshableOAuthCredentials({
      credentials,
      payloads,
      servers,
      now: Date.now(),
      graceSeconds: OAUTH_REFRESH_GRACE_SECONDS,
    });
  }

  it('reports expired credentials that lack a refresh token', () => {
    const payload = oauthPayload({
      refreshToken: undefined,
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const payloads = new Map([['cred-1', payload]]);
    const due = stalled([credential('cred-1', payload)], payloads, [
      remoteServer('server-1', 'cred-1'),
    ]);
    expect(due.map((c) => c.credentialId)).toEqual(['cred-1']);
  });

  it('ignores refreshable and still-valid credentials', () => {
    const expiredRefreshable = oauthPayload({
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const healthy = oauthPayload({ expiresAt: new Date(Date.now() + HOUR).toISOString() });
    const payloads = new Map([
      ['cred-1', expiredRefreshable],
      ['cred-2', healthy],
    ]);
    const due = stalled(
      [credential('cred-1', expiredRefreshable), credential('cred-2', healthy)],
      payloads,
      [remoteServer('server-1', 'cred-1'), remoteServer('server-2', 'cred-2')],
    );
    expect(due).toEqual([]);
  });

  it('ignores unrefreshable credentials that are not yet expired', () => {
    const payload = oauthPayload({
      refreshToken: undefined,
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    const payloads = new Map([['cred-1', payload]]);
    const due = stalled([credential('cred-1', payload)], payloads, [
      remoteServer('server-1', 'cred-1'),
    ]);
    expect(due).toEqual([]);
  });
});
