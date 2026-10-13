import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import {
  createCredentialInputSchema,
  createServerInputObjectSchema,
  createServerInputSchema,
  isHostHosted,
  parseBucketSeconds,
  placementIssues,
  setProjectionInputSchema,
  toolCallFilterSchema,
  updateCredentialInputSchema,
  updateServerInputSchema,
  type ApiKeyKind,
  type CredentialPayload,
  type ServerKind,
  type ServerRecord,
  type TransportConfig,
} from '../domain/models.js';
import {
  parseHarnessConfig,
  toPreview,
  type HarnessImportedEntry,
} from '../config/harness-import.js';
import { assertCliRuntimeConfig, cliRecordSchema, type CliRecord } from '../cli-plane/models.js';
import { validateCliCredentialBindings } from '../security/credential-materializer.js';
import type { AuthService } from '../security/auth-service.js';
import type { Store } from '../storage/store.js';
import type { CredentialResolver } from '../upstream/credential-resolver.js';
import type { UpstreamManager } from '../upstream/manager.js';
import type { UpstreamOAuthService } from '../upstream/oauth-service.js';

/** Credential references are file-local keys: they only have to resolve within one export. */
const credentialRefSchema = z.string().min(1).max(200);

const importCredentialSchema = createCredentialInputSchema.extend({
  ref: credentialRefSchema,
});

const importServerSchema = createServerInputObjectSchema
  .omit({ credentialId: true })
  .extend({ credentialRef: credentialRefSchema.nullable().default(null) })
  .superRefine((value, context) => {
    for (const issue of placementIssues(value)) {
      context.addIssue({ code: 'custom', ...issue });
    }
  });

/** A hosted CLI travels as its record without identity or timestamps. */
const importCliSchema = cliRecordSchema
  .omit({ id: true, createdAt: true, updatedAt: true, credentialId: true })
  .extend({ credentialRef: credentialRefSchema.nullable().default(null) });

/**
 * Market provenance is inventory, not state to write: the target reinstalls the
 * entry (pinned version, artifact, own credential) and records its own
 * installation. `targetSlug` replaces the export instance's `targetId`.
 */
const importInstallationSchema = z.object({
  entryId: z.string().min(1),
  entryVersion: z.string(),
  recipeRevision: z.string(),
  targetType: z.enum(['server', 'cli']),
  targetSlug: z.string().min(1),
  credentialRef: credentialRefSchema.nullable().default(null),
});

const importModeSchema = z.enum(['create', 'merge']);

const importSchema = z.object({
  version: z.literal(1),
  secretsIncluded: z.literal(true),
  mode: importModeSchema.default('create'),
  upsert: z.boolean().default(false),
  credentials: z.array(importCredentialSchema).default([]),
  servers: z.array(importServerSchema).default([]),
  clis: z.array(importCliSchema).default([]),
  installations: z.array(importInstallationSchema).default([]),
});

type ImportMode = z.infer<typeof importModeSchema>;
type ImportedServer = z.infer<typeof importServerSchema>;
type ImportedCli = z.infer<typeof importCliSchema>;
type ImportStatus = 'created' | 'reused' | 'updated' | 'skipped' | 'conflict';

interface ImportItemReport {
  slug: string;
  status: ImportStatus;
  id?: string;
  changes?: string[];
  message?: string;
}

interface ImportPlan {
  credentials: { name: string; ref: string; status: ImportStatus; id?: string; message?: string }[];
  servers: ImportItemReport[];
  clis: ImportItemReport[];
  conflicts: string[];
}

export interface ImportReport extends ImportPlan {
  mode: ImportMode;
  upsert: boolean;
  dryRun: boolean;
  installations: { entryId: string; targetType: 'server' | 'cli'; targetSlug: string }[];
  counts: Record<ImportStatus, number>;
}

export class ControlService {
  readonly #store: Store;
  readonly #upstreams: UpstreamManager;
  readonly #auth: AuthService;
  readonly #publicUrl: URL;
  readonly #onServerRemoved: (slug: string) => Promise<void>;
  readonly #onRegistryChanged: () => void;
  readonly #upstreamOAuth: UpstreamOAuthService;
  readonly #credentials: CredentialResolver;

  constructor(
    store: Store,
    upstreams: UpstreamManager,
    auth: AuthService,
    publicUrl: URL,
    onServerRemoved: (slug: string) => Promise<void>,
    onRegistryChanged: () => void,
    upstreamOAuth: UpstreamOAuthService,
    credentials: CredentialResolver,
  ) {
    this.#store = store;
    this.#upstreams = upstreams;
    this.#auth = auth;
    this.#publicUrl = publicUrl;
    this.#onServerRemoved = onServerRemoved;
    this.#onRegistryChanged = onRegistryChanged;
    this.#upstreamOAuth = upstreamOAuth;
    this.#credentials = credentials;
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

  /**
   * Launch specification for a stdio server: its transport plus the credential
   * values projected into environment variables. This is what `toolhome mcp` on a
   * client machine spawns, so it returns exactly the fields the spawn needs and
   * nothing else from the credential vault. HTTP servers have no local process and
   * are rejected.
   */
  serverRuntime(id: string): {
    serverId: string;
    slug: string;
    kind: ServerKind;
    nodeId: string | null;
    transport: TransportConfig;
    credentialEnv: Record<string, string>;
  } {
    const server = this.#store.getServer(id);
    if (!server) throw new AppError('server_not_found', 'Server not found', 404);
    if (server.transport.type !== 'stdio') {
      throw new AppError(
        'server_has_no_local_runtime',
        `Server ${server.slug} is remote and runs no local process`,
        400,
      );
    }
    const credentialEnv = server.credentialId === null ? {} : this.#credentials.resolve(server).env;
    // Audited per read. Only the variable names are recorded, never the values.
    this.#store.appendEvent({
      level: 'info',
      type: 'server.runtime_read',
      serverId: server.id,
      message: `Materialized launch environment for ${server.slug}`,
      detail: {
        kind: server.kind,
        nodeId: server.nodeId,
        credentialEnvKeys: Object.keys(credentialEnv),
      },
    });
    return {
      serverId: server.id,
      slug: server.slug,
      kind: server.kind,
      nodeId: server.nodeId,
      transport: server.transport,
      credentialEnv,
    };
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
    // A node-hosted server has no process on this host; the client that runs it
    // launches it through the runtime endpoint.
    const snapshot = this.#upstreams.hosts(server) ? await this.#upstreams.refresh(id) : null;
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

  /** Clear an OAuth client registration that still points at another instance's origin. */
  resetCredentialClientRegistration(id: string) {
    this.getCredential(id);
    return this.#upstreamOAuth.resetClientRegistration(id);
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
        node: servers.filter((server) => server.kind === 'node').length,
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
      // Readiness only covers servers this host can host. A node-hosted server
      // runs on a client machine and never reports ready here, and clients reach
      // it through the runtime endpoint, which does not depend on this state.
      ok: servers.every((server) => {
        if (!server.enabled || !isHostHosted(server.kind)) return true;
        return this.#store.getRuntimeState(server.id)?.status === 'ready';
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
    const servers = this.#store.listServers();
    const clis = this.#store.listClis();
    const serverSlugById = new Map(servers.map((server) => [server.id, server.slug]));
    const cliSlugById = new Map(clis.map((cli) => [cli.id, cli.slug]));
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
      servers: servers.map((server) => ({
        slug: server.slug,
        name: server.name,
        kind: server.kind,
        // Placement travels with the record: without it a node server fails
        // placement validation on import and aborts the whole transfer.
        nodeId: server.nodeId,
        transport: includeSecrets ? server.transport : redactTransport(server.transport),
        credentialRef: server.credentialId,
        enabled: server.enabled,
        settings: server.settings,
      })),
      clis: clis.map((cli) => ({
        slug: cli.slug,
        name: cli.name,
        command: cli.command,
        executionMode: cli.executionMode,
        entrypoint: cli.entrypoint,
        authStrategy: cli.authStrategy,
        containerVolumes: cli.containerVolumes,
        platform: cli.platform,
        allowList: cli.allowList,
        interactive: cli.interactive,
        credentialRef: cli.credentialId,
        credentialBindings: cli.credentialBindings,
        probe: cli.probe,
        enabled: cli.enabled,
        timeoutMs: cli.timeoutMs,
        maxOutputBytes: cli.maxOutputBytes,
      })),
      installations: this.#store.listInstallations().map((installation) => ({
        entryId: installation.entryId,
        entryVersion: installation.entryVersion,
        recipeRevision: installation.recipeRevision,
        targetType: installation.targetType,
        targetSlug:
          installation.targetType === 'cli'
            ? (cliSlugById.get(installation.targetId) ?? installation.entryId)
            : (serverSlugById.get(installation.targetId) ?? installation.entryId),
        credentialRef: installation.credentialId,
      })),
    };
  }

  /**
   * Applies an exported configuration.
   *
   * `create` keeps the original semantics: a slug the target already has aborts
   * the import. `merge` reuses credentials by name and skips records the target
   * already holds, updating them only when `upsert` is set — reassigning a
   * credential only when the payload actually differs, so a re-run is a no-op.
   * `dryRun` returns the same report without writing anything.
   */
  async importConfig(value: unknown, options: { dryRun?: boolean } = {}): Promise<ImportReport> {
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
    for (const item of [...input.servers, ...input.clis]) {
      if (item.credentialRef !== null && !refs.has(item.credentialRef)) {
        throw new AppError(
          'credential_ref_not_found',
          `Unknown credential ref: ${item.credentialRef}`,
          400,
        );
      }
    }

    const plan = this.#planImport(input);
    const conflictSlugs = plan.conflicts;
    if (conflictSlugs.length > 0) {
      const code = input.mode === 'merge' ? 'credential_conflict' : 'slug_conflict';
      throw new AppError(
        code,
        input.mode === 'merge'
          ? `Credential payload differs on the target: ${conflictSlugs.join(', ')}. Re-run with --upsert to replace it.`
          : `The target already has: ${conflictSlugs.join(', ')}. Re-run with --mode merge to keep them.`,
        409,
      );
    }
    if (options.dryRun === true) return this.#importReport(plan, input, true);

    const applied = await this.#applyImport(plan, input);
    return this.#importReport(applied, input, false);
  }

  /** Decide per item without touching the store. */
  #planImport(input: z.infer<typeof importSchema>): ImportPlan {
    const conflicts: string[] = [];
    const credentials: ImportPlan['credentials'] = input.credentials.map((credential) => {
      const existing = this.#store.listCredentials().find((item) => item.name === credential.name);
      if (!existing) return { name: credential.name, ref: credential.ref, status: 'created' };
      const current = this.#store.getCredentialPayload(existing.id);
      const same = JSON.stringify(current ?? null) === JSON.stringify(credential.payload);
      if (input.mode === 'create') {
        // Create mode leaves credentials alone unless the name is taken by a
        // different secret, which would silently shadow one of the two.
        return same
          ? { name: credential.name, ref: credential.ref, status: 'conflict', id: existing.id }
          : { name: credential.name, ref: credential.ref, status: 'conflict', id: existing.id };
      }
      if (same) return { name: credential.name, ref: credential.ref, status: 'reused', id: existing.id };
      if (input.upsert) return { name: credential.name, ref: credential.ref, status: 'updated', id: existing.id };
      conflicts.push(`credential "${credential.name}"`);
      return { name: credential.name, ref: credential.ref, status: 'conflict', id: existing.id };
    });

    const servers = input.servers.map((server) => {
      const existing = this.#store.getServerBySlug(server.slug);
      if (!existing) return { slug: server.slug, status: 'created' as ImportStatus };
      if (input.mode === 'create') {
        conflicts.push(`server "${server.slug}"`);
        return { slug: server.slug, status: 'conflict' as ImportStatus, id: existing.id };
      }
      const changes = this.#serverDiff(server, existing);
      if (!input.upsert || changes.length === 0) {
        return { slug: server.slug, status: 'skipped' as ImportStatus, id: existing.id, changes: [] };
      }
      return { slug: server.slug, status: 'updated' as ImportStatus, id: existing.id, changes };
    });

    const clis = input.clis.map((cli) => {
      const existing = this.#store.getCliBySlug(cli.slug);
      if (!existing) return { slug: cli.slug, status: 'created' as ImportStatus };
      if (input.mode === 'create') {
        conflicts.push(`CLI "${cli.slug}"`);
        return { slug: cli.slug, status: 'conflict' as ImportStatus, id: existing.id };
      }
      const changes = this.#cliDiff(cli, existing);
      if (!input.upsert || changes.length === 0) {
        return { slug: cli.slug, status: 'skipped' as ImportStatus, id: existing.id, changes: [] };
      }
      return { slug: cli.slug, status: 'updated' as ImportStatus, id: existing.id, changes };
    });

    return { credentials, servers, clis, conflicts };
  }

  async #applyImport(plan: ImportPlan, input: z.infer<typeof importSchema>): Promise<ImportPlan> {
    const byRef = new Map<string, string>();
    const applied: ImportPlan = { credentials: [], servers: [], clis: [], conflicts: [] };
    for (const [index, credential] of plan.credentials.entries()) {
      const source = input.credentials[index]!;
      if (credential.status === 'reused' || credential.status === 'skipped') {
        byRef.set(credential.ref, credential.id!);
        applied.credentials.push(credential);
        continue;
      }
      if (credential.status === 'updated') {
        this.#store.updateCredential(credential.id!, { payload: source.payload });
        byRef.set(credential.ref, credential.id!);
        applied.credentials.push(credential);
        continue;
      }
      const created = this.#store.createCredential({
        name: source.name,
        payload: source.payload,
      });
      byRef.set(credential.ref, created.id);
      applied.credentials.push({ ...credential, status: 'created', id: created.id });
    }

    const createdServers = new Map<number, ServerRecord>();
    const createdClis = new Map<number, CliRecord>();
    this.#store.transaction(() => {
      for (const [index, server] of input.servers.entries()) {
        if (plan.servers[index]!.status !== 'created') continue;
        const credentialId =
          server.credentialRef === null ? null : (byRef.get(server.credentialRef) ?? null);
        this.#assertCredentialAssignment(credentialId, server.kind);
        createdServers.set(
          index,
          this.#store.createServer({
            slug: server.slug,
            name: server.name,
            kind: server.kind,
            nodeId: server.nodeId,
            transport: server.transport,
            credentialId,
            enabled: server.enabled,
            settings: server.settings,
          }),
        );
      }
      for (const [index, cli] of input.clis.entries()) {
        if (plan.clis[index]!.status !== 'created') continue;
        const credentialId =
          cli.credentialRef === null ? null : (byRef.get(cli.credentialRef) ?? null);
        this.#assertCliCredential(credentialId, cli.credentialBindings);
        assertCliRuntimeConfig(cli);
        const record = this.#store.createCli({ ...cli, credentialId });
        this.#store.appendEvent({
          level: 'info',
          type: 'cli.created',
          serverId: null,
          message: `Imported CLI ${record.slug} from a configuration export`,
          detail: { plane: 'cli', slug: record.slug },
        });
        createdClis.set(index, record);
      }
    });

    applied.servers = plan.servers.map((item, index) => {
      const record = createdServers.get(index);
      return record === undefined ? item : { ...item, id: record.id };
    });
    applied.clis = plan.clis.map((item, index) => {
      const record = createdClis.get(index);
      return record === undefined ? item : { ...item, id: record.id };
    });
    for (const record of createdServers.values()) this.#refreshInBackground(record.id);

    for (const [index, server] of input.servers.entries()) {
      const item = applied.servers[index]!;
      if (item.status !== 'updated') continue;
      await this.updateServer(item.id!, {
        transport: server.transport,
        nodeId: server.nodeId,
        enabled: server.enabled,
        settings: server.settings,
        credentialId:
          server.credentialRef === null ? null : (byRef.get(server.credentialRef) ?? null),
      });
    }
    for (const [index, cli] of input.clis.entries()) {
      const item = applied.clis[index]!;
      if (item.status !== 'updated') continue;
      this.#store.updateCli(item.id!, {
        name: cli.name,
        command: cli.command,
        executionMode: cli.executionMode,
        entrypoint: cli.entrypoint,
        authStrategy: cli.authStrategy,
        containerVolumes: cli.containerVolumes,
        platform: cli.platform,
        allowList: cli.allowList,
        interactive: cli.interactive,
        credentialBindings: cli.credentialBindings,
        probe: cli.probe,
        enabled: cli.enabled,
        timeoutMs: cli.timeoutMs,
        maxOutputBytes: cli.maxOutputBytes,
        credentialId:
          cli.credentialRef === null ? null : (byRef.get(cli.credentialRef) ?? null),
      });
    }
    return applied;
  }

  #importReport(plan: ImportPlan, input: z.infer<typeof importSchema>, dryRun: boolean): ImportReport {
    const counts: Record<ImportStatus, number> = {
      created: 0,
      reused: 0,
      updated: 0,
      skipped: 0,
      conflict: 0,
    };
    for (const item of [...plan.servers, ...plan.clis]) counts[item.status] += 1;
    return {
      mode: input.mode,
      upsert: input.upsert,
      dryRun,
      credentials: plan.credentials,
      servers: plan.servers,
      clis: plan.clis,
      conflicts: plan.conflicts,
      installations: input.installations.map((installation) => ({
        entryId: installation.entryId,
        targetType: installation.targetType,
        targetSlug: installation.targetSlug,
      })),
      counts,
    };
  }

  /** Field-level diff for a server the target already has — names only, never values. */
  #serverDiff(server: ImportedServer, existing: ServerRecord): string[] {
    const changes: string[] = [];
    const next = server.transport;
    const current = existing.transport;
    if (server.name !== existing.name) changes.push('name');
    if (server.kind !== existing.kind) changes.push('kind');
    if (server.nodeId !== existing.nodeId) changes.push('nodeId');
    if (server.enabled !== existing.enabled) changes.push('enabled');
    if (next.type === 'streamable-http' && current.type === 'streamable-http') {
      if (current.url !== next.url) changes.push('url');
      if (JSON.stringify(current.headers) !== JSON.stringify(next.headers)) changes.push('headers');
    } else if (next.type === 'stdio' && current.type === 'stdio') {
      if (current.command !== next.command) changes.push('command');
      if (JSON.stringify(current.args) !== JSON.stringify(next.args)) changes.push('args');
      if (JSON.stringify(current.env ?? {}) !== JSON.stringify(next.env ?? {})) changes.push('env');
    } else {
      changes.push('transport');
    }
    if (JSON.stringify(server.settings) !== JSON.stringify(existing.settings)) {
      changes.push('settings');
    }
    return changes;
  }

  /** Field-level diff for a hosted CLI the target already has. */
  #cliDiff(cli: ImportedCli, existing: CliRecord): string[] {
    const changes: string[] = [];
    if (cli.name !== existing.name) changes.push('name');
    if (cli.command !== existing.command) changes.push('command');
    if (cli.executionMode !== existing.executionMode) changes.push('executionMode');
    if (cli.entrypoint !== existing.entrypoint) changes.push('entrypoint');
    if (cli.authStrategy !== existing.authStrategy) changes.push('authStrategy');
    if (JSON.stringify(cli.containerVolumes) !== JSON.stringify(existing.containerVolumes)) {
      changes.push('containerVolumes');
    }
    if (JSON.stringify(cli.allowList) !== JSON.stringify(existing.allowList)) changes.push('allowList');
    if (JSON.stringify(cli.credentialBindings) !== JSON.stringify(existing.credentialBindings)) {
      changes.push('credentialBindings');
    }
    if (JSON.stringify(cli.probe) !== JSON.stringify(existing.probe)) changes.push('probe');
    if (cli.enabled !== existing.enabled) changes.push('enabled');
    if (cli.timeoutMs !== existing.timeoutMs) changes.push('timeoutMs');
    if (cli.maxOutputBytes !== existing.maxOutputBytes) changes.push('maxOutputBytes');
    return changes;
  }

  #assertCliCredential(
    credentialId: string | null,
    bindings: Record<string, string>,
  ): void {
    if (credentialId === null) return;
    const payload = this.#store.getCredentialPayload(credentialId);
    if (payload === null) {
      throw new AppError('credential_not_found', 'Credential not found', 400);
    }
    validateCliCredentialBindings(payload, bindings);
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
    serverKind: ServerKind,
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

  #assertCredentialPayload(payload: CredentialPayload, serverKind: ServerKind): void {
    if (serverKind !== 'remote' && payload.type !== 'env') {
      throw new AppError(
        'credential_kind_mismatch',
        'Stdio servers only accept environment credentials',
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
    if (!server || !this.#upstreams.hosts(server)) return;
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
