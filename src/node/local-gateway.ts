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
import { GatewayServerFactory } from '../data-plane/gateway-server.js';
import { CapabilityRegistry } from '../data-plane/registry.js';
import { ToolProjectionService } from '../data-plane/projection.js';
import { serverRecordSchema, type ServerRecord } from '../domain/models.js';
import { createLogger, type Logger } from '../observability/logger.js';
import { CallRecorder } from '../observability/call-recorder.js';
import { CursorCodec } from '../security/cursor-codec.js';
import { SecretBox } from '../security/secret-box.js';
import { SqliteStore } from '../storage/sqlite-store.js';
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

export interface LocalGatewayOptions {
  /** Authenticated control client; the gateway reads its own servers from it. */
  client: ControlClient;
  /** Which machine this is. Servers placed on other nodes are ignored. */
  nodeId: string;
  /** Where the local mirror lives, for example `~/.config/toolhome/node.sqlite`. */
  storePath: string;
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

export async function startLocalGateway(options: LocalGatewayOptions): Promise<LocalGateway> {
  const logger: Logger = createLogger('info', (line) => process.stderr.write(`${line}\n`));
  // Deterministic key: the mirror stores no credential payloads, only server
  // records and discovered capability snapshots.
  const masterKey = `toolhome-local-node:${options.nodeId}`;
  const store = new SqliteStore(options.storePath, new SecretBox(masterKey));
  const credentials = new NodeCredentialSource();
  const upstreams = new UpstreamManager(store, credentials, logger, {
    canHost: (server) =>
      server.kind === 'node' && server.nodeId === options.nodeId && server.enabled,
  });

  const { servers, environments } = await fetchNodeServers(options.client, options.nodeId, logger);
  reconcile(store, servers);
  credentials.configure(environments);

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
  );

  // Tools of the aggregate come from stored capability snapshots, so a server has
  // to be connected once before it can be listed. Afterwards the child is dropped
  // again and only respawns when a tool call needs it. Ids come from the mirror:
  // the store mints its own, so ToolHome's ids are not usable here.
  const discovered: string[] = [];
  for (const server of store
    .listServers()
    .filter((item) => item.enabled && item.kind === 'node' && item.nodeId === options.nodeId)) {
    if (store.getSnapshot(server.id) !== null) continue;
    try {
      await upstreams.refresh(server.id);
      await upstreams.remove(server.id);
      discovered.push(server.slug);
    } catch (error) {
      logger.warn('Capability discovery failed; its tools stay absent until it succeeds', {
        slug: server.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info('local gateway ready', {
    nodeId: options.nodeId,
    servers: servers.length,
    discovered,
  });

  return {
    serverFactory: () => gatewayFactory.aggregate(),
    async close(): Promise<void> {
      await upstreams.close();
    },
  };
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
