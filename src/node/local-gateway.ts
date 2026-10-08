/**
 * Local data plane for node-hosted servers.
 *
 * A client machine runs one stdio connection that fronts every server placed on
 * it: the mirror below keeps a copy of those servers in a local SQLite store so
 * the same gateway, registry and virtualization the ToolHome host uses can serve
 * them, capabilities are discovered once and then served from that snapshot, and
 * children are only spawned when a tool call needs them.
 */
import { ControlClient } from '../control/client.js';
import type { McpToolMode } from '../config.js';
import { GatewayServerFactory } from '../data-plane/gateway-server.js';
import { CapabilityRegistry } from '../data-plane/registry.js';
import { ToolProjectionService } from '../data-plane/projection.js';
import { AppError, errorMessage } from '../domain/errors.js';
import { serverRecordSchema, type ServerRecord } from '../domain/models.js';
import { createLogger, type Logger } from '../observability/logger.js';
import { CallRecorder } from '../observability/call-recorder.js';
import { CursorCodec } from '../security/cursor-codec.js';
import { SecretBox } from '../security/secret-box.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import type { Store } from '../storage/store.js';
import type { CredentialSource, ResolvedCredential } from '../upstream/credential-resolver.js';
import { UpstreamManager } from '../upstream/manager.js';
import { z } from 'zod';
import type { Server } from '@modelcontextprotocol/server';

const runtimeResponseSchema = z.object({
  serverId: z.uuid(),
  slug: z.string(),
  kind: z.enum(['remote', 'home', 'node']),
  nodeId: z.string().nullable(),
  transport: z.unknown(),
  credentialEnv: z.record(z.string(), z.string()),
});

const projectionResponseSchema = z.object({
  defaultVisibility: z.enum(['visible', 'hidden']).default('visible'),
  overrides: z.record(z.string(), z.enum(['visible', 'hidden'])).default({}),
});

export interface LocalGatewayOptions {
  /** Authenticated control client; the gateway reads its own servers from it. */
  client: ControlClient;
  /** Which machine this is. Servers placed on other nodes are ignored. */
  nodeId: string;
  /** Where the local mirror lives, for example `~/.config/toolhome/node.sqlite`. */
  storePath: string;
  /**
   * Tool exposure for the local aggregate. Defaults to `full`; `compact`
   * exposes `search`/`exec` and mirrors the control-plane projection first.
   */
  toolMode?: McpToolMode;
  /** Idle time after which discovered children are disconnected again. */
  idleDisconnectMs?: number;
}

export interface LocalGateway {
  /** One aggregate server over every node-hosted server on this machine. */
  serverFactory: () => Server;
  /** Disconnect every child. Call this when the stdio connection goes away. */
  close(): Promise<void>;
}

/** Credential values per server slug, materialized by the ToolHome control API. */
class NodeCredentialSource implements CredentialSource {
  readonly #envBySlug = new Map<string, Record<string, string>>();

  configure(entries: { slug: string; env: Record<string, string> }[]): void {
    for (const entry of entries) this.#envBySlug.set(entry.slug, entry.env);
  }

  resolve(server: ServerRecord): ResolvedCredential {
    return { headers: {}, env: this.#envBySlug.get(server.slug) ?? {} };
  }
}

export interface LocalGatewayRuntime {
  nodeId: string;
  store: SqliteStore;
  upstreams: UpstreamManager;
  servers: ServerRecord[];
  serverFactory: () => Server;
  /**
   * Connect to servers to (re)discover their capabilities, then drop the
   * children again. Without `force`, servers that already have a snapshot are
   * skipped, so steady state stays lazy.
   */
  discoverSnapshots(force?: boolean): Promise<{ slug: string; ok: boolean; error?: string }[]>;
  close(): Promise<void>;
}

/** Outcome of mirroring one server's control-plane projection into the mirror. */
export interface LocalProjectionSyncResult {
  slug: string;
  ok: boolean;
  error?: string;
}

/**
 * Mirror the control plane's tool visibility into the local store, mapping each
 * control id to the mirrored server's local id by slug. Compact discovery trusts
 * only these rows: a server whose projection cannot be read is hidden outright
 * rather than falling back to "all visible".
 */
export async function syncLocalProjections(
  client: Pick<ControlClient, 'request'>,
  store: Store,
  servers: ServerRecord[],
): Promise<LocalProjectionSyncResult[]> {
  const localBySlug = new Map(store.listServers().map((server) => [server.slug, server]));
  const results: LocalProjectionSyncResult[] = [];
  for (const server of servers) {
    const local = localBySlug.get(server.slug);
    if (local === undefined) {
      results.push({ slug: server.slug, ok: false, error: 'not present in the local mirror' });
      continue;
    }
    try {
      const projection = projectionResponseSchema.parse(
        await client.request('GET', `/api/v1/servers/${server.id}/projection`),
      );
      store.setServerProjection(local.id, projection.defaultVisibility);
      replaceToolProjections(store, local.id, projection.overrides);
      results.push({ slug: server.slug, ok: true });
    } catch (error) {
      // Fail closed: no trusted projection means the server stays out of the
      // compact catalog until a later sync succeeds.
      store.setServerProjection(local.id, 'hidden');
      replaceToolProjections(store, local.id, {});
      results.push({
        slug: server.slug,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** Apply non-inherit overrides and drop any that the control plane removed. */
function replaceToolProjections(
  store: Store,
  serverId: string,
  overrides: Record<string, 'visible' | 'hidden'>,
): void {
  for (const existing of store.listToolProjections(serverId)) {
    if (!Object.hasOwn(overrides, existing.upstreamToolName)) {
      store.setToolProjection(serverId, existing.upstreamToolName, 'inherit');
    }
  }
  for (const [tool, visibility] of Object.entries(overrides)) {
    store.setToolProjection(serverId, tool, visibility);
  }
}

/**
 * Return the mirror to its pre-compact state: no effective visibility filter.
 * Only compact sync writes these rows, so clearing them restores full behavior.
 */
function resetLocalProjections(store: Store): void {
  for (const server of store.listServers()) {
    if (
      store.getServerProjection(server.id) === null &&
      store.listToolProjections(server.id).length === 0
    ) {
      continue;
    }
    store.setServerProjection(server.id, 'visible');
    replaceToolProjections(store, server.id, {});
  }
}

/**
 * Opens the local node mirror. A mirror is bound to the node label that created
 * it, so a label that changed silently (for example a config rewrite that
 * dropped `nodeId`) used to fail with a bare master-key message that hid the
 * cause and the fix.
 */
function openMirror(storePath: string, masterKey: string, nodeId: string): SqliteStore {
  try {
    return new SqliteStore(storePath, new SecretBox(masterKey));
  } catch (error) {
    const code = error instanceof AppError ? error.code : null;
    if (code !== 'master_key_mismatch' && code !== 'credential_decryption_failed') throw error;
    throw new AppError(
      code,
      `${errorMessage(error)}: ${storePath} belongs to a different node label than "${nodeId}". ` +
        'Run with --node <label> or set "nodeId" in the local CLI config.',
      500,
    );
  }
}

/** Build the local runtime: mirror the node's servers and compose the gateway. */
export async function prepareLocalGateway(
  options: LocalGatewayOptions,
): Promise<LocalGatewayRuntime> {
  const logger: Logger = createLogger('info', (line) => process.stderr.write(`${line}\n`));
  // Deterministic key: the mirror stores no credential payloads, only server
  // records and discovered capability snapshots.
  const masterKey = `toolhome-local-node:${options.nodeId}`;
  const store = openMirror(options.storePath, masterKey, options.nodeId);
  const credentials = new NodeCredentialSource();
  const upstreams = new UpstreamManager(store, credentials, logger, {
    canHost: (server) =>
      server.kind === 'node' && server.nodeId === options.nodeId && server.enabled,
  });

  const { servers, environments } = await fetchNodeServers(options.client, options.nodeId, logger);
  reconcile(store, servers);
  credentials.configure(environments);

  const toolMode = options.toolMode ?? 'full';
  if (toolMode === 'compact') {
    // Compact discovery has no upstream requests of its own, so the control
    // plane's projection must be mirrored once up front and fail closed.
    for (const synced of await syncLocalProjections(options.client, store, servers)) {
      if (!synced.ok) {
        logger.warn('Compact projection unavailable; the server stays hidden', {
          slug: synced.slug,
          error: synced.error,
        });
      }
    }
  } else {
    // Rows left by an earlier compact run live in the shared mirror; full mode
    // must keep its original "no projection means visible" behavior.
    resetLocalProjections(store);
  }

  const registry = new CapabilityRegistry(store);
  const cursors = new CursorCodec(masterKey);
  const projections = new ToolProjectionService(store);
  const recorder = new CallRecorder(store, logger, 30);
  const gatewayFactory = new GatewayServerFactory(
    registry,
    upstreams,
    cursors,
    masterKey,
    projections,
    recorder,
    { toolMode, scope: 'local', nodeLabel: options.nodeId },
  );

  return {
    nodeId: options.nodeId,
    store,
    upstreams,
    servers,
    serverFactory: () => gatewayFactory.aggregate(),
    async discoverSnapshots(force = false) {
      // Tools of the aggregate come from stored capability snapshots, so a server
      // has to be connected once before it can be listed. Afterwards the child is
      // dropped again and only respawns when a tool call needs it. Ids come from
      // the mirror: the store mints its own, so ToolHome's ids are not usable.
      // Servers are checked in parallel: one slow `npx` download would otherwise
      // stretch a `--check` into minutes.
      const targets = store
        .listServers()
        .filter(
          (item) =>
            item.enabled &&
            item.kind === 'node' &&
            item.nodeId === options.nodeId &&
            (force || store.getSnapshot(item.id) === null),
        );
      const checked = await Promise.all(
        targets.map(async (server) => {
          try {
            await upstreams.refresh(server.id);
            await upstreams.remove(server.id);
            return { slug: server.slug, ok: true, error: undefined as string | undefined };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn('Capability discovery failed; its tools stay absent until it succeeds', {
              slug: server.slug,
              error: message,
            });
            return { slug: server.slug, ok: false, error: message };
          }
        }),
      );
      return checked.sort((left, right) => left.slug.localeCompare(right.slug));
    },
    async close(): Promise<void> {
      await gatewayFactory.close();
      await upstreams.close();
      await recorder.close();
    },
  };
}

/** Start the local gateway and keep it serving over the caller's stdio. */
export async function startLocalGateway(options: LocalGatewayOptions): Promise<LocalGateway> {
  const runtime = await prepareLocalGateway(options);
  return { serverFactory: runtime.serverFactory, close: () => runtime.close() };
}

/**
 * The servers placed on this machine, plus the launch environment for each. The
 * environment is read per server because credentials are decrypted by the host
 * exactly when a client needs them and never stored on the node.
 */
async function fetchNodeServers(
  client: ControlClient,
  nodeId: string,
  logger: Logger,
): Promise<{
  servers: ServerRecord[];
  environments: { slug: string; env: Record<string, string> }[];
}> {
  const servers = z
    .array(serverRecordSchema)
    .parse(await client.request('GET', '/api/v1/servers'))
    .filter((server) => server.kind === 'node' && server.nodeId === nodeId);
  const environments: { slug: string; env: Record<string, string> }[] = [];
  for (const server of servers) {
    try {
      const runtime = runtimeResponseSchema.parse(
        await client.request('GET', `/api/v1/servers/${server.id}/runtime`),
      );
      environments.push({ slug: server.slug, env: runtime.credentialEnv });
    } catch (error) {
      logger.warn('Runtime environment unavailable; the server will start without one', {
        slug: server.slug,
        error: error instanceof Error ? error.message : String(error),
      });
      environments.push({ slug: server.slug, env: {} });
    }
  }
  return { servers, environments };
}

/**
 * Make the mirror match what ToolHome assigned to this node. Records are keyed
 * by slug because ToolHome and the mirror mint different ids.
 */
function reconcile(store: SqliteStore, servers: ServerRecord[]): void {
  const existingBySlug = new Map(store.listServers().map((server) => [server.slug, server]));
  const wantedSlugs = new Set<string>();
  for (const next of servers) {
    wantedSlugs.add(next.slug);
    const existing = existingBySlug.get(next.slug);
    if (existing === undefined) {
      store.createServer({ ...next, credentialId: null });
      continue;
    }
    const drifted =
      existing.name !== next.name ||
      existing.transport.type !== next.transport.type ||
      JSON.stringify(existing.transport) !== JSON.stringify(next.transport) ||
      existing.enabled !== next.enabled ||
      JSON.stringify(existing.settings) !== JSON.stringify(next.settings);
    if (drifted) {
      store.updateServer(existing.id, {
        name: next.name,
        nodeId: next.nodeId,
        transport: next.transport,
        credentialId: null,
        enabled: next.enabled,
        settings: next.settings,
      });
    }
  }
  for (const existing of store.listServers()) {
    if (!wantedSlugs.has(existing.slug)) store.deleteServer(existing.id);
  }
}
