import {
  ImplementationSchema,
  ListPromptsResultSchema,
  ListResourceTemplatesResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  PromptSchema,
  ResourceSchema,
  ResourceTemplateSchema,
  ServerCapabilitiesSchema,
  ToolSchema,
} from '@modelcontextprotocol/core';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import {
  assertCliRuntimeConfig,
  cliRecordSchema,
  createCliInputSchema,
  updateCliInputSchema,
  type CliRecord,
  type CreateCliInput,
  type UpdateCliInput,
} from '../cli-plane/models.js';
import {
  apiKeyRecordSchema,
  createServerInputSchema,
  credentialPayloadSchema,
  credentialRecordSchema,
  installJobRecordSchema,
  marketInstallationSchema,
  runtimeStateSchema,
  secureActionRecordSchema,
  serverProjectionSchema,
  serverRecordSchema,
  toolCallSchema,
  toolProjectionSchema,
  updateServerInputSchema,
  type ApiKeyKind,
  type ApiKeyRecord,
  type CapabilitySnapshot,
  type CreateCredentialInput,
  type CreateServerInput,
  type CredentialPayload,
  type CredentialRecord,
  type EventRecord,
  type InstallJobRecord,
  type MarketInstallation,
  type RuntimeState,
  type SecureActionRecord,
  type ServerProjection,
  type ServerRecord,
  type ToolCallDraft,
  type ToolCallFilter,
  type ToolCallRecord,
  type ToolCallSeriesBucket,
  type ToolCallSeriesQuery,
  type ToolCallStats,
  type ToolCallStatus,
  type ToolProjection,
  type UpdateCredentialInput,
  type UpdateServerInput,
  type Visibility,
} from '../domain/models.js';
import type { SecretBox } from '../security/secret-box.js';
import type { CreateKeyInput, ProjectionIndex, Store, StoredApiKey } from './store.js';

const serverRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  kind: z.string(),
  transport_json: z.string(),
  credential_id: z.string().nullable(),
  enabled: z.number(),
  settings_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const cliRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  command: z.string(),
  execution_mode: z.string(),
  entrypoint: z.string().nullable(),
  auth_strategy: z.string().nullable(),
  container_volumes_json: z.string().nullable(),
  platform: z.string().nullable(),
  allow_list_json: z.string(),
  credential_bindings_json: z.string(),
  interactive: z.number(),
  credential_id: z.string().nullable(),
  probe_json: z.string().nullable(),
  enabled: z.number(),
  timeout_ms: z.number(),
  max_output_bytes: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

const credentialRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  encrypted_payload: z.string(),
  status: z.string(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const apiKeyRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  prefix: z.string(),
  digest: z.string(),
  scope: z.string().nullable(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

const snapshotRowSchema = z.object({
  server_id: z.string(),
  version: z.number(),
  protocol_version: z.string(),
  protocol_era: z.string(),
  server_info_json: z.string().nullable(),
  capabilities_json: z.string(),
  instructions: z.string().nullable(),
  tools_json: z.string(),
  resources_json: z.string(),
  resource_templates_json: z.string(),
  prompts_json: z.string(),
  tools_result_json: z.string(),
  resources_result_json: z.string(),
  resource_templates_result_json: z.string(),
  prompts_result_json: z.string(),
  fingerprint: z.string(),
  refreshed_at: z.string(),
});

const runtimeRowSchema = z.object({
  server_id: z.string(),
  status: z.string(),
  protocol_version: z.string().nullable(),
  protocol_era: z.string().nullable(),
  process_id: z.number().nullable(),
  restart_count: z.number(),
  last_success_at: z.string().nullable(),
  last_error: z.string().nullable(),
  updated_at: z.string(),
});

const eventRowSchema = z.object({
  id: z.string(),
  level: z.string(),
  type: z.string(),
  server_id: z.string().nullable(),
  message: z.string(),
  detail_json: z.string(),
  created_at: z.string(),
});

const serverProjectionRowSchema = z.object({
  server_id: z.string(),
  default_visibility: z.string(),
  updated_at: z.string(),
});

const toolProjectionRowSchema = z.object({
  server_id: z.string(),
  upstream_tool_name: z.string(),
  visibility: z.string(),
  updated_at: z.string(),
});

const toolCallRowSchema = z.object({
  id: z.string(),
  endpoint_type: z.string(),
  principal_kind: z.string(),
  principal_id: z.string(),
  server_id: z.string().nullable(),
  exposed_tool_name: z.string(),
  upstream_tool_name: z.string(),
  status: z.string(),
  error_type: z.string().nullable(),
  started_at: z.string(),
  completed_at: z.string(),
  duration_ms: z.number(),
});

const installJobRowSchema = z.object({
  id: z.string(),
  entry_id: z.string(),
  requested_version: z.string().nullable(),
  idempotency_key: z.string(),
  status: z.string(),
  step: z.string(),
  bounded_output: z.string(),
  result_reference: z.string().nullable(),
  action_id: z.string().nullable(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const installationRowSchema = z.object({
  id: z.string(),
  source: z.string(),
  entry_id: z.string(),
  entry_version: z.string(),
  recipe_revision: z.string(),
  target_type: z.string(),
  target_id: z.string(),
  credential_id: z.string().nullable(),
  installed_at: z.string(),
});

const secureActionRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  target: z.string(),
  principal_id: z.string(),
  status: z.string(),
  values_json: z.string(),
  expires_at: z.string(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function now(): string {
  return new Date().toISOString();
}

// The 0.4.0 rename moved the default database file from `mcp-home.sqlite` to
// `toolhome.sqlite`. Move a pre-existing legacy database (and its WAL sidecars)
// so upgrades keep their data without any manual step.
function migrateLegacyDatabasePath(databasePath: string): void {
  if (existsSync(databasePath)) return;
  const legacyBase = basename(databasePath).replace(/^toolhome\.sqlite$/, 'mcp-home.sqlite');
  if (legacyBase === basename(databasePath)) return;
  const legacyPath = join(dirname(databasePath), legacyBase);
  if (!existsSync(legacyPath)) return;
  renameSync(legacyPath, databasePath);
  for (const suffix of ['-wal', '-shm']) {
    const legacySidecar = join(dirname(databasePath), `${legacyBase}${suffix}`);
    if (existsSync(legacySidecar)) {
      renameSync(legacySidecar, join(dirname(databasePath), `${basename(databasePath)}${suffix}`));
    }
  }
}

const masterKeyCheckSchema = z.object({
  // Accept the pre-0.4.0 'mcp-home-master-key-check' marker written into
  // existing databases so upgrades keep booting with the same master key.
  kind: z.union([z.literal('toolhome-master-key-check'), z.literal('mcp-home-master-key-check')]),
  version: z.literal(1),
});

function credentialStatus(
  payload: CredentialPayload,
  timestamp: string,
): CredentialRecord['status'] {
  if (payload.type !== 'oauth') return 'ready';
  if (!payload.accessToken) return 'pending';
  if (payload.expiresAt && payload.expiresAt <= timestamp) return 'expired';
  return 'ready';
}

function normalizeCredentialPayload(
  payload: CredentialPayload,
  timestamp: string,
): CredentialPayload {
  if (
    payload.type !== 'oauth' ||
    payload.expiresAt !== undefined ||
    payload.expiresIn === undefined
  ) {
    return payload;
  }
  return {
    ...payload,
    expiresAt: new Date(Date.parse(timestamp) + payload.expiresIn * 1_000).toISOString(),
  };
}

export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  readonly #secrets: SecretBox;

  constructor(databasePath: string, secrets: SecretBox) {
    this.#secrets = secrets;
    migrateLegacyDatabasePath(databasePath);
    this.#db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.#db.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;',
    );
    this.#migrate();
    this.#verifyCredentialEncryption();
    this.#verifyMasterKey();
  }

  close(): void {
    this.#db.close();
  }

  transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('remote', 'home')),
        transport_json TEXT NOT NULL,
        credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
        enabled INTEGER NOT NULL,
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('control', 'access')),
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        digest TEXT NOT NULL UNIQUE,
        scope TEXT DEFAULT 'admin' CHECK (scope IN ('admin', 'agent')),
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS capability_snapshots (
        server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        protocol_version TEXT NOT NULL,
        protocol_era TEXT NOT NULL,
        server_info_json TEXT,
        capabilities_json TEXT NOT NULL,
        instructions TEXT,
        tools_json TEXT NOT NULL,
        resources_json TEXT NOT NULL,
        resource_templates_json TEXT NOT NULL,
        prompts_json TEXT NOT NULL,
        tools_result_json TEXT NOT NULL,
        resources_result_json TEXT NOT NULL,
        resource_templates_result_json TEXT NOT NULL,
        prompts_result_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        refreshed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_states (
        server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        protocol_version TEXT,
        protocol_era TEXT,
        process_id INTEGER,
        restart_count INTEGER NOT NULL,
        last_success_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
        message TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata (
        metadata_key TEXT PRIMARY KEY,
        metadata_value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_server_id ON events(server_id, created_at DESC);

      CREATE TRIGGER IF NOT EXISTS trim_old_events
      AFTER INSERT ON events
      WHEN (SELECT COUNT(*) FROM events) > 10100
      BEGIN
        DELETE FROM events
        WHERE id IN (
          SELECT id FROM events ORDER BY created_at DESC LIMIT -1 OFFSET 10000
        );
      END;

      CREATE TABLE IF NOT EXISTS server_projections (
        server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        default_visibility TEXT NOT NULL CHECK (default_visibility IN ('visible', 'hidden')),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_projections (
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        upstream_tool_name TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('inherit', 'visible', 'hidden')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (server_id, upstream_tool_name)
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        endpoint_type TEXT NOT NULL CHECK (endpoint_type IN ('aggregate', 'individual', 'management', 'cli')),
        principal_kind TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
        exposed_tool_name TEXT NOT NULL,
        upstream_tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        error_type TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_started ON tool_calls(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_server ON tool_calls(server_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_principal ON tool_calls(principal_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(upstream_tool_name, started_at DESC);

      CREATE TRIGGER IF NOT EXISTS trim_tool_calls
      AFTER INSERT ON tool_calls
      WHEN (SELECT COUNT(*) FROM tool_calls) > 200000
      BEGIN
        DELETE FROM tool_calls
        WHERE id IN (
          SELECT id FROM tool_calls ORDER BY started_at DESC LIMIT -1 OFFSET 200000
        );
      END;

      CREATE TABLE IF NOT EXISTS market_installations (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('curated', 'registry')),
        entry_id TEXT NOT NULL,
        entry_version TEXT NOT NULL,
        recipe_revision TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK (target_type IN ('server', 'cli')),
        target_id TEXT NOT NULL,
        credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
        installed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_installations_entry ON market_installations(entry_id);

      CREATE TABLE IF NOT EXISTS install_jobs (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        requested_version TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('awaiting_secret', 'installing', 'updating', 'completed', 'failed', 'interrupted')),
        step TEXT NOT NULL,
        bounded_output TEXT NOT NULL,
        result_reference TEXT,
        action_id TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_install_jobs_status ON install_jobs(status, updated_at);

      CREATE TABLE IF NOT EXISTS secure_actions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired')),
        values_json TEXT NOT NULL DEFAULT '{}',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_secure_actions_principal ON secure_actions(principal_id);

      CREATE TABLE IF NOT EXISTS clis (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('host', 'docker')),
        entrypoint TEXT,
        auth_strategy TEXT NOT NULL DEFAULT 'none',
        container_volumes_json TEXT NOT NULL DEFAULT '[]',
        platform TEXT,
        allow_list_json TEXT NOT NULL,
        credential_bindings_json TEXT NOT NULL DEFAULT '{}',
        interactive INTEGER NOT NULL,
        credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
        probe_json TEXT,
        enabled INTEGER NOT NULL,
        timeout_ms INTEGER NOT NULL,
        max_output_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_clis_slug ON clis(slug);
    `);
    // Guarded migration for existing databases created before api_keys.scope existed.
    const apiKeyColumns = this.#db.prepare('PRAGMA table_info(api_keys)').all() as {
      name: string;
    }[];
    if (!apiKeyColumns.some((column) => column.name === 'scope')) {
      this.#db.exec(
        "ALTER TABLE api_keys ADD COLUMN scope TEXT DEFAULT 'admin' CHECK (scope IN ('admin', 'agent'))",
      );
    }
    // Guarded migration for existing CLI records created before Docker entrypoints and
    // platform credential bindings were stored.
    const cliColumns = this.#db.prepare('PRAGMA table_info(clis)').all() as { name: string }[];
    if (!cliColumns.some((column) => column.name === 'entrypoint')) {
      this.#db.exec('ALTER TABLE clis ADD COLUMN entrypoint TEXT');
    }
    if (!cliColumns.some((column) => column.name === 'auth_strategy')) {
      this.#db.exec("ALTER TABLE clis ADD COLUMN auth_strategy TEXT NOT NULL DEFAULT 'none'");
    }
    if (!cliColumns.some((column) => column.name === 'container_volumes_json')) {
      this.#db.exec(
        "ALTER TABLE clis ADD COLUMN container_volumes_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
    if (!cliColumns.some((column) => column.name === 'platform')) {
      this.#db.exec('ALTER TABLE clis ADD COLUMN platform TEXT');
    }
    if (!cliColumns.some((column) => column.name === 'credential_bindings_json')) {
      this.#db.exec(
        "ALTER TABLE clis ADD COLUMN credential_bindings_json TEXT NOT NULL DEFAULT '{}'",
      );
    }
    // Guarded migration: install_jobs created before the 'updating' status have a
    // CHECK constraint without it. SQLite cannot alter CHECK constraints, so
    // rebuild the table (rows are preserved).
    const installJobsSql = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'install_jobs'")
      .get() as { sql: string } | undefined;
    if (installJobsSql !== undefined && !installJobsSql.sql.includes("'updating'")) {
      this.#db.exec(`
        BEGIN;
        CREATE TABLE install_jobs_next (
          id TEXT PRIMARY KEY,
          entry_id TEXT NOT NULL,
          requested_version TEXT,
          idempotency_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (status IN ('awaiting_secret', 'installing', 'updating', 'completed', 'failed', 'interrupted')),
          step TEXT NOT NULL,
          bounded_output TEXT NOT NULL,
          result_reference TEXT,
          action_id TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO install_jobs_next
          SELECT id, entry_id, requested_version, idempotency_key, status, step,
                 bounded_output, result_reference, action_id, error_code, created_at, updated_at
          FROM install_jobs;
        DROP TABLE install_jobs;
        ALTER TABLE install_jobs_next RENAME TO install_jobs;
        CREATE INDEX IF NOT EXISTS idx_install_jobs_status ON install_jobs(status, updated_at);
        COMMIT;
      `);
    }
    // Guarded migration: tool_calls created before the 'cli' endpoint type have
    // a CHECK constraint without it. SQLite cannot alter CHECK constraints, so
    // rebuild the table (rows are preserved).
    const toolCallsSql = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tool_calls'")
      .get() as { sql: string } | undefined;
    if (toolCallsSql !== undefined && !toolCallsSql.sql.includes("'cli'")) {
      this.#db.exec(`
        BEGIN;
        CREATE TABLE tool_calls_next (
          id TEXT PRIMARY KEY,
          endpoint_type TEXT NOT NULL CHECK (endpoint_type IN ('aggregate', 'individual', 'management', 'cli')),
          principal_kind TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
          exposed_tool_name TEXT NOT NULL,
          upstream_tool_name TEXT NOT NULL,
          status TEXT NOT NULL,
          error_type TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL
        );
        INSERT INTO tool_calls_next
          SELECT id, endpoint_type, principal_kind, principal_id, server_id,
                 exposed_tool_name, upstream_tool_name, status, error_type,
                 started_at, completed_at, duration_ms
          FROM tool_calls;
        DROP TABLE tool_calls;
        ALTER TABLE tool_calls_next RENAME TO tool_calls;
        CREATE INDEX IF NOT EXISTS idx_tool_calls_started ON tool_calls(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_server ON tool_calls(server_id, started_at DESC);
        COMMIT;
      `);
    }
    // Guarded migration: market installations historically pointed to a server
    // through `server_id`. CLI installs need the same durable record without a
    // foreign key to the servers table, so migrate to a polymorphic target.
    const installationsSql = this.#db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'market_installations'",
      )
      .get() as { sql: string } | undefined;
    if (installationsSql !== undefined && !installationsSql.sql.includes('target_type')) {
      this.#db.exec(`
        BEGIN;
        CREATE TABLE market_installations_next (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source IN ('curated', 'registry')),
          entry_id TEXT NOT NULL,
          entry_version TEXT NOT NULL,
          recipe_revision TEXT NOT NULL,
          target_type TEXT NOT NULL CHECK (target_type IN ('server', 'cli')),
          target_id TEXT NOT NULL,
          credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
          installed_at TEXT NOT NULL
        );
        INSERT INTO market_installations_next
          SELECT id, source, entry_id, entry_version, recipe_revision,
                 'server', server_id, credential_id, installed_at
          FROM market_installations;
        DROP TABLE market_installations;
        ALTER TABLE market_installations_next RENAME TO market_installations;
        CREATE INDEX IF NOT EXISTS idx_installations_entry ON market_installations(entry_id);
        COMMIT;
      `);
    }
  }

  #verifyCredentialEncryption(): void {
    const rows = this.#db.prepare('SELECT encrypted_payload FROM credentials').all();
    try {
      for (const row of rows) {
        const payload = z.object({ encrypted_payload: z.string() }).parse(row);
        credentialPayloadSchema.parse(this.#secrets.decrypt(payload.encrypted_payload));
      }
    } catch {
      this.#db.close();
      throw new AppError(
        'credential_decryption_failed',
        'Stored credentials cannot be decrypted with MCP_HOME_MASTER_KEY',
        500,
      );
    }
  }

  #verifyMasterKey(): void {
    const row = this.#db
      .prepare("SELECT metadata_value FROM metadata WHERE metadata_key = 'master-key-check'")
      .get();
    if (row === undefined) {
      this.#db
        .prepare('INSERT INTO metadata (metadata_key, metadata_value) VALUES (?, ?)')
        .run(
          'master-key-check',
          this.#secrets.encrypt({ kind: 'toolhome-master-key-check', version: 1 }),
        );
      return;
    }
    try {
      const parsed = z.object({ metadata_value: z.string() }).parse(row);
      masterKeyCheckSchema.parse(this.#secrets.decrypt(parsed.metadata_value));
    } catch {
      this.#db.close();
      throw new AppError(
        'master_key_mismatch',
        'Stored data cannot be decrypted with MCP_HOME_MASTER_KEY',
        500,
      );
    }
  }

  listServers(): ServerRecord[] {
    const rows = this.#db.prepare('SELECT * FROM servers ORDER BY slug').all();
    return rows.map((row) => this.#parseServer(row));
  }

  getServer(id: string): ServerRecord | null {
    const row = this.#db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    return row === undefined ? null : this.#parseServer(row);
  }

  getServerBySlug(slug: string): ServerRecord | null {
    const row = this.#db.prepare('SELECT * FROM servers WHERE slug = ?').get(slug);
    return row === undefined ? null : this.#parseServer(row);
  }

  createServer(input: CreateServerInput): ServerRecord {
    const valid = createServerInputSchema.parse(input);
    if (this.getServerBySlug(valid.slug))
      throw new AppError('slug_conflict', 'Server slug exists', 409);
    const timestamp = now();
    const record = serverRecordSchema.parse({
      id: randomUUID(),
      ...valid,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#db
      .prepare(
        `INSERT INTO servers
        (id, slug, name, kind, transport_json, credential_id, enabled, settings_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.slug,
        record.name,
        record.kind,
        JSON.stringify(record.transport),
        record.credentialId,
        record.enabled ? 1 : 0,
        JSON.stringify(record.settings),
        record.createdAt,
        record.updatedAt,
      );
    this.saveRuntimeState({
      serverId: record.id,
      status: record.enabled ? 'unknown' : 'disabled',
      protocolVersion: null,
      protocolEra: null,
      processId: null,
      restartCount: 0,
      lastSuccessAt: null,
      lastError: null,
      updatedAt: timestamp,
    });
    return record;
  }

  updateServer(id: string, input: UpdateServerInput): ServerRecord {
    const current = this.getServer(id);
    if (!current) throw new AppError('server_not_found', 'Server not found', 404);
    const patch = updateServerInputSchema.parse(input);
    const record = serverRecordSchema.parse({
      ...current,
      ...patch,
      settings: { ...current.settings, ...patch.settings },
      updatedAt: now(),
    });
    const expectedTransport = record.kind === 'remote' ? 'streamable-http' : 'stdio';
    if (record.transport.type !== expectedTransport) {
      throw new AppError('invalid_transport', 'Transport does not match server kind');
    }
    this.#db
      .prepare(
        `UPDATE servers SET name = ?, transport_json = ?, credential_id = ?, enabled = ?,
         settings_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        record.name,
        JSON.stringify(record.transport),
        record.credentialId,
        record.enabled ? 1 : 0,
        JSON.stringify(record.settings),
        record.updatedAt,
        id,
      );
    if (!record.enabled) {
      const state = this.getRuntimeState(id);
      this.saveRuntimeState({
        serverId: id,
        status: 'disabled',
        protocolVersion: state?.protocolVersion ?? null,
        protocolEra: state?.protocolEra ?? null,
        processId: null,
        restartCount: state?.restartCount ?? 0,
        lastSuccessAt: state?.lastSuccessAt ?? null,
        lastError: null,
        updatedAt: now(),
      });
    }
    return record;
  }

  deleteServer(id: string): void {
    const result = this.#db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    if (result.changes === 0) throw new AppError('server_not_found', 'Server not found', 404);
  }

  listClis(): CliRecord[] {
    return this.#db
      .prepare('SELECT * FROM clis ORDER BY slug')
      .all()
      .map((row) => this.#parseCli(row));
  }

  getCli(id: string): CliRecord | null {
    const row = this.#db.prepare('SELECT * FROM clis WHERE id = ?').get(id);
    return row === undefined ? null : this.#parseCli(row);
  }

  getCliBySlug(slug: string): CliRecord | null {
    const row = this.#db.prepare('SELECT * FROM clis WHERE slug = ?').get(slug);
    return row === undefined ? null : this.#parseCli(row);
  }

  createCli(input: CreateCliInput): CliRecord {
    const valid = createCliInputSchema.parse(input);
    if (this.getCliBySlug(valid.slug)) {
      throw new AppError('cli_slug_conflict', 'CLI slug exists', 409);
    }
    const timestamp = now();
    assertCliRuntimeConfig(valid);
    const record = cliRecordSchema.parse({
      id: randomUUID(),
      ...valid,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#db
      .prepare(
        `INSERT INTO clis
        (id, slug, name, command, execution_mode, entrypoint, auth_strategy, container_volumes_json,
         platform, allow_list_json, credential_bindings_json, interactive, credential_id, probe_json,
         enabled, timeout_ms, max_output_bytes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.slug,
        record.name,
        record.command,
        record.executionMode,
        record.entrypoint,
        record.authStrategy,
        JSON.stringify(record.containerVolumes),
        record.platform,
        JSON.stringify(record.allowList),
        JSON.stringify(record.credentialBindings),
        record.interactive ? 1 : 0,
        record.credentialId,
        record.probe === null ? null : JSON.stringify(record.probe),
        record.enabled ? 1 : 0,
        record.timeoutMs,
        record.maxOutputBytes,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  updateCli(id: string, input: UpdateCliInput): CliRecord {
    const current = this.getCli(id);
    if (!current) throw new AppError('cli_not_found', 'CLI not found', 404);
    const patch = updateCliInputSchema.parse(input);
    const record = cliRecordSchema.parse({
      ...current,
      ...patch,
      updatedAt: now(),
    });
    assertCliRuntimeConfig(record);
    this.#db
      .prepare(
        `UPDATE clis SET name = ?, command = ?, execution_mode = ?, entrypoint = ?, auth_strategy = ?,
         container_volumes_json = ?, platform = ?, allow_list_json = ?, credential_bindings_json = ?,
         interactive = ?, credential_id = ?, probe_json = ?, enabled = ?, timeout_ms = ?,
         max_output_bytes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        record.name,
        record.command,
        record.executionMode,
        record.entrypoint,
        record.authStrategy,
        JSON.stringify(record.containerVolumes),
        record.platform,
        JSON.stringify(record.allowList),
        JSON.stringify(record.credentialBindings),
        record.interactive ? 1 : 0,
        record.credentialId,
        record.probe === null ? null : JSON.stringify(record.probe),
        record.enabled ? 1 : 0,
        record.timeoutMs,
        record.maxOutputBytes,
        record.updatedAt,
        id,
      );
    return record;
  }

  deleteCli(id: string): void {
    const result = this.#db.prepare('DELETE FROM clis WHERE id = ?').run(id);
    if (result.changes === 0) throw new AppError('cli_not_found', 'CLI not found', 404);
  }

  listCredentials(): CredentialRecord[] {
    return this.#db
      .prepare('SELECT * FROM credentials ORDER BY name')
      .all()
      .map((row) => this.#parseCredential(row));
  }

  getCredential(id: string): CredentialRecord | null {
    const row = this.#db.prepare('SELECT * FROM credentials WHERE id = ?').get(id);
    return row === undefined ? null : this.#parseCredential(row);
  }

  getCredentialPayload(id: string): CredentialPayload | null {
    const row = this.#db.prepare('SELECT encrypted_payload FROM credentials WHERE id = ?').get(id);
    if (row === undefined) return null;
    const parsed = z.object({ encrypted_payload: z.string() }).parse(row);
    return credentialPayloadSchema.parse(this.#secrets.decrypt(parsed.encrypted_payload));
  }

  createCredential(input: CreateCredentialInput): CredentialRecord {
    const timestamp = now();
    const payload = normalizeCredentialPayload(input.payload, timestamp);
    const expiresAt = payload.type === 'oauth' ? (payload.expiresAt ?? null) : null;
    const record = credentialRecordSchema.parse({
      id: randomUUID(),
      name: input.name,
      type: payload.type,
      status: credentialStatus(payload, timestamp),
      expiresAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#db
      .prepare(
        `INSERT INTO credentials
        (id, name, type, encrypted_payload, status, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.type,
        this.#secrets.encrypt(payload),
        record.status,
        record.expiresAt,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  updateCredential(id: string, input: UpdateCredentialInput): CredentialRecord {
    const current = this.getCredential(id);
    if (!current) throw new AppError('credential_not_found', 'Credential not found', 404);
    const currentPayload = input.payload ?? this.getCredentialPayload(id);
    if (!currentPayload) throw new AppError('credential_not_found', 'Credential not found', 404);
    const timestamp = now();
    const payload = normalizeCredentialPayload(currentPayload, timestamp);
    const expiresAt = payload.type === 'oauth' ? (payload.expiresAt ?? null) : null;
    const record = credentialRecordSchema.parse({
      ...current,
      name: input.name ?? current.name,
      type: payload.type,
      status: credentialStatus(payload, timestamp),
      expiresAt,
      updatedAt: timestamp,
    });
    this.#db
      .prepare(
        `UPDATE credentials SET name = ?, type = ?, encrypted_payload = ?, status = ?,
         expires_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        record.name,
        record.type,
        this.#secrets.encrypt(payload),
        record.status,
        record.expiresAt,
        record.updatedAt,
        id,
      );
    return record;
  }

  deleteCredential(id: string): void {
    const result = this.#db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
    if (result.changes === 0)
      throw new AppError('credential_not_found', 'Credential not found', 404);
  }

  listApiKeys(kind: ApiKeyKind): ApiKeyRecord[] {
    return this.#db
      .prepare(
        'SELECT * FROM api_keys WHERE kind = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      )
      .all(kind)
      .map((row) => this.#parseApiKey(row));
  }

  createApiKey(input: CreateKeyInput): ApiKeyRecord {
    const timestamp = now();
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO api_keys
        (id, kind, name, prefix, digest, scope, created_at, last_used_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(id, input.kind, input.name, input.prefix, input.digest, input.scope ?? null, timestamp);
    const key = this.getApiKeyByDigest(input.kind, input.digest);
    if (!key) throw new Error('API key insert failed');
    const { digest: _digest, ...record } = key;
    return record;
  }

  getApiKey(id: string, kind: ApiKeyKind): ApiKeyRecord | null {
    const row = this.#db.prepare('SELECT * FROM api_keys WHERE id = ? AND kind = ?').get(id, kind);
    return row === undefined ? null : this.#parseApiKey(row);
  }

  getApiKeyByDigest(kind: ApiKeyKind, digest: string): StoredApiKey | null {
    const row = this.#db
      .prepare('SELECT * FROM api_keys WHERE kind = ? AND digest = ? AND revoked_at IS NULL')
      .get(kind, digest);
    if (row === undefined) return null;
    const parsed = apiKeyRowSchema.parse(row);
    return {
      ...this.#parseApiKey(parsed),
      digest: parsed.digest,
    };
  }

  revokeApiKey(id: string, kind: ApiKeyKind): void {
    const result = this.#db
      .prepare(
        'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND kind = ? AND revoked_at IS NULL',
      )
      .run(now(), id, kind);
    if (result.changes === 0) throw new AppError('api_key_not_found', 'API key not found', 404);
  }

  touchApiKey(id: string): void {
    this.#db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), id);
  }

  getSnapshot(serverId: string): CapabilitySnapshot | null {
    const row = this.#db
      .prepare('SELECT * FROM capability_snapshots WHERE server_id = ?')
      .get(serverId);
    return row === undefined ? null : this.#parseSnapshot(row);
  }

  saveSnapshot(snapshot: CapabilitySnapshot): CapabilitySnapshot {
    this.#db
      .prepare(
        `INSERT INTO capability_snapshots
        (server_id, version, protocol_version, protocol_era, server_info_json, capabilities_json,
         instructions, tools_json, resources_json, resource_templates_json, prompts_json,
         tools_result_json, resources_result_json, resource_templates_result_json,
         prompts_result_json, fingerprint, refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          version = excluded.version,
          protocol_version = excluded.protocol_version,
          protocol_era = excluded.protocol_era,
          server_info_json = excluded.server_info_json,
          capabilities_json = excluded.capabilities_json,
          instructions = excluded.instructions,
          tools_json = excluded.tools_json,
          resources_json = excluded.resources_json,
          resource_templates_json = excluded.resource_templates_json,
          prompts_json = excluded.prompts_json,
          tools_result_json = excluded.tools_result_json,
          resources_result_json = excluded.resources_result_json,
          resource_templates_result_json = excluded.resource_templates_result_json,
          prompts_result_json = excluded.prompts_result_json,
          fingerprint = excluded.fingerprint,
          refreshed_at = excluded.refreshed_at`,
      )
      .run(
        snapshot.serverId,
        snapshot.version,
        snapshot.protocolVersion,
        snapshot.protocolEra,
        snapshot.serverInfo === null ? null : JSON.stringify(snapshot.serverInfo),
        JSON.stringify(snapshot.capabilities),
        snapshot.instructions,
        JSON.stringify(snapshot.tools),
        JSON.stringify(snapshot.resources),
        JSON.stringify(snapshot.resourceTemplates),
        JSON.stringify(snapshot.prompts),
        JSON.stringify(snapshot.listResults.tools),
        JSON.stringify(snapshot.listResults.resources),
        JSON.stringify(snapshot.listResults.resourceTemplates),
        JSON.stringify(snapshot.listResults.prompts),
        snapshot.fingerprint,
        snapshot.refreshedAt,
      );
    const saved = this.getSnapshot(snapshot.serverId);
    if (!saved) throw new Error('Snapshot insert failed');
    return saved;
  }

  deleteSnapshot(serverId: string): void {
    this.#db.prepare('DELETE FROM capability_snapshots WHERE server_id = ?').run(serverId);
  }

  getRuntimeState(serverId: string): RuntimeState | null {
    const row = this.#db.prepare('SELECT * FROM runtime_states WHERE server_id = ?').get(serverId);
    return row === undefined ? null : this.#parseRuntimeState(row);
  }

  saveRuntimeState(state: RuntimeState): RuntimeState {
    const valid = runtimeStateSchema.parse(state);
    this.#db
      .prepare(
        `INSERT INTO runtime_states
        (server_id, status, protocol_version, protocol_era, process_id, restart_count,
         last_success_at, last_error, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          status = excluded.status,
          protocol_version = excluded.protocol_version,
          protocol_era = excluded.protocol_era,
          process_id = excluded.process_id,
          restart_count = excluded.restart_count,
          last_success_at = excluded.last_success_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at`,
      )
      .run(
        valid.serverId,
        valid.status,
        valid.protocolVersion,
        valid.protocolEra,
        valid.processId,
        valid.restartCount,
        valid.lastSuccessAt,
        valid.lastError,
        valid.updatedAt,
      );
    return valid;
  }

  appendEvent(event: Omit<EventRecord, 'id' | 'createdAt'>): EventRecord {
    const record: EventRecord = { ...event, id: randomUUID(), createdAt: now() };
    this.#db
      .prepare(
        `INSERT INTO events (id, level, type, server_id, message, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.level,
        record.type,
        record.serverId,
        record.message,
        JSON.stringify(record.detail),
        record.createdAt,
      );
    return record;
  }

  listEvents(
    options: {
      serverId?: string;
      limit?: number;
      level?: EventRecord['level'];
      plane?: 'mcp' | 'cli';
    } = {},
  ): EventRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000));
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (options.serverId !== undefined) {
      conditions.push('server_id = ?');
      params.push(options.serverId);
    }
    if (options.level !== undefined) {
      conditions.push('level = ?');
      params.push(options.level);
    }
    if (options.plane === 'cli') conditions.push("type LIKE 'cli.%'");
    if (options.plane === 'mcp') conditions.push("type NOT LIKE 'cli.%'");
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = this.#db
      .prepare(`SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit);
    return rows.map((row) => this.#parseEvent(row));
  }

  // ── Tool visibility projection ──────────────────────────────────────────

  getServerProjection(serverId: string): ServerProjection | null {
    const row = this.#db
      .prepare('SELECT * FROM server_projections WHERE server_id = ?')
      .get(serverId);
    return row === undefined ? null : this.#parseServerProjection(row);
  }

  setServerProjection(serverId: string, defaultVisibility: Visibility): ServerProjection {
    const timestamp = now();
    this.#db
      .prepare(
        `INSERT INTO server_projections (server_id, default_visibility, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET
           default_visibility = excluded.default_visibility,
           updated_at = excluded.updated_at`,
      )
      .run(serverId, defaultVisibility, timestamp);
    return serverProjectionSchema.parse({
      serverId,
      defaultVisibility,
      updatedAt: timestamp,
    });
  }

  listToolProjections(serverId?: string): ToolProjection[] {
    const rows = serverId
      ? this.#db
          .prepare('SELECT * FROM tool_projections WHERE server_id = ? ORDER BY upstream_tool_name')
          .all(serverId)
      : this.#db
          .prepare('SELECT * FROM tool_projections ORDER BY server_id, upstream_tool_name')
          .all();
    return rows.map((row) => this.#parseToolProjection(row));
  }

  setToolProjection(
    serverId: string,
    toolName: string,
    visibility: ToolProjection['visibility'],
  ): void {
    if (visibility === 'inherit') {
      this.#db
        .prepare('DELETE FROM tool_projections WHERE server_id = ? AND upstream_tool_name = ?')
        .run(serverId, toolName);
      return;
    }
    this.#db
      .prepare(
        `INSERT INTO tool_projections (server_id, upstream_tool_name, visibility, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(server_id, upstream_tool_name) DO UPDATE SET
           visibility = excluded.visibility,
           updated_at = excluded.updated_at`,
      )
      .run(serverId, toolName, visibility, now());
  }

  getProjectionIndex(): ProjectionIndex {
    const index: ProjectionIndex = new Map();
    for (const row of this.#db.prepare('SELECT * FROM server_projections').all()) {
      const parsed = this.#parseServerProjection(row);
      index.set(parsed.serverId, {
        defaultVisibility: parsed.defaultVisibility,
        overrides: new Map(),
      });
    }
    for (const row of this.#db.prepare('SELECT * FROM tool_projections').all()) {
      const parsed = this.#parseToolProjection(row);
      if (parsed.visibility === 'inherit') continue;
      const entry = index.get(parsed.serverId) ?? {
        defaultVisibility: 'visible' as Visibility,
        overrides: new Map(),
      };
      entry.overrides.set(parsed.upstreamToolName, parsed.visibility);
      index.set(parsed.serverId, entry);
    }
    return index;
  }

  // ── Tool call observability ─────────────────────────────────────────────

  insertToolCalls(calls: ToolCallDraft[]): number {
    if (calls.length === 0) return 0;
    const statement = this.#db.prepare(
      `INSERT INTO tool_calls (
         id, endpoint_type, principal_kind, principal_id, server_id,
         exposed_tool_name, upstream_tool_name, status, error_type,
         started_at, completed_at, duration_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const call of calls) {
      const record = toolCallSchema.parse({ id: randomUUID(), ...call });
      statement.run(
        record.id,
        record.endpointType,
        record.principalKind,
        record.principalId,
        record.serverId,
        record.exposedToolName,
        record.upstreamToolName,
        record.status,
        record.errorType,
        record.startedAt,
        record.completedAt,
        record.durationMs,
      );
    }
    return calls.length;
  }

  listToolCalls(filter: ToolCallFilter): ToolCallRecord[] {
    const { where, params } = this.#callWhere(filter);
    const rows = this.#db
      .prepare(
        `SELECT * FROM tool_calls
         ${where}
         ORDER BY started_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit, filter.offset);
    return rows.map((row) => this.#parseToolCall(row));
  }

  countToolCalls(filter: ToolCallFilter): number {
    const { where, params } = this.#callWhere(filter);
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM tool_calls ${where}`).get(...params);
    return (row as { n: number }).n;
  }

  toolCallStats(filter: Omit<ToolCallFilter, 'limit' | 'offset'>): ToolCallStats {
    const { where, params } = this.#callWhere({ ...filter, limit: 50, offset: 0 });
    const totalRow = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM tool_calls ${where}`)
      .get(...params) as {
      n: number;
    };
    const total = totalRow.n;

    const byStatus: Partial<Record<ToolCallStatus, number>> = {};
    for (const row of this.#db
      .prepare(`SELECT status, COUNT(*) AS n FROM tool_calls ${where} GROUP BY status`)
      .all(...params)) {
      const parsed = row as { status: ToolCallStatus; n: number };
      byStatus[parsed.status] = parsed.n;
    }

    const durationRows = this.#db
      .prepare(
        `SELECT duration_ms FROM tool_calls
         ${where}
         ORDER BY started_at DESC LIMIT 10000`,
      )
      .all(...params) as { duration_ms: number }[];
    const durations = durationRows.map((row) => row.duration_ms).sort((a, b) => a - b);
    const avgDurationMs =
      durations.length === 0
        ? 0
        : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
    const percentile = (p: number): number => {
      if (durations.length === 0) return 0;
      const index = Math.min(durations.length - 1, Math.ceil((p / 100) * durations.length) - 1);
      return durations[index] ?? 0;
    };

    const topTools = (
      this.#db
        .prepare(
          `SELECT upstream_tool_name AS tool, COUNT(*) AS n FROM tool_calls
           ${where}
           GROUP BY upstream_tool_name ORDER BY n DESC LIMIT 10`,
        )
        .all(...params) as { tool: string; n: number }[]
    ).map((row) => ({ tool: row.tool, count: row.n }));

    const failingWhere = where === '' ? 'WHERE status != ?' : `${where} AND status != ?`;
    const failingParams = [...params, 'success'];
    const topFailing = (
      this.#db
        .prepare(
          `SELECT upstream_tool_name AS tool, error_type AS errorType, COUNT(*) AS n FROM tool_calls
           ${failingWhere}
           GROUP BY upstream_tool_name, error_type ORDER BY n DESC LIMIT 10`,
        )
        .all(...failingParams) as { tool: string; errorType: string | null; n: number }[]
    ).map((row) => ({ tool: row.tool, errorType: row.errorType, count: row.n }));

    const success = byStatus.success ?? 0;
    const error = total - success;
    return {
      total,
      byStatus,
      success,
      error,
      successRate: total === 0 ? 0 : Math.round((success / total) * 1000) / 10,
      avgDurationMs,
      p50Ms: percentile(50),
      p95Ms: percentile(95),
      topTools,
      topFailing,
    };
  }

  toolCallSeries(query: ToolCallSeriesQuery): ToolCallSeriesBucket[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [query.bucketSeconds];
    if (query.serverId !== undefined) {
      conditions.push('server_id = ?');
      params.push(query.serverId);
    }
    if (query.tool !== undefined) {
      conditions.push('upstream_tool_name = ?');
      params.push(query.tool);
    }
    if (query.endpointType !== undefined) {
      conditions.push('endpoint_type = ?');
      params.push(query.endpointType);
    }
    if (query.from !== undefined) {
      conditions.push('started_at >= ?');
      params.push(query.from);
    }
    if (query.to !== undefined) {
      conditions.push('started_at <= ?');
      params.push(query.to);
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = this.#db
      .prepare(
        `SELECT CAST(CAST(strftime('%s', started_at) AS INTEGER) / ? AS INTEGER) AS bucket,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success
         FROM tool_calls
         ${where}
         GROUP BY bucket
         ORDER BY bucket ASC`,
      )
      .all(...params) as { bucket: number; total: number; success: number }[];
    return rows.map((row) => ({
      bucket: Number(row.bucket),
      total: Number(row.total),
      success: Number(row.success),
    }));
  }

  deleteOldToolCalls(before: string): number {
    let total = 0;
    for (;;) {
      const rows = this.#db
        .prepare('SELECT id FROM tool_calls WHERE started_at < ? ORDER BY started_at ASC LIMIT 500')
        .all(before) as { id: string }[];
      if (rows.length === 0) break;
      const statement = this.#db.prepare('DELETE FROM tool_calls WHERE id = ?');
      for (const row of rows) statement.run(row.id);
      total += rows.length;
    }
    return total;
  }

  // ── Market install records & persistent jobs ───────────────────────────

  listInstallations(): MarketInstallation[] {
    return this.#db
      .prepare('SELECT * FROM market_installations ORDER BY installed_at DESC')
      .all()
      .map((row) => this.#parseInstallation(row));
  }

  getInstallation(entryId: string): MarketInstallation | null {
    const row = this.#db
      .prepare(
        'SELECT * FROM market_installations WHERE entry_id = ? ORDER BY installed_at DESC LIMIT 1',
      )
      .get(entryId);
    return row === undefined ? null : this.#parseInstallation(row);
  }

  createInstallation(input: Omit<MarketInstallation, 'id' | 'installedAt'>): MarketInstallation {
    const record = marketInstallationSchema.parse({
      id: randomUUID(),
      ...input,
      installedAt: now(),
    });
    this.#db
      .prepare(
        `INSERT INTO market_installations
         (id, source, entry_id, entry_version, recipe_revision, target_type, target_id, credential_id, installed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source,
        record.entryId,
        record.entryVersion,
        record.recipeRevision,
        record.targetType,
        record.targetId,
        record.credentialId,
        record.installedAt,
      );
    return record;
  }

  updateInstallation(
    id: string,
    patch: Partial<Pick<MarketInstallation, 'entryVersion' | 'recipeRevision'>>,
  ): MarketInstallation {
    this.#db
      .prepare(
        `UPDATE market_installations
         SET entry_version = COALESCE(?, entry_version),
             recipe_revision = COALESCE(?, recipe_revision)
         WHERE id = ?`,
      )
      .run(patch.entryVersion ?? null, patch.recipeRevision ?? null, id);
    const row = this.#db.prepare('SELECT * FROM market_installations WHERE id = ?').get(id);
    if (row === undefined)
      throw new AppError('market_installation_not_found', 'Installation not found', 404);
    return this.#parseInstallation(row);
  }

  deleteInstallation(id: string): void {
    this.#db.prepare('DELETE FROM market_installations WHERE id = ?').run(id);
  }

  createInstallJob(
    input: Omit<InstallJobRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): InstallJobRecord {
    const timestamp = now();
    const record = installJobRecordSchema.parse({
      id: randomUUID(),
      ...input,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#db
      .prepare(
        `INSERT INTO install_jobs
         (id, entry_id, requested_version, idempotency_key, status, step, bounded_output,
          result_reference, action_id, error_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.entryId,
        record.requestedVersion,
        record.idempotencyKey,
        record.status,
        record.step,
        record.boundedOutput,
        record.resultReference,
        record.actionId,
        record.errorCode,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  getInstallJob(id: string): InstallJobRecord | null {
    const row = this.#db.prepare('SELECT * FROM install_jobs WHERE id = ?').get(id);
    return row === undefined ? null : this.#parseInstallJob(row);
  }

  updateInstallJob(id: string, patch: Partial<InstallJobRecord>): InstallJobRecord {
    const current = this.#db.prepare('SELECT * FROM install_jobs WHERE id = ?').get(id);
    if (current === undefined) {
      throw new AppError('market_job_not_found', 'Install job not found', 404);
    }
    const merged = installJobRecordSchema.parse({
      ...this.#parseInstallJob(current),
      ...patch,
      updatedAt: now(),
    });
    this.#db
      .prepare(
        `UPDATE install_jobs SET
           requested_version = ?, idempotency_key = ?, status = ?, step = ?,
           bounded_output = ?, result_reference = ?, action_id = ?, error_code = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.requestedVersion,
        merged.idempotencyKey,
        merged.status,
        merged.step,
        merged.boundedOutput,
        merged.resultReference,
        merged.actionId,
        merged.errorCode,
        merged.updatedAt,
        merged.id,
      );
    return merged;
  }

  markInterruptedInstallJobs(): number {
    const result = this.#db
      .prepare(
        `UPDATE install_jobs
         SET status = 'interrupted', step = 'interrupted', updated_at = ?
         WHERE status IN ('awaiting_secret', 'installing')`,
      )
      .run(now());
    return Number(result.changes);
  }

  // ── Secure actions (URL-mode secret elicitation) ───────────────────────

  createSecureAction(input: Omit<SecureActionRecord, 'id' | 'createdAt'>): SecureActionRecord {
    const record = secureActionRecordSchema.parse({
      id: randomUUID(),
      ...input,
      createdAt: now(),
    });
    this.#db
      .prepare(
        `INSERT INTO secure_actions
         (id, kind, target, principal_id, status, values_json, expires_at, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.kind,
        record.target,
        record.principalId,
        record.status,
        record.valuesJson,
        record.expiresAt,
        record.createdAt,
        record.completedAt,
      );
    return record;
  }

  getSecureAction(id: string): SecureActionRecord | null {
    const row = this.#db.prepare('SELECT * FROM secure_actions WHERE id = ?').get(id);
    return row === undefined ? null : this.#parseSecureAction(row);
  }

  completeSecureAction(id: string, valuesJson: string, completedAt: string): SecureActionRecord {
    const result = this.#db
      .prepare(
        `UPDATE secure_actions
         SET status = 'completed', values_json = ?, completed_at = ?
         WHERE id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .run(valuesJson, completedAt, id, completedAt);
    if (Number(result.changes) === 0) {
      const current = this.#db
        .prepare('SELECT id, status FROM secure_actions WHERE id = ?')
        .get(id) as { id: string; status: string } | undefined;
      if (current === undefined) {
        throw new AppError('secure_action_not_found', 'Secure action not found', 404);
      }
      throw new AppError('secure_action_used', 'Secure action was already used', 400);
    }
    const completed = this.#db.prepare('SELECT * FROM secure_actions WHERE id = ?').get(id);
    if (completed === undefined) {
      throw new AppError('secure_action_not_found', 'Secure action not found', 404);
    }
    return this.#parseSecureAction(completed);
  }

  #callWhere(filter: ToolCallFilter): {
    where: string;
    params: (string | number)[];
  } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (filter.serverId !== undefined) {
      conditions.push('server_id = ?');
      params.push(filter.serverId);
    }
    if (filter.tool !== undefined) {
      conditions.push('upstream_tool_name = ?');
      params.push(filter.tool);
    }
    if (filter.endpointType !== undefined) {
      conditions.push('endpoint_type = ?');
      params.push(filter.endpointType);
    }
    if (filter.principalId !== undefined) {
      conditions.push('principal_id = ?');
      params.push(filter.principalId);
    }
    if (filter.status !== undefined) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.from !== undefined) {
      conditions.push('started_at >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      conditions.push('started_at <= ?');
      params.push(filter.to);
    }
    return { where: conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`, params };
  }

  #parseServerProjection(row: unknown): ServerProjection {
    const parsed = serverProjectionRowSchema.parse(row);
    return serverProjectionSchema.parse({
      serverId: parsed.server_id,
      defaultVisibility: parsed.default_visibility,
      updatedAt: parsed.updated_at,
    });
  }

  #parseToolProjection(row: unknown): ToolProjection {
    const parsed = toolProjectionRowSchema.parse(row);
    return toolProjectionSchema.parse({
      serverId: parsed.server_id,
      upstreamToolName: parsed.upstream_tool_name,
      visibility: parsed.visibility,
      updatedAt: parsed.updated_at,
    });
  }

  #parseToolCall(row: unknown): ToolCallRecord {
    const parsed = toolCallRowSchema.parse(row);
    return toolCallSchema.parse({
      id: parsed.id,
      endpointType: parsed.endpoint_type,
      principalKind: parsed.principal_kind,
      principalId: parsed.principal_id,
      serverId: parsed.server_id,
      exposedToolName: parsed.exposed_tool_name,
      upstreamToolName: parsed.upstream_tool_name,
      status: parsed.status,
      errorType: parsed.error_type,
      startedAt: parsed.started_at,
      completedAt: parsed.completed_at,
      durationMs: parsed.duration_ms,
    });
  }

  #parseInstallJob(row: unknown): InstallJobRecord {
    const parsed = installJobRowSchema.parse(row);
    return installJobRecordSchema.parse({
      id: parsed.id,
      entryId: parsed.entry_id,
      requestedVersion: parsed.requested_version,
      idempotencyKey: parsed.idempotency_key,
      status: parsed.status,
      step: parsed.step,
      boundedOutput: parsed.bounded_output,
      resultReference: parsed.result_reference,
      actionId: parsed.action_id,
      errorCode: parsed.error_code,
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
    });
  }

  #parseInstallation(row: unknown): MarketInstallation {
    const parsed = installationRowSchema.parse(row);
    return marketInstallationSchema.parse({
      id: parsed.id,
      source: parsed.source,
      entryId: parsed.entry_id,
      entryVersion: parsed.entry_version,
      recipeRevision: parsed.recipe_revision,
      targetType: parsed.target_type,
      targetId: parsed.target_id,
      credentialId: parsed.credential_id,
      installedAt: parsed.installed_at,
    });
  }

  #parseSecureAction(row: unknown): SecureActionRecord {
    const parsed = secureActionRowSchema.parse(row);
    return secureActionRecordSchema.parse({
      id: parsed.id,
      kind: parsed.kind,
      target: parsed.target,
      principalId: parsed.principal_id,
      status: parsed.status,
      valuesJson: parsed.values_json,
      expiresAt: parsed.expires_at,
      createdAt: parsed.created_at,
      completedAt: parsed.completed_at,
    });
  }

  #parseServer(row: unknown): ServerRecord {
    const parsed = serverRowSchema.parse(row);
    return serverRecordSchema.parse({
      id: parsed.id,
      slug: parsed.slug,
      name: parsed.name,
      kind: parsed.kind,
      transport: parseJson(parsed.transport_json),
      credentialId: parsed.credential_id,
      enabled: parsed.enabled === 1,
      settings: parseJson(parsed.settings_json),
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
    });
  }

  #parseCli(row: unknown): CliRecord {
    const parsed = cliRowSchema.parse(row);
    return cliRecordSchema.parse({
      id: parsed.id,
      slug: parsed.slug,
      name: parsed.name,
      command: parsed.command,
      executionMode: parsed.execution_mode as 'host' | 'docker',
      entrypoint: parsed.entrypoint,
      authStrategy: (parsed.auth_strategy ?? 'none') as
        'none' | 'azure-service-principal' | 'tailscale-auth-key',
      containerVolumes: parseJson(parsed.container_volumes_json ?? '[]'),
      platform: parsed.platform,
      allowList: parseJson(parsed.allow_list_json),
      interactive: parsed.interactive === 1,
      credentialId: parsed.credential_id,
      credentialBindings: parseJson(parsed.credential_bindings_json),
      probe: parsed.probe_json === null ? null : parseJson(parsed.probe_json),
      enabled: parsed.enabled === 1,
      timeoutMs: parsed.timeout_ms,
      maxOutputBytes: parsed.max_output_bytes,
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
    });
  }

  #parseCredential(row: unknown): CredentialRecord {
    const parsed = credentialRowSchema.parse(row);
    const status =
      parsed.type === 'oauth' &&
      parsed.expires_at !== null &&
      Date.parse(parsed.expires_at) <= Date.now()
        ? 'expired'
        : parsed.status;
    return credentialRecordSchema.parse({
      id: parsed.id,
      name: parsed.name,
      type: parsed.type,
      status,
      expiresAt: parsed.expires_at,
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
    });
  }

  #parseApiKey(row: unknown): ApiKeyRecord {
    const parsed = apiKeyRowSchema.parse(row);
    return apiKeyRecordSchema.parse({
      id: parsed.id,
      kind: parsed.kind,
      name: parsed.name,
      prefix: parsed.prefix,
      scope: parsed.scope,
      createdAt: parsed.created_at,
      lastUsedAt: parsed.last_used_at,
      revokedAt: parsed.revoked_at,
    });
  }

  #parseSnapshot(row: unknown): CapabilitySnapshot {
    const parsed = snapshotRowSchema.parse(row);
    return {
      serverId: parsed.server_id,
      version: parsed.version,
      protocolVersion: parsed.protocol_version,
      protocolEra: z.enum(['modern', 'legacy']).parse(parsed.protocol_era),
      serverInfo:
        parsed.server_info_json === null
          ? null
          : ImplementationSchema.parse(parseJson(parsed.server_info_json)),
      capabilities: ServerCapabilitiesSchema.parse(parseJson(parsed.capabilities_json)),
      instructions: parsed.instructions,
      tools: z.array(ToolSchema).parse(parseJson(parsed.tools_json)),
      resources: z.array(ResourceSchema).parse(parseJson(parsed.resources_json)),
      resourceTemplates: z
        .array(ResourceTemplateSchema)
        .parse(parseJson(parsed.resource_templates_json)),
      prompts: z.array(PromptSchema).parse(parseJson(parsed.prompts_json)),
      listResults: {
        tools: ListToolsResultSchema.parse(parseJson(parsed.tools_result_json)),
        resources: ListResourcesResultSchema.parse(parseJson(parsed.resources_result_json)),
        resourceTemplates: ListResourceTemplatesResultSchema.parse(
          parseJson(parsed.resource_templates_result_json),
        ),
        prompts: ListPromptsResultSchema.parse(parseJson(parsed.prompts_result_json)),
      },
      fingerprint: parsed.fingerprint,
      refreshedAt: parsed.refreshed_at,
    };
  }

  #parseRuntimeState(row: unknown): RuntimeState {
    const parsed = runtimeRowSchema.parse(row);
    return runtimeStateSchema.parse({
      serverId: parsed.server_id,
      status: parsed.status,
      protocolVersion: parsed.protocol_version,
      protocolEra: parsed.protocol_era,
      processId: parsed.process_id,
      restartCount: parsed.restart_count,
      lastSuccessAt: parsed.last_success_at,
      lastError: parsed.last_error,
      updatedAt: parsed.updated_at,
    });
  }

  #parseEvent(row: unknown): EventRecord {
    const parsed = eventRowSchema.parse(row);
    return {
      id: parsed.id,
      level: z.enum(['debug', 'info', 'warn', 'error']).parse(parsed.level),
      type: parsed.type,
      serverId: parsed.server_id,
      message: parsed.message,
      detail: z.record(z.string(), z.unknown()).parse(parseJson(parsed.detail_json)),
      createdAt: parsed.created_at,
    };
  }
}
