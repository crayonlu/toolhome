import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import {
  createCredentialInputSchema,
  createServerInputObjectSchema,
  createServerInputSchema,
  parseBucketSeconds,
  setProjectionInputSchema,
  toolCallFilterSchema,
  updateCredentialInputSchema,
  updateServerInputSchema,
  type ApiKeyKind,
  type CredentialPayload,
  type ServerRecord,
  type TransportConfig,
} from '../domain/models.js';
import {
  parseHarnessConfig,
  toPreview,
  type HarnessImportedEntry,
} from '../config/harness-import.js';
import type { AuthService } from '../security/auth-service.js';
import type { Store } from '../storage/store.js';
import type { UpstreamManager } from '../upstream/manager.js';
import type { UpstreamOAuthService } from '../upstream/oauth-service.js';

const importCredentialSchema = createCredentialInputSchema.extend({
  ref: z.string().min(1).max(200),
});

const importServerSchema = createServerInputObjectSchema
  .omit({ credentialId: true })
  .extend({ credentialRef: z.string().min(1).max(200).nullable().default(null) })
  .superRefine((value, context) => {
    const valid =
      (value.kind === 'remote' && value.transport.type === 'streamable-http') ||
      (value.kind === 'home' && value.transport.type === 'stdio');
    if (!valid) {
      context.addIssue({
        code: 'custom',
        path: ['transport'],
        message: 'Transport does not match server kind',
      });
    }
  });

const importSchema = z.object({
  version: z.literal(1),
  secretsIncluded: z.literal(true),
  credentials: z.array(importCredentialSchema).default([]),
  servers: z.array(importServerSchema).default([]),
});

export class ControlService {
  readonly #store: Store;
  readonly #upstreams: UpstreamManager;
  readonly #auth: AuthService;
  readonly #publicUrl: URL;
  readonly #onServerRemoved: (slug: string) => Promise<void>;
  readonly #onRegistryChanged: () => void;
  readonly #upstreamOAuth: UpstreamOAuthService;

  constructor(
    store: Store,
    upstreams: UpstreamManager,
    auth: AuthService,
    publicUrl: URL,
    onServerRemoved: (slug: string) => Promise<void>,
    onRegistryChanged: () => void,
    upstreamOAuth: UpstreamOAuthService,
  ) {
    this.#store = store;
    this.#upstreams = upstreams;
    this.#auth = auth;
    this.#publicUrl = publicUrl;
    this.#onServerRemoved = onServerRemoved;
    this.#onRegistryChanged = onRegistryChanged;
    this.#upstreamOAuth = upstreamOAuth;
  }

  listServers() {
    return this.#store.listServers().map((server) => ({
      ...server,
      runtime: this.#store.getRuntimeState(server.id),
    }));
  }

  async createServer(value: unknown) {
    const input = createServerInputSchema.parse(value);
    this.#assertCredentialAssignment(input.credentialId, input.kind);
    const server = this.#store.createServer(input);
    this.#store.appendEvent({
      level: 'info',
      type: 'server.created',
      serverId: server.id,
      message: `Created ${server.slug}`,
      detail: { kind: server.kind },
    });
    this.#refreshInBackground(server.id);
    return server;
  }

  getServer(id: string) {
    const server = this.#store.getServer(id);
    if (!server) throw new AppError('server_not_found', 'Server not found', 404);
    return { ...server, runtime: this.#store.getRuntimeState(id) };
  }

  async updateServer(id: string, value: unknown) {
    const current = this.getServer(id);
    const input = updateServerInputSchema.parse(value);
    const connectionChanged =
      input.transport !== undefined ||
      input.credentialId !== undefined ||
      input.settings !== undefined;
    const enabledChanged = input.enabled !== undefined && input.enabled !== current.enabled;
    this.#assertCredentialAssignment(
      input.credentialId === undefined ? current.credentialId : input.credentialId,
      current.kind,
      id,
    );
    const server = this.#store.updateServer(id, input);
    if (connectionChanged) await this.#upstreams.invalidate(id);
    else if (!server.enabled) await this.#upstreams.remove(id);
    if (connectionChanged || !server.enabled) await this.#onServerRemoved(server.slug);
    else if (enabledChanged) this.#onRegistryChanged();
    this.#refreshInBackground(server.id);
    return server;
  }

  async deleteServer(id: string): Promise<void> {
    const server = this.getServer(id);
    await this.#upstreams.remove(id);
    this.#store.deleteServer(id);
    await this.#onServerRemoved(server.slug);
  }

  async enableServer(id: string) {
    const server = this.#store.updateServer(id, { enabled: true });
    const snapshot = await this.#upstreams.refresh(id);
    this.#onRegistryChanged();
    return { server, snapshot };
  }

  async disableServer(id: string) {
    const server = this.#store.updateServer(id, { enabled: false });
    await this.#upstreams.remove(id);
    await this.#onServerRemoved(server.slug);
    return server;
  }

  testServer(id: string) {
    return this.#upstreams.refresh(id);
  }

  refreshServer(id: string) {
    return this.#upstreams.refresh(id);
  }

  restartServer(id: string) {
    return this.#upstreams.restart(id);
  }

  serverCapabilities(id: string) {
    this.getServer(id);
    const snapshot = this.#store.getSnapshot(id);
    if (!snapshot) throw new AppError('snapshot_unavailable', 'No capability snapshot', 404);
    return snapshot;
  }

  serverStatus(id: string) {
    const server = this.getServer(id);
    return {
      server,
      runtime: this.#store.getRuntimeState(id),
      snapshot: this.#store.getSnapshot(id),
    };
  }

  serverLogs(id: string, limit = 100) {
    this.getServer(id);
    return this.#store.listEvents({ serverId: id, limit });
  }

  serverEndpoint(id: string) {
    const server = this.getServer(id);
    return {
      aggregateUrl: new URL('/mcp', this.#publicUrl).toString(),
      individualUrl: new URL(`/mcp/${server.slug}`, this.#publicUrl).toString(),
      authorization: { type: 'bearer', credential: 'MCP Access API Key or OAuth access token' },
    };
  }

  aggregateEndpoint() {
    return {
      url: new URL('/mcp', this.#publicUrl).toString(),
      authorization: { type: 'bearer', credential: 'MCP Access API Key or OAuth access token' },
    };
  }

  listCredentials() {
    return this.#store.listCredentials();
  }

  createCredential(value: unknown) {
    return this.#store.createCredential(createCredentialInputSchema.parse(value));
  }

  getCredential(id: string) {
    const credential = this.#store.getCredential(id);
    if (!credential) throw new AppError('credential_not_found', 'Credential not found', 404);
    return credential;
  }

  async updateCredential(id: string, value: unknown) {
    const input = updateCredentialInputSchema.parse(value);
    const nextPayload = input.payload ?? this.#store.getCredentialPayload(id);
    if (!nextPayload) throw new AppError('credential_not_found', 'Credential not found', 404);
    const attached = this.#store.listServers().filter((server) => server.credentialId === id);
    for (const server of attached) this.#assertCredentialPayload(nextPayload, server.kind);
    if (nextPayload.type === 'oauth') {
      if (attached.length > 1) {
        throw new AppError(
          'oauth_credential_reused',
          'OAuth credentials cannot be shared between MCP servers',
          409,
        );
      }
    }
    const credential = this.#store.updateCredential(id, input);
    await Promise.all(attached.map((server) => this.#upstreams.invalidate(server.id)));
    for (const server of attached) this.#refreshInBackground(server.id);
    return credential;
  }

  async deleteCredential(id: string): Promise<void> {
    const attached = this.#store.listServers().filter((server) => server.credentialId === id);
    for (const server of attached) await this.#upstreams.invalidate(server.id);
    this.#store.deleteCredential(id);
    for (const server of attached) this.#refreshInBackground(server.id);
  }

  async testCredential(id: string) {
    const credential = this.getCredential(id);
    const payload = this.#store.getCredentialPayload(id);
    if (!payload) throw new AppError('credential_not_found', 'Credential not found', 404);
    const expired =
      payload.type === 'oauth' && payload.expiresAt
        ? Date.parse(payload.expiresAt) <= Date.now()
        : false;
    const pending = payload.type === 'oauth' && !payload.accessToken;
    const refreshable = payload.type === 'oauth' && payload.refreshToken !== undefined;
    const attached = this.#store.listServers().filter((server) => server.credentialId === id);
    if ((expired && !refreshable) || pending) {
      return {
        credential,
        valid: false,
        requiresAuthorization: true,
        verifiedAgainstUpstream: false,
        servers: attached.map((server) => ({
          id: server.id,
          slug: server.slug,
          ok: false,
          error: pending ? 'Authorization required' : 'Credential expired',
        })),
      };
    }
    const attempts = await Promise.allSettled(
      attached.map(async (server) => {
        await this.#upstreams.refresh(server.id);
        return { id: server.id, slug: server.slug, ok: true };
      }),
    );
    const servers = attempts.map((attempt, index) => {
      const server = attached[index];
      if (!server) throw new Error('Credential verification result mismatch');
      return attempt.status === 'fulfilled'
        ? attempt.value
        : {
            id: server.id,
            slug: server.slug,
            ok: false,
            error:
              attempt.reason instanceof Error ? attempt.reason.message : String(attempt.reason),
          };
    });
    return {
      credential,
      valid: servers.every((server) => server.ok),
      requiresAuthorization: servers.some(
        (server) =>
          !server.ok &&
          'error' in server &&
          typeof server.error === 'string' &&
          /401|403|unauthorized|authorization required/i.test(server.error),
      ),
      verifiedAgainstUpstream: attached.length > 0,
      servers,
    };
  }

  authorizeCredential(id: string, value: unknown) {
    this.getCredential(id);
    return this.#upstreamOAuth.begin(id, value);
  }

  revokeCredential(id: string) {
    this.getCredential(id);
    return this.#upstreamOAuth.revoke(id);
  }

  listKeys(kind: ApiKeyKind) {
    return this.#store.listApiKeys(kind);
  }

  createKey(kind: ApiKeyKind, name: string, scope?: 'admin' | 'agent') {
    if (kind === 'control' && scope !== undefined) {
      return this.#auth.issue('control', name, scope);
    }
    return this.#auth.issue(kind, name);
  }

  revokeKey(kind: ApiKeyKind, id: string): void {
    const key = this.#store.getApiKey(id, kind);
    if (!key || key.revokedAt !== null) {
      throw new AppError('api_key_not_found', 'API key not found', 404);
    }
    if (kind === 'control' && this.#store.listApiKeys('control').length <= 1) {
      throw new AppError(
        'last_control_key',
        'Create another Control API Key before revoking the last active key',
        409,
      );
    }
    this.#store.revokeApiKey(id, kind);
  }

  overview() {
    const servers = this.#store.listServers();
    const clis = this.#store.listClis();
    const states = servers.map((server) => this.#store.getRuntimeState(server.id));
    const unhealthy = states.filter(
      (state) => state && !['ready', 'disabled', 'unknown'].includes(state.status),
    ).length;
    return {
      servers: {
        total: servers.length,
        enabled: servers.filter((server) => server.enabled).length,
        remote: servers.filter((server) => server.kind === 'remote').length,
        home: servers.filter((server) => server.kind === 'home').length,
        ready: states.filter((state) => state?.status === 'ready').length,
        unhealthy,
      },
      clis: {
        total: clis.length,
        enabled: clis.filter((cli) => cli.enabled).length,
      },
      credentials: this.#store.listCredentials().length,
      accessKeys: this.#store.listApiKeys('access').length,
      controlKeys: this.#store.listApiKeys('control').length,
      ok: unhealthy === 0,
      endpoints: {
        aggregate: new URL('/mcp', this.#publicUrl).toString(),
        individual: Object.fromEntries(
          servers.map((server) => [
            server.slug,
            new URL(`/mcp/${server.slug}`, this.#publicUrl).toString(),
          ]),
        ),
      },
    };
  }

  diagnostics() {
    const servers = this.#store.listServers();
    const clis = this.#store.listClis();
    return {
      ok: servers.every((server) => {
        const status = this.#store.getRuntimeState(server.id)?.status;
        return !server.enabled || status === 'ready';
      }),
      database: 'ok',
      servers: servers.map((server) => ({
        id: server.id,
        slug: server.slug,
        enabled: server.enabled,
        status: this.#store.getRuntimeState(server.id)?.status ?? 'unknown',
        hasSnapshot: this.#store.getSnapshot(server.id) !== null,
      })),
      clis: clis.map((cli) => ({
        id: cli.id,
        slug: cli.slug,
        enabled: cli.enabled,
        status: cli.enabled ? 'configured' : 'disabled',
      })),
    };
  }

  exportConfig(includeSecrets = false) {
    return {
      version: 1,
      secretsIncluded: includeSecrets,
      exportedAt: new Date().toISOString(),
      credentials: this.#store.listCredentials().map((credential) => {
        const payload = includeSecrets ? this.#store.getCredentialPayload(credential.id) : null;
        return {
          ref: credential.id,
          name: credential.name,
          type: credential.type,
          ...(payload === null ? {} : { payload }),
        };
      }),
      servers: this.#store.listServers().map((server) => ({
        slug: server.slug,
        name: server.name,
        kind: server.kind,
        transport: includeSecrets ? server.transport : redactTransport(server.transport),
        credentialRef: server.credentialId,
        enabled: server.enabled,
        settings: server.settings,
      })),
    };
  }

  importConfig(value: unknown) {
    const input = importSchema.parse(value);
    const refs = new Set<string>();
    for (const credential of input.credentials) {
      if (refs.has(credential.ref)) {
        throw new AppError(
          'duplicate_credential_ref',
          `Duplicate credential ref: ${credential.ref}`,
          400,
        );
      }
      refs.add(credential.ref);
    }
    for (const server of input.servers) {
      if (server.credentialRef !== null && !refs.has(server.credentialRef)) {
        throw new AppError(
          'credential_ref_not_found',
          `Unknown credential ref: ${server.credentialRef}`,
          400,
        );
      }
    }

    const imported = this.#store.transaction(() => {
      const credentialIds = new Map<string, string>();
      const credentials = input.credentials.map((credential) => {
        const created = this.#store.createCredential({
          name: credential.name,
          payload: credential.payload,
        });
        credentialIds.set(credential.ref, created.id);
        return created;
      });
      const servers = input.servers.map((server) => {
        const credentialId =
          server.credentialRef === null ? null : (credentialIds.get(server.credentialRef) ?? null);
        this.#assertCredentialAssignment(credentialId, server.kind);
        return this.#store.createServer({
          slug: server.slug,
          name: server.name,
          kind: server.kind,
          transport: server.transport,
          credentialId,
          enabled: server.enabled,
          settings: server.settings,
        });
      });
      return { credentials, servers };
    });
    for (const server of imported.servers) this.#refreshInBackground(server.id);
    return imported;
  }

  async importHarnessConfig(value: unknown, preview = false, mode: 'create' | 'upsert' = 'create') {
    const entries = parseHarnessConfig(value);
    if (preview) {
      return {
        preview: true,
        entries: entries.map((entry) => this.#harnessPreview(entry, mode)),
      };
    }
    const results = await Promise.all(
      entries.map(async (entry) => {
        const existing = this.#store.getServerBySlug(entry.slug);
        if (existing) {
          if (mode === 'create') {
            return {
              name: entry.name,
              slug: entry.slug,
              status: 'conflict',
              message: `A server with slug "${entry.slug}" already exists`,
              warnings: entry.warnings,
            };
          }
          const changes = this.#harnessDiff(entry, existing);
          if (changes.length === 0) {
            return {
              name: entry.name,
              slug: entry.slug,
              status: 'unchanged',
              warnings: entry.warnings,
            };
          }
          const outcome = this.#applyHarnessUpdate(entry, existing, changes);
          return outcome;
        }
        const created = this.#store.transaction(() => {
          let credentialId: string | null = null;
          if (entry.credential !== null) {
            credentialId = this.#store.createCredential({
              name: entry.credential.name,
              payload: entry.credential.payload,
            }).id;
          }
          const server = this.#store.createServer(
            createServerInputSchema.parse({
              slug: entry.slug,
              name: entry.name,
              kind: entry.kind,
              transport: entry.transport,
              credentialId,
              enabled: true,
            }),
          );
          return { serverId: server.id, credentialId };
        });
        this.#refreshInBackground(created.serverId);
        return {
          name: entry.name,
          slug: entry.slug,
          status: 'created',
          serverId: created.serverId,
          credentialId: created.credentialId,
          warnings: entry.warnings,
        };
      }),
    );
    return { preview: false, entries: results };
  }

  /** Preview with per-entry status (created/changed/unchanged/conflict) — secrets masked. */
  #harnessPreview(entry: HarnessImportedEntry, mode: 'create' | 'upsert') {
    const base = toPreview(entry);
    const existing = this.#store.getServerBySlug(entry.slug);
    if (!existing) return { ...base, status: 'created', changes: [] as string[] };
    if (mode === 'create') {
      return {
        ...base,
        status: 'conflict',
        changes: [] as string[],
        message: `A server with slug "${entry.slug}" already exists`,
      };
    }
    const changes = this.#harnessDiff(entry, existing);
    return { ...base, status: changes.length === 0 ? 'unchanged' : 'changed', changes };
  }

  /** Field-level diff between a parsed entry and the stored server — names only, never values. */
  #harnessDiff(entry: HarnessImportedEntry, existing: ServerRecord): string[] {
    const changes: string[] = [];
    const current = existing.transport;
    const next = entry.transport;
    if (next.type === 'streamable-http' && current.type === 'streamable-http') {
      if (current.url !== next.url) changes.push('url');
      if (JSON.stringify(current.headers) !== JSON.stringify(next.headers)) {
        changes.push('headers');
      }
    } else if (next.type === 'stdio' && current.type === 'stdio') {
      if (current.command !== next.command) changes.push('command');
      if (JSON.stringify(current.args) !== JSON.stringify(next.args)) changes.push('args');
      if (JSON.stringify(current.env ?? {}) !== JSON.stringify(next.env ?? {})) changes.push('env');
    } else if (current.type !== next.type) {
      changes.push('transport');
    }
    const currentPayload = existing.credentialId
      ? this.#store.getCredentialPayload(existing.credentialId)
      : null;
    const nextPayload = entry.credential?.payload ?? null;
    if (JSON.stringify(currentPayload ?? null) !== JSON.stringify(nextPayload)) {
      changes.push('credential');
    }
    return changes;
  }

  #applyHarnessUpdate(
    entry: HarnessImportedEntry,
    existing: ServerRecord,
    changes: string[],
  ): Promise<{
    name: string;
    slug: string;
    status: string;
    serverId: string;
    changes: string[];
    warnings: string[];
  }> {
    return (async () => {
      if (changes.some((change) => change !== 'credential')) {
        await this.updateServer(existing.id, { transport: entry.transport });
      }
      if (changes.includes('credential')) {
        if (existing.credentialId && entry.credential) {
          await this.updateCredential(existing.credentialId, { payload: entry.credential.payload });
        } else if (!existing.credentialId && entry.credential) {
          const credential = this.#store.createCredential({
            name: entry.credential.name,
            payload: entry.credential.payload,
          });
          await this.updateServer(existing.id, { credentialId: credential.id });
        }
        // credential removed from the harness config is kept — stripping a
        // credential silently would break a working server; report instead.
      }
      return {
        name: entry.name,
        slug: entry.slug,
        status: 'changed',
        serverId: existing.id,
        changes,
        warnings: entry.warnings,
      };
    })();
  }

  #assertCredentialAssignment(
    credentialId: string | null,
    serverKind: 'remote' | 'home',
    serverId?: string,
  ): void {
    if (credentialId === null) return;
    const payload = this.#store.getCredentialPayload(credentialId);
    if (!payload) throw new AppError('credential_not_found', 'Credential not found', 400);
    this.#assertCredentialPayload(payload, serverKind);
    if (payload.type !== 'oauth') return;
    const reused = this.#store
      .listServers()
      .some((server) => server.credentialId === credentialId && server.id !== serverId);
    if (reused) {
      throw new AppError(
        'oauth_credential_reused',
        'OAuth credentials cannot be shared between MCP servers',
        409,
      );
    }
  }

  #assertCredentialPayload(payload: CredentialPayload, serverKind: 'remote' | 'home'): void {
    if (serverKind === 'home' && payload.type !== 'env') {
      throw new AppError(
        'credential_kind_mismatch',
        'Home-hosted servers only accept environment credentials',
        400,
      );
    }
    if (serverKind === 'remote' && payload.type === 'env') {
      throw new AppError(
        'credential_kind_mismatch',
        'Remote servers do not accept environment credentials',
        400,
      );
    }
  }

  #refreshInBackground(serverId: string): void {
    const server = this.#store.getServer(serverId);
    if (!server?.enabled) return;
    void this.#upstreams.refresh(serverId).catch(() => undefined);
  }

  // ── Tool visibility projection ──────────────────────────────────────────

  getProjection(serverId: string) {
    const server = this.#requireServer(serverId);
    const projection = this.#store.getServerProjection(server.id);
    const overrides = Object.fromEntries(
      this.#store
        .listToolProjections(server.id)
        .filter((entry) => entry.visibility !== 'inherit')
        .map((entry) => [entry.upstreamToolName, entry.visibility]),
    );
    const snapshot = this.#store.getSnapshot(server.id);
    const tools = (snapshot?.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      visible: this.#isToolVisible(tool.name, projection?.defaultVisibility, overrides),
    }));
    return {
      serverId: server.id,
      defaultVisibility: projection?.defaultVisibility ?? 'visible',
      overrides,
      tools,
    };
  }

  setProjection(serverId: string, value: unknown) {
    const server = this.#requireServer(serverId);
    const input = setProjectionInputSchema.parse(value);
    if (input.defaultVisibility !== undefined) {
      this.#store.setServerProjection(server.id, input.defaultVisibility);
    }
    for (const override of input.overrides ?? []) {
      this.#store.setToolProjection(server.id, override.tool, override.visibility);
    }
    this.#onRegistryChanged();
    return this.getProjection(server.id);
  }

  #isToolVisible(
    toolName: string,
    defaultVisibility: 'visible' | 'hidden' | undefined,
    overrides: Record<string, string>,
  ): boolean {
    const override = overrides[toolName];
    if (override === 'visible' || override === 'hidden') return override === 'visible';
    return (defaultVisibility ?? 'visible') === 'visible';
  }

  // ── Tool call observability ─────────────────────────────────────────────

  listCalls(value: Record<string, unknown>) {
    const input = {
      limit: value.limit === undefined ? 50 : Number(value.limit),
      offset: value.offset === undefined ? 0 : Number(value.offset),
      serverId: value.server_id,
      tool: value.tool,
      endpointType: value.endpoint_type,
      principalId: value.principal_id,
      status: value.status,
      from: value.from,
      to: value.to,
    };
    const filter = toolCallFilterSchema.parse(input);
    return {
      items: this.#store.listToolCalls(filter),
      total: this.#store.countToolCalls(filter),
    };
  }

  callStats(value: Record<string, unknown>) {
    const input = {
      serverId: value.server_id,
      tool: value.tool,
      endpointType: value.endpoint_type,
      from: value.from,
      to: value.to,
    };
    const filter = toolCallFilterSchema.partial().parse({
      limit: 50,
      offset: 0,
      ...input,
    });
    return this.#store.toolCallStats(filter);
  }

  callSeries(value: Record<string, unknown>) {
    const bucketSeconds = parseBucketSeconds(
      typeof value.bucket === 'string' ? value.bucket : undefined,
    );
    const now = new Date();
    const from =
      typeof value.from === 'string'
        ? value.from
        : new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const to = typeof value.to === 'string' ? value.to : now.toISOString();
    const serverId = typeof value.server_id === 'string' ? value.server_id : undefined;
    const tool = typeof value.tool === 'string' ? value.tool : undefined;
    const endpointType =
      value.endpoint_type === undefined
        ? undefined
        : z.enum(['aggregate', 'individual', 'management', 'cli']).parse(value.endpoint_type);
    const buckets = this.#store.toolCallSeries({
      from,
      to,
      bucketSeconds,
      serverId,
      tool,
      endpointType,
    });

    const start = Math.floor(Date.parse(from) / 1000 / bucketSeconds);
    const end = Math.floor(Date.parse(to) / 1000 / bucketSeconds);
    const byBucket = new Map(buckets.map((item) => [item.bucket, item]));
    const points: { bucket: string; total: number; success: number; error: number }[] = [];
    for (let bucket = start; bucket <= end; bucket += 1) {
      const item = byBucket.get(bucket);
      const total = item?.total ?? 0;
      const success = item?.success ?? 0;
      points.push({
        bucket: new Date(bucket * bucketSeconds * 1000).toISOString(),
        total,
        success,
        error: total - success,
      });
    }
    return { bucketSeconds, points };
  }

  #requireServer(serverId: string) {
    const server = this.#store.getServer(serverId);
    if (!server) {
      throw new AppError('server_not_found', 'Server not found', 404);
    }
    return server;
  }
}

function redactTransport(transport: TransportConfig): TransportConfig {
  if (transport.type === 'streamable-http') {
    return {
      ...transport,
      headers: Object.fromEntries(
        Object.keys(transport.headers).map((name) => [name, '[REDACTED]']),
      ),
    };
  }
  return {
    ...transport,
    env: Object.fromEntries(Object.keys(transport.env).map((name) => [name, '[REDACTED]'])),
  };
}
