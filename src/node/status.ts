/**
 * Local health report for the servers placed on this machine.
 *
 * Everything here is read from the node mirror (`~/.config/toolhome/node.sqlite`),
 * which `toolhome mcp stdio` writes on every session: runtime state from the last
 * connection, capability snapshots from the last discovery, and per-server call
 * records. No network access, no spawned children.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerRecord, TransportConfig } from '../domain/models.js';
import { SecretBox } from '../security/secret-box.js';
import { SqliteStore } from '../storage/sqlite-store.js';

export interface NodeServerStatus {
  slug: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  updatedAt: string | null;
  transportSummary: string;
  probe: { ok: boolean; detail: string };
  /** null when no capability snapshot exists yet — the server was never reached. */
  tools: number | null;
  resources: number | null;
  prompts: number | null;
  calls: number;
  lastCallAt: string | null;
}

export interface NodeStatusReport {
  nodeId: string;
  mirrorPath: string;
  mirrorExists: boolean;
  servers: NodeServerStatus[];
}

export function readNodeStatus(options: { nodeId: string; storePath: string }): NodeStatusReport {
  const report: NodeStatusReport = {
    nodeId: options.nodeId,
    mirrorPath: options.storePath,
    mirrorExists: existsSync(options.storePath),
    servers: [],
  };
  if (!report.mirrorExists) return report;
  // Same deterministic key the stdio gateway uses; the mirror stores no secrets.
  const store = new SqliteStore(
    options.storePath,
    new SecretBox(`toolhome-local-node:${options.nodeId}`),
  );
  try {
    const servers = store
      .listServers()
      .filter((server) => server.kind === 'node' && server.nodeId === options.nodeId)
      .sort((left, right) => left.slug.localeCompare(right.slug));
    for (const server of servers) report.servers.push(describeServer(store, server));
  } finally {
    store.close();
  }
  return report;
}

function describeServer(store: SqliteStore, server: ServerRecord): NodeServerStatus {
  const runtime = store.getRuntimeState(server.id);
  const snapshot = store.getSnapshot(server.id);
  // The recorder caps queries at 500; close enough for a "how busy is it" view.
  const calls = store.listToolCalls({ serverId: server.id, limit: 500, offset: 0 });
  return {
    slug: server.slug,
    enabled: server.enabled,
    status: runtime?.status ?? 'unknown',
    lastError: runtime?.lastError ?? null,
    updatedAt: runtime?.updatedAt ?? null,
    transportSummary: summarizeTransport(server.transport),
    probe: probeCommand(server.transport),
    tools: snapshot ? snapshot.tools.length : null,
    resources: snapshot ? snapshot.resources.length : null,
    prompts: snapshot ? snapshot.prompts.length : null,
    calls: calls.length,
    lastCallAt: calls[0]?.startedAt ?? null,
  };
}

function summarizeTransport(transport: TransportConfig): string {
  if (transport.type !== 'stdio') return transport.url;
  return [transport.command, ...transport.args].join(' ');
}

/**
 * Whether the launch command exists on this machine: absolute paths are checked
 * directly, bare names are looked up on PATH.
 */
function probeCommand(transport: TransportConfig): { ok: boolean; detail: string } {
  if (transport.type !== 'stdio') {
    return { ok: false, detail: 'not a stdio server' };
  }
  const { command } = transport;
  if (command.includes('/')) {
    return existsSync(command)
      ? { ok: true, detail: command }
      : { ok: false, detail: `${command} (missing)` };
  }
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory === '') continue;
    const candidate = join(directory, command);
    if (existsSync(candidate)) return { ok: true, detail: candidate };
  }
  return { ok: false, detail: `${command} not found on PATH` };
}
