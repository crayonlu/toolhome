/**
 * Compact-surface benchmark: compares the shipped `field-score` and `bm25`
 * `ToolCatalog` rankers over labeled fixtures or an exported real catalog, and
 * reports retrieval quality, warm/cold latency, fixed-tool token counts, a
 * stable catalog fingerprint and the hardware fingerprint.
 *
 * Read-only and snapshot-only: no upstream connection, no credential access.
 * Token counting shells out to `python3` + `tiktoken`; when unavailable the
 * result is reported `blocked` with the reason, never a fabricated count.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import {
  compactTools,
  estimateCompactToolsTokens,
  resultByteLength,
} from '../src/data-plane/compact-protocol.js';
import { aggregateToolName } from '../src/data-plane/virtualization.js';
import { ToolProjectionService } from '../src/data-plane/projection.js';
import { ToolCatalog, type RankAlgorithm } from '../src/data-plane/tool-catalog.js';
import type { CapabilitySnapshot, ServerRecord } from '../src/domain/models.js';
import { SecretBox } from '../src/security/secret-box.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import type { Store } from '../src/storage/store.js';
import { fingerprint } from '../src/upstream/stable-json.js';
import {
  retrievalTasks,
  robustnessInputs,
  seedCompactCatalog,
} from '../tests/fixtures/compact-retrieval.js';
import {
  realHostChinesePairing,
  realHostHeldout,
  realHostRobustness,
  realHostTasks,
  realLocalRobustness,
  realLocalTasks,
  type RealRobustness,
  type RealTask,
} from '../tests/fixtures/compact-real-tasks.js';

// ── constants ─────────────────────────────────────────────────────────────

/** The two actual OpenAI BPE tokenizers used to price the fixed tool schema. */
export const ACTUAL_TOKENIZERS = [
  { name: 'o200k_base', modelHint: 'GPT-4o / o-series' },
  { name: 'cl100k_base', modelHint: 'GPT-4 / GPT-3.5' },
] as const;

const PLACEHOLDER_SETTINGS = {
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  maxTotalTimeoutMs: 600_000,
  maxConcurrency: 1,
  restart: 'on-failure' as const,
};

// ── catalog file contract ─────────────────────────────────────────────────

export interface CatalogSeedServer {
  slug: string;
  name: string;
  kind: 'remote' | 'home' | 'node';
  nodeId: string | null;
  enabled: boolean;
  instructions: string | null;
  defaultVisibility?: 'visible' | 'hidden';
  hiddenTools?: string[];
  snapshotFingerprint?: string;
  tools: Tool[];
}

export interface BenchmarkTask {
  id: string;
  query: string;
  expected: string | null;
  group: string;
  /** Explicit dev/heldout split; when absent the benchmark hashes the id. */
  split?: 'main' | 'heldout';
  note?: string;
}

export interface BenchmarkRobustness {
  id: string;
  query: string;
  outcome: 'match' | 'no-match';
  expected?: string;
  topK?: number;
  requiresDuplicateProvider?: boolean;
  note?: string;
}

export interface CatalogFile {
  formatVersion: number;
  generatedAt: string;
  source: string;
  servers: CatalogSeedServer[];
  tasks?: BenchmarkTask[];
  robustness?: BenchmarkRobustness[];
}

const seedServerSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['remote', 'home', 'node']),
  nodeId: z.string().nullish(),
  enabled: z.boolean().optional(),
  instructions: z.string().nullish(),
  defaultVisibility: z.enum(['visible', 'hidden']).optional(),
  hiddenTools: z.array(z.string()).optional(),
  snapshotFingerprint: z.string().optional(),
  tools: z.array(z.unknown()),
});

const taskSchema = z.object({
  id: z.string().min(1),
  query: z.string(),
  expected: z.string().nullable(),
  group: z.string().min(1),
  split: z.enum(['main', 'heldout']).optional(),
  note: z.string().optional(),
});

const robustnessSchema = z.object({
  id: z.string().min(1),
  query: z.string(),
  outcome: z.enum(['match', 'no-match']),
  expected: z.string().optional(),
  topK: z.number().int().positive().optional(),
  requiresDuplicateProvider: z.boolean().optional(),
  note: z.string().optional(),
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Accepts the benchmark's own `{servers:[{...tools}]}` shape and the raw
 * control-API shape `{servers:[ServerRecord], snapshots:[CapabilitySnapshot]}`
 * (merged by `serverId`). Unknown shapes fail loudly instead of guessing.
 */
export function normalizeCatalogFile(value: unknown): CatalogFile {
  const raw = asRecord(value);
  if (!raw || !Array.isArray(raw.servers)) {
    throw new Error('catalog file must be an object with a "servers" array');
  }
  const snapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
  const snapshotsByServer = new Map<string, Record<string, unknown>>();
  for (const snapshot of snapshots) {
    const record = asRecord(snapshot);
    const serverId = record?.serverId;
    if (record && typeof serverId === 'string') snapshotsByServer.set(serverId, record);
  }

  const servers = raw.servers.map((item) => {
    const record = asRecord(item);
    if (!record) throw new Error('catalog server entry must be an object');
    if (Array.isArray(record.tools)) {
      return seedServerSchema.parse(record) as CatalogSeedServer;
    }
    const id = record.id;
    const snapshot = typeof id === 'string' ? snapshotsByServer.get(id) : undefined;
    return seedServerSchema.parse({
      slug: record.slug,
      name: record.name,
      kind: record.kind,
      nodeId: (record.nodeId as string | null | undefined) ?? null,
      enabled: record.enabled,
      instructions: (snapshot?.instructions as string | null | undefined) ?? null,
      snapshotFingerprint: snapshot?.fingerprint,
      tools: snapshot?.tools ?? [],
    }) as CatalogSeedServer;
  });

  return {
    formatVersion: typeof raw.formatVersion === 'number' ? raw.formatVersion : 1,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString(),
    source: typeof raw.source === 'string' ? raw.source : 'file',
    servers,
    ...(Array.isArray(raw.tasks) ? { tasks: z.array(taskSchema).parse(raw.tasks) } : {}),
    ...(Array.isArray(raw.robustness)
      ? { robustness: z.array(robustnessSchema).parse(raw.robustness) }
      : {}),
  };
}

export function loadCatalogFile(path: string): CatalogFile {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return normalizeCatalogFile(parsed);
}

// ── read-only catalog export ──────────────────────────────────────────────

interface SqliteServerRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  node_id: string | null;
  enabled: number;
}

interface SqliteSnapshotRow {
  server_id: string;
  instructions: string | null;
  tools_json: string;
  fingerprint: string;
}

interface SqliteProjectionRow {
  server_id: string;
  default_visibility: string;
}

interface SqliteToolProjectionRow {
  server_id: string;
  upstream_tool_name: string;
  visibility: string;
}

/** Reads `toolhome.sqlite` strictly read-only and strips all credential links. */
export async function exportCatalogFromSqlite(sqlitePath: string): Promise<CatalogFile> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const serverRows = db
      .prepare('SELECT id, slug, name, kind, node_id, enabled FROM servers ORDER BY slug')
      .all() as unknown as SqliteServerRow[];
    const snapshotRows = db
      .prepare('SELECT server_id, instructions, tools_json, fingerprint FROM capability_snapshots')
      .all() as unknown as SqliteSnapshotRow[];
    const projectionRows = db
      .prepare('SELECT server_id, default_visibility FROM server_projections')
      .all() as unknown as SqliteProjectionRow[];
    const toolProjectionRows = db
      .prepare('SELECT server_id, upstream_tool_name, visibility FROM tool_projections')
      .all() as unknown as SqliteToolProjectionRow[];

    const snapshots = new Map(snapshotRows.map((row) => [row.server_id, row]));
    const defaultVisibility = new Map(
      projectionRows.map((row) => [row.server_id, row.default_visibility]),
    );
    const hiddenTools = new Map<string, string[]>();
    for (const row of toolProjectionRows) {
      if (row.visibility !== 'hidden') continue;
      const list = hiddenTools.get(row.server_id) ?? [];
      list.push(row.upstream_tool_name);
      hiddenTools.set(row.server_id, list);
    }

    const servers: CatalogSeedServer[] = [];
    for (const row of serverRows) {
      const snapshot = snapshots.get(row.id);
      if (!snapshot) continue;
      servers.push({
        slug: row.slug,
        name: row.name,
        kind: row.kind as CatalogSeedServer['kind'],
        nodeId: row.node_id,
        enabled: row.enabled === 1,
        instructions: snapshot.instructions,
        ...(defaultVisibility.has(row.id)
          ? { defaultVisibility: defaultVisibility.get(row.id) as 'visible' | 'hidden' }
          : {}),
        ...(hiddenTools.has(row.id) ? { hiddenTools: hiddenTools.get(row.id) } : {}),
        snapshotFingerprint: snapshot.fingerprint,
        tools: JSON.parse(snapshot.tools_json) as Tool[],
      });
    }
    return {
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      source: `sqlite:${basename(sqlitePath)}`,
      servers,
    };
  } finally {
    db.close();
  }
}

/** Read-only Control API export. The key is supplied by the caller, never logged. */
export async function exportCatalogFromControl(options: {
  url: URL;
  controlKey: string;
  fetchImpl?: typeof fetch;
}): Promise<CatalogFile> {
  const doFetch = options.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${options.controlKey}` };
  const serversResponse = await doFetch(new URL('/api/v1/servers', options.url), { headers });
  if (!serversResponse.ok) {
    throw new Error(`control GET /api/v1/servers failed: HTTP ${serversResponse.status}`);
  }
  const rawServers = (await serversResponse.json()) as unknown;
  if (!Array.isArray(rawServers)) throw new Error('control servers response was not an array');
  const snapshots: unknown[] = [];
  for (const raw of rawServers) {
    const record = asRecord(raw);
    if (!record || typeof record.id !== 'string') continue;
    if (record.enabled === false) continue;
    const capabilities = await doFetch(
      new URL(`/api/v1/servers/${record.id}/capabilities`, options.url),
      { headers },
    );
    if (!capabilities.ok) continue;
    snapshots.push(await capabilities.json());
  }
  return normalizeCatalogFile({ servers: rawServers, snapshots });
}

// ── corpus seeding ────────────────────────────────────────────────────────

export interface BenchmarkCorpus {
  store: SqliteStore;
  projections: ToolProjectionService;
  directory: string;
  source: string;
  close(): void;
}

function openStore(): BenchmarkCorpus {
  const directory = mkdtempSync(join(os.tmpdir(), 'toolhome-benchmark-'));
  const store = new SqliteStore(
    join(directory, 'benchmark.sqlite'),
    new SecretBox('benchmark-master-key-000000000000000000000000000001'),
  );
  return {
    store,
    projections: new ToolProjectionService(store),
    directory,
    source: 'fixture',
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function placeholderTransport(slug: string, kind: CatalogSeedServer['kind']) {
  if (kind === 'remote') {
    return {
      type: 'streamable-http' as const,
      url: `https://${slug}.benchmark.invalid/mcp`,
      protocolMode: 'modern' as const,
      allowSseFallback: false,
      headers: {},
    };
  }
  return {
    type: 'stdio' as const,
    command: 'node',
    args: [] as string[],
    env: {},
    protocolMode: 'auto' as const,
  };
}

function makeSnapshot(
  server: ServerRecord,
  spec: CatalogSeedServer,
  generatedAt: string,
): CapabilitySnapshot {
  const tools = spec.tools;
  return {
    serverId: server.id,
    version: 1,
    protocolVersion: '2026-07-28',
    protocolEra: 'modern',
    serverInfo: { name: spec.slug, version: '0.0.0' },
    capabilities: { tools: { listChanged: false } },
    instructions: spec.instructions,
    tools,
    resources: [],
    resourceTemplates: [],
    prompts: [],
    listResults: {
      tools: { tools },
      resources: { resources: [] },
      resourceTemplates: { resourceTemplates: [] },
      prompts: { prompts: [] },
    },
    fingerprint: spec.snapshotFingerprint ?? fingerprint({ slug: spec.slug, tools }),
    refreshedAt: generatedAt,
  };
}

export function seedCatalogFile(store: Store, file: CatalogFile): void {
  for (const spec of file.servers) {
    const server = store.createServer({
      slug: spec.slug,
      name: spec.name,
      kind: spec.kind,
      nodeId: spec.nodeId,
      transport: placeholderTransport(spec.slug, spec.kind),
      credentialId: null,
      enabled: spec.enabled,
      settings: PLACEHOLDER_SETTINGS,
    });
    store.saveSnapshot(makeSnapshot(server, spec, file.generatedAt));
    if (spec.defaultVisibility !== undefined) {
      store.setServerProjection(server.id, spec.defaultVisibility);
    }
    for (const tool of spec.hiddenTools ?? []) {
      store.setToolProjection(server.id, tool, 'hidden');
    }
  }
}

export function buildFixtureCorpus(options: { duplicateProvider?: boolean } = {}): BenchmarkCorpus {
  const corpus = openStore();
  seedCompactCatalog(corpus.store, { duplicateProvider: options.duplicateProvider ?? false });
  corpus.source = options.duplicateProvider === true ? 'fixture+duplicate' : 'fixture';
  return corpus;
}

export function buildCatalogCorpus(file: CatalogFile): BenchmarkCorpus {
  const corpus = openStore();
  seedCatalogFile(corpus.store, file);
  corpus.source = file.source;
  return corpus;
}

// ── ranker variants ───────────────────────────────────────────────────────

/** `coverage-baseline` is the shipped field-score ranker with the coverage gate off. */
export type RankerId = RankAlgorithm | 'coverage-baseline';

export interface RankerSpec {
  id: RankerId;
  algorithm: RankAlgorithm;
  coverageGate: boolean;
}

export const RANKERS: Record<RankerId, RankerSpec> = {
  'field-score': { id: 'field-score', algorithm: 'field-score', coverageGate: true },
  bm25: { id: 'bm25', algorithm: 'bm25', coverageGate: true },
  'coverage-baseline': { id: 'coverage-baseline', algorithm: 'field-score', coverageGate: false },
};

export function rankerSpec(ranker: RankerId | RankerSpec): RankerSpec {
  return typeof ranker === 'string' ? RANKERS[ranker] : ranker;
}

// ── catalog views ─────────────────────────────────────────────────────────

export interface CatalogView {
  ranker: RankerSpec;
  /** Underlying shipped rank algorithm, kept for fingerprint/latency reporting. */
  algorithm: RankAlgorithm;
  coverageGate: boolean;
  host: ToolCatalog;
  locals: ToolCatalog[];
  /** Every scope entry with a stable label for reporting. */
  scopes(): { label: string; catalog: ToolCatalog }[];
  /** The catalog that carries this view's tools: host when populated, else first local. */
  primary(): ToolCatalog;
  /** The catalog that owns a visible aggregate tool id, if any. */
  owner(toolId: string): ToolCatalog | undefined;
  all(): ToolCatalog[];
}

export function buildCatalogView(
  store: Store,
  projections: ToolProjectionService,
  ranker: RankerId | RankerSpec,
): CatalogView {
  const spec = rankerSpec(ranker);
  const options = { rankAlgorithm: spec.algorithm, coverageGate: spec.coverageGate };
  const host = new ToolCatalog(store, projections, { scope: 'host', ...options });
  const records = store.listServers();
  const nodeIds = [
    ...new Set(
      records
        .filter((server) => server.kind === 'node' && typeof server.nodeId === 'string')
        .map((server) => server.nodeId as string),
    ),
  ].sort();
  const locals = nodeIds.map(
    (nodeId) => new ToolCatalog(store, projections, { scope: 'local', nodeId, ...options }),
  );
  const all = [host, ...locals];
  const hostPopulated = records.some(
    (server) => server.enabled && (server.kind === 'remote' || server.kind === 'home'),
  );
  return {
    ranker: spec,
    algorithm: spec.algorithm,
    coverageGate: spec.coverageGate,
    host,
    locals,
    scopes() {
      return [
        { label: 'host', catalog: host },
        ...locals.map((catalog) => ({ label: `local:${catalog.nodeLabel ?? 'unknown'}`, catalog })),
      ];
    },
    primary() {
      return hostPopulated ? host : (locals[0] ?? host);
    },
    all() {
      return all;
    },
    owner(toolId: string) {
      for (const catalog of all) {
        try {
          catalog.resolve(toolId);
          return catalog;
        } catch {
          // Not hosted by this catalog; try the next scope entry.
        }
      }
      return undefined;
    },
  };
}

// ── retrieval evaluation ──────────────────────────────────────────────────

export interface Aggregate {
  tasks: number;
  labeled: number;
  top1: number;
  recallAtK: number;
  mrr: number;
  negativeTasks: number;
  negativeCorrect: number;
}

export interface TaskOutcome {
  id: string;
  group: string;
  query: string;
  expected: string | null;
  split: 'main' | 'heldout';
  rank: number | null;
  top1: boolean;
  recallAtK: boolean;
  reciprocalRank: number;
  noMatch: boolean;
  matched: boolean;
  missingLabel: boolean;
}

export interface RetrievalReport {
  algorithm: RankerId;
  coverageGate: boolean;
  k: number;
  denominator: number;
  labeled: number;
  missingLabels: string[];
  overall: Aggregate;
  groups: Record<string, Aggregate>;
  dev: Aggregate;
  heldout: Aggregate;
  outcomes: TaskOutcome[];
}

export function findMatches(result: CallToolResult): string[] {
  const data = result.structuredContent as { matches?: Array<{ tool?: unknown }> } | undefined;
  const matches = data?.matches ?? [];
  return matches
    .map((match) => match.tool)
    .filter((tool): tool is string => typeof tool === 'string');
}

function aggregate(outcomes: TaskOutcome[]): Aggregate {
  const labeled = outcomes.filter((outcome) => outcome.expected !== null);
  const negatives = outcomes.filter((outcome) => outcome.expected === null);
  const mrr =
    labeled.length === 0
      ? 0
      : labeled.reduce((sum, outcome) => sum + outcome.reciprocalRank, 0) / labeled.length;
  return {
    tasks: outcomes.length,
    labeled: labeled.length,
    top1: labeled.filter((outcome) => outcome.top1).length,
    recallAtK: labeled.filter((outcome) => outcome.recallAtK).length,
    mrr,
    negativeTasks: negatives.length,
    negativeCorrect: negatives.filter((outcome) => outcome.noMatch).length,
  };
}

/** Deterministic 50/50 diagnostic split; nothing is trained, so there is no leakage risk. */
export function isHeldout(taskId: string): boolean {
  const digest = fingerprint(taskId);
  return Number.parseInt(digest.slice(0, 2), 16) % 2 === 1;
}

export function evaluateRetrieval(
  view: CatalogView,
  tasks: BenchmarkTask[],
  options: { k?: number } = {},
): RetrievalReport {
  const k = options.k ?? 5;
  const outcomes: TaskOutcome[] = [];
  const missingLabels: string[] = [];
  const explicitSplit = tasks.some((task) => task.split !== undefined);

  for (const task of tasks) {
    const owner = task.expected === null ? undefined : view.owner(task.expected);
    const searchCatalogs = task.expected === null ? view.all() : [owner ?? view.host];
    const matched = new Set<string>();
    for (const catalog of searchCatalogs) {
      const result = catalog.search({ action: 'find', query: task.query, limit: Math.max(k, 10) });
      for (const tool of findMatches(result)) matched.add(tool);
    }

    const missingLabel = task.expected !== null && owner === undefined;
    if (missingLabel) missingLabels.push(task.id);
    const ranked = [...matched];
    const index = task.expected === null ? -1 : ranked.indexOf(task.expected);
    const rank = index >= 0 ? index + 1 : null;
    const heldout = explicitSplit ? task.split === 'heldout' : isHeldout(task.id);
    outcomes.push({
      id: task.id,
      group: task.group,
      query: task.query,
      expected: task.expected,
      split: heldout ? 'heldout' : 'main',
      rank,
      top1: rank === 1,
      recallAtK: rank !== null && rank <= k,
      reciprocalRank: rank === null ? 0 : 1 / rank,
      noMatch: task.expected === null && matched.size === 0,
      matched: matched.size > 0,
      missingLabel,
    });
  }

  const groups: Record<string, Aggregate> = {};
  for (const group of [...new Set(tasks.map((task) => task.group))].sort()) {
    groups[group] = aggregate(outcomes.filter((outcome) => outcome.group === group));
  }
  return {
    algorithm: view.ranker.id,
    coverageGate: view.coverageGate,
    k,
    denominator: tasks.length,
    labeled: outcomes.filter((outcome) => outcome.expected !== null && !outcome.missingLabel)
      .length,
    missingLabels,
    overall: aggregate(outcomes.filter((outcome) => !outcome.missingLabel)),
    groups,
    dev: aggregate(outcomes.filter((outcome) => outcome.split === 'main')),
    heldout: aggregate(outcomes.filter((outcome) => outcome.split === 'heldout')),
    outcomes,
  };
}

// ── robustness evaluation ─────────────────────────────────────────────────

export interface RobustnessOutcome {
  id: string;
  outcome: 'match' | 'no-match';
  passed: boolean;
  skipped: boolean;
  reason?: string;
  rank: number | null;
}

export interface RobustnessReport {
  algorithm: RankerId;
  coverageGate: boolean;
  applied: number;
  skipped: number;
  passed: number;
  failed: string[];
  results: RobustnessOutcome[];
}

export function evaluateRobustness(
  views: { plain: CatalogView; duplicate?: CatalogView },
  inputs: BenchmarkRobustness[],
): RobustnessReport {
  const results: RobustnessOutcome[] = [];
  for (const input of inputs) {
    const view = input.requiresDuplicateProvider ? views.duplicate : views.plain;
    if (!view) {
      results.push({
        id: input.id,
        outcome: input.outcome,
        passed: false,
        skipped: true,
        reason: 'requires a duplicate-provider corpus that was not built',
        rank: null,
      });
      continue;
    }
    const owner = input.expected === undefined ? undefined : view.owner(input.expected);
    const catalogs = input.outcome === 'no-match' ? view.all() : [owner ?? view.host];
    const matched = new Set<string>();
    for (const catalog of catalogs) {
      const result = catalog.search({
        action: 'find',
        query: input.query,
        limit: Math.max(input.topK ?? 1, 10),
      });
      for (const tool of findMatches(result)) matched.add(tool);
    }
    if (input.outcome === 'no-match') {
      results.push({
        id: input.id,
        outcome: input.outcome,
        passed: matched.size === 0,
        skipped: false,
        rank: null,
      });
      continue;
    }
    const ranked = [...matched];
    const index = input.expected === undefined ? -1 : ranked.indexOf(input.expected);
    const rank = index >= 0 ? index + 1 : null;
    results.push({
      id: input.id,
      outcome: input.outcome,
      passed: rank !== null && rank <= (input.topK ?? 1),
      skipped: false,
      rank,
    });
  }
  const applied = results.filter((result) => !result.skipped);
  return {
    algorithm: views.plain.ranker.id,
    coverageGate: views.plain.coverageGate,
    applied: applied.length,
    skipped: results.length - applied.length,
    passed: applied.filter((result) => result.passed).length,
    failed: applied.filter((result) => !result.passed).map((result) => result.id),
    results,
  };
}

// ── latency ───────────────────────────────────────────────────────────────

export interface LatencyStats {
  samples: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface LatencyReport {
  algorithm: RankAlgorithm;
  queries: number;
  warmupIterations: number;
  warmIterations: number;
  cold: LatencyStats;
  warm: LatencyStats;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function stats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    samples: sorted.length,
    meanMs: sorted.length === 0 ? 0 : total / sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
  };
}

function timeFind(catalog: ToolCatalog, query: string): number {
  const started = performance.now();
  catalog.search({ action: 'find', query });
  return performance.now() - started;
}

export function measureLatency(
  view: CatalogView,
  queries: string[],
  options: { warmupIterations?: number; warmIterations?: number } = {},
): LatencyReport {
  const warmupIterations = options.warmupIterations ?? 200;
  const warmIterations = options.warmIterations ?? 1_000;
  const pool = queries.length > 0 ? queries : ['search repositories'];
  const catalog = view.primary();

  const cold: number[] = [];
  for (const query of pool) cold.push(timeFind(catalog, query));
  for (let index = 0; index < warmupIterations; index += 1) {
    timeFind(catalog, pool[index % pool.length]!);
  }
  const warm: number[] = [];
  for (let index = 0; index < warmIterations; index += 1) {
    warm.push(timeFind(catalog, pool[index % pool.length]!));
  }
  return {
    algorithm: view.algorithm,
    queries: pool.length,
    warmupIterations,
    warmIterations,
    cold: stats(cold),
    warm: stats(warm),
  };
}

// ── fixed-tool token counting ─────────────────────────────────────────────

export interface PythonRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type PythonRunner = (
  executable: string,
  script: string,
  stdin: string,
) => Promise<PythonRunResult>;

const TIKTOKEN_SCRIPT = [
  'import json, sys, platform',
  'try:',
  '    import tiktoken',
  'except Exception as exc:',
  '    print(json.dumps({"ok": False, "error": "tiktoken not importable: %s" % exc}))',
  '    sys.exit(0)',
  'data = json.load(sys.stdin)',
  'out = {"ok": True, "python": platform.python_version(),',
  '       "tiktoken": getattr(tiktoken, "__version__", "unknown"), "encodings": {}}',
  'for name in data.get("encodings", []):',
  '    enc = tiktoken.get_encoding(name)',
  '    out["encodings"][name] = {"perText": [len(enc.encode(t)) for t in data.get("texts", [])]}',
  'print(json.dumps(out))',
].join('\n');

export async function runPython(
  executable: string,
  script: string,
  stdin: string,
): Promise<PythonRunResult> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      // `executable` may be a wrapper command (e.g. `uv run --with tiktoken python`);
      // split on whitespace so callers never need a shell.
      const [command, ...prefix] = executable.trim().split(/\s+/);
      child = spawn(command ?? '', [...prefix, '-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolvePromise({ code: -1, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

export interface FixedToolTokenCount {
  status: 'ok' | 'blocked';
  tokenizers: { name: string; modelHint: string }[];
  perTool?: Record<string, Record<string, number>>;
  total?: Record<string, number>;
  tiktokenVersion?: string;
  pythonVersion?: string;
  reason?: string;
  /** Shipped deterministic byte/4 estimate, always reported separately. */
  estimate: number;
}

export async function countFixedToolTokens(
  options: { pythonBin?: string; runner?: PythonRunner; enabled?: boolean } = {},
): Promise<FixedToolTokenCount> {
  const tools = compactTools();
  const texts = [...tools.map((tool) => JSON.stringify(tool)), JSON.stringify(tools)];
  const estimate = estimateCompactToolsTokens();
  if (options.enabled === false) {
    return {
      status: 'blocked',
      tokenizers: [...ACTUAL_TOKENIZERS],
      reason: 'token counting disabled by --no-tokens',
      estimate,
    };
  }
  const executable = options.pythonBin ?? process.env.TIKTOKEN_PYTHON ?? 'python3';
  const runner = options.runner ?? runPython;
  const stdin = JSON.stringify({
    encodings: ACTUAL_TOKENIZERS.map((tokenizer) => tokenizer.name),
    texts,
  });
  const run = await runner(executable, TIKTOKEN_SCRIPT, stdin);
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(run.stdout.trim().split('\n').pop() ?? ''));
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.ok !== true) {
    const detail =
      (typeof parsed?.error === 'string' && parsed.error) ||
      run.stderr.trim() ||
      `python exited with code ${run.code}`;
    return {
      status: 'blocked',
      tokenizers: [...ACTUAL_TOKENIZERS],
      reason: `tiktoken unavailable via ${executable}: ${detail}`,
      estimate,
    };
  }
  const encodings = asRecord(parsed.encodings);
  if (!encodings) {
    return {
      status: 'blocked',
      tokenizers: [...ACTUAL_TOKENIZERS],
      reason: 'tiktoken returned no encodings',
      estimate,
    };
  }
  const perTool: Record<string, Record<string, number>> = {};
  const total: Record<string, number> = {};
  for (const tokenizer of ACTUAL_TOKENIZERS) {
    const entry = asRecord(encodings[tokenizer.name]);
    const perText = Array.isArray(entry?.perText) ? (entry!.perText as number[]) : [];
    tools.forEach((tool, index) => {
      const counts = perTool[tool.name] ?? {};
      counts[tokenizer.name] = perText[index] ?? 0;
      perTool[tool.name] = counts;
    });
    total[tokenizer.name] = perText[tools.length] ?? 0;
  }
  return {
    status: 'ok',
    tokenizers: [...ACTUAL_TOKENIZERS],
    ...(typeof parsed.tiktoken === 'string' ? { tiktokenVersion: parsed.tiktoken } : {}),
    ...(typeof parsed.python === 'string' ? { pythonVersion: parsed.python } : {}),
    perTool,
    total,
    estimate,
  };
}

// ── environment + fingerprints ────────────────────────────────────────────

export interface EnvironmentFingerprint {
  node: string;
  platform: string;
  arch: string;
  osType: string;
  osRelease: string;
  hostname: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
  measuredAt: string;
}

export function collectEnvironment(): EnvironmentFingerprint {
  return {
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    osType: os.type(),
    osRelease: os.release(),
    hostname: os.hostname(),
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    measuredAt: new Date().toISOString(),
  };
}

export interface CatalogFingerprintScope {
  scope: string;
  catalogVersion: string;
  servers: { server: string; catalog: string; visibleTools: number | null }[];
}

export interface CatalogFingerprints {
  /** Combined hash of every scope's `catalogVersion`. */
  catalogVersion: string;
  contentFingerprint: string;
  fixedToolsFingerprint: string;
  scopes: CatalogFingerprintScope[];
}

/** Host and local scopes are reported together; a pure-node catalog has an empty host. */
export function catalogFingerprints(view: CatalogView): CatalogFingerprints {
  const scopes = view.scopes().map(({ label, catalog }) => {
    const result = catalog.search({ action: 'servers' });
    const data = result.structuredContent as {
      catalogVersion?: unknown;
      servers?: Array<{ server?: unknown; catalog?: unknown; visibleTools?: unknown }>;
    };
    return {
      scope: label,
      catalogVersion: typeof data.catalogVersion === 'string' ? data.catalogVersion : 'unknown',
      servers: (data.servers ?? []).map((entry) => ({
        server: typeof entry.server === 'string' ? entry.server : 'unknown',
        catalog: typeof entry.catalog === 'string' ? entry.catalog : 'unknown',
        visibleTools: typeof entry.visibleTools === 'number' ? entry.visibleTools : null,
      })),
    };
  });
  const catalogVersion = fingerprint(scopes.map((scope) => scope.catalogVersion));
  return {
    catalogVersion,
    contentFingerprint: fingerprint({
      algorithm: view.algorithm,
      coverageGate: view.coverageGate,
      scopes,
    }),
    fixedToolsFingerprint: fingerprint(compactTools()),
    scopes,
  };
}

// ── describe inventory ────────────────────────────────────────────────────

export interface DescribeInventoryEntry {
  scope: string;
  tool: string;
  bytes: number;
  ok: boolean;
  code?: string;
  findNeedsDescribe: boolean;
  findDefinitionTooLarge: boolean;
  findOversizedSingle: boolean;
}

export interface DescribeInventoryReport {
  total: number;
  describeErrors: number;
  definitionTooLarge: number;
  findNeedsDescribe: number;
  findDefinitionTooLarge: number;
  findOversizedSingle: boolean | null;
  bytes: { min: number; p50: number; p95: number; max: number };
  scopes: { scope: string; total: number; definitionTooLarge: number }[];
}

/**
 * Counts describe/definition budget outcomes for every visible tool in every
 * scope, using only `catalog.search` (no upstream, no side effects).
 */
export function describeInventory(
  view: CatalogView,
  store: Store,
  projections: ToolProjectionService,
): DescribeInventoryReport {
  const entries: DescribeInventoryEntry[] = [];
  for (const { label, catalog } of view.scopes()) {
    for (const server of store.listServers()) {
      if (!catalog.hosts(server)) continue;
      const snapshot = store.getSnapshot(server.id);
      if (!snapshot) continue;
      for (const tool of projections.apply(server.id, snapshot.tools)) {
        const toolId = aggregateToolName(server.slug, tool.name);
        const describe = catalog.search({ action: 'describe', tool: toolId });
        const describeData = describe.structuredContent as { code?: unknown } | undefined;
        const ok = describe.isError !== true;
        const code = typeof describeData?.code === 'string' ? describeData.code : undefined;
        const find = catalog.search({
          action: 'find',
          query: tool.name,
          detail: 'definition',
          limit: 1,
        });
        const findData = find.structuredContent as
          | {
              matches?: Array<{
                needsDescribe?: unknown;
                definitionTooLarge?: unknown;
                oversizedSingle?: unknown;
              }>;
            }
          | undefined;
        const match = findData?.matches?.[0];
        entries.push({
          scope: label,
          tool: toolId,
          bytes: ok ? resultByteLength(describe) : 0,
          ok,
          ...(code === undefined ? {} : { code }),
          findNeedsDescribe: match?.needsDescribe === true,
          findDefinitionTooLarge: match?.definitionTooLarge === true,
          findOversizedSingle: match?.oversizedSingle === true,
        });
      }
    }
  }
  const bytes = entries
    .filter((entry) => entry.ok)
    .map((entry) => entry.bytes)
    .sort((left, right) => left - right);
  const scopes = [...new Set(entries.map((entry) => entry.scope))].map((scope) => {
    const scoped = entries.filter((entry) => entry.scope === scope);
    return {
      scope,
      total: scoped.length,
      definitionTooLarge: scoped.filter((entry) => entry.code === 'definition_too_large').length,
    };
  });
  return {
    total: entries.length,
    describeErrors: entries.filter((entry) => !entry.ok).length,
    definitionTooLarge: entries.filter((entry) => entry.code === 'definition_too_large').length,
    findNeedsDescribe: entries.filter((entry) => entry.findNeedsDescribe).length,
    findDefinitionTooLarge: entries.filter((entry) => entry.findDefinitionTooLarge).length,
    findOversizedSingle:
      entries.length === 0 ? null : entries.every((entry) => entry.findOversizedSingle),
    bytes: {
      min: bytes[0] ?? 0,
      p50: percentile(bytes, 50),
      p95: percentile(bytes, 95),
      max: bytes[bytes.length - 1] ?? 0,
    },
    scopes,
  };
}

// ── task-cost paired protocol ─────────────────────────────────────────────

export interface TaskTrace {
  taskId: string;
  kind: 'script' | 'agent';
  query: string;
  tool: string | null;
  latencyMs: number;
  resultBytes: number;
  error: string | null;
}

export interface TaskCostPair {
  taskId: string;
  script: TaskTrace;
  agent: TaskTrace | null;
}

export type SearchCaller = (arguments_: Record<string, unknown>) => Promise<CallToolResult>;

/**
 * Collects `search` traces from a real gateway caller. The caller is expected
 * to be a connected MCP `Client`; this only issues read-only `search` calls and
 * records complete traces labeled `script`.
 */
export async function collectScriptTraces(
  search: SearchCaller,
  tasks: BenchmarkTask[],
): Promise<TaskTrace[]> {
  const traces: TaskTrace[] = [];
  for (const task of tasks) {
    const started = performance.now();
    try {
      const result = await search({ action: 'find', query: task.query });
      traces.push({
        taskId: task.id,
        kind: 'script',
        query: task.query,
        tool: findMatches(result)[0] ?? null,
        latencyMs: performance.now() - started,
        resultBytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
        error: null,
      });
    } catch (error) {
      traces.push({
        taskId: task.id,
        kind: 'script',
        query: task.query,
        tool: null,
        latencyMs: performance.now() - started,
        resultBytes: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return traces;
}

/** Pairs script traces with parent-supplied real-agent traces, by task id. */
export function pairTaskCosts(script: TaskTrace[], agent: TaskTrace[]): TaskCostPair[] {
  const agentByTask = new Map(agent.map((trace) => [trace.taskId, trace]));
  return script.map((trace) => ({
    taskId: trace.taskId,
    script: trace,
    agent: agentByTask.get(trace.taskId) ?? null,
  }));
}

export interface AgentTraceSource {
  status: 'provided' | 'unavailable';
  reason?: string;
  traces: TaskTrace[];
}

/**
 * Loads parent-produced real-agent traces. The benchmark never drives a model
 * itself; without a trace file the agent side is reported `unavailable` rather
 * than fabricated.
 */
export function loadAgentTraces(path: string | undefined): AgentTraceSource {
  if (path === undefined) {
    return {
      status: 'unavailable',
      reason:
        'no --agent-trace provided; real-agent traces are produced by the parent (Grok availability is out of scope)',
      traces: [],
    };
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : (asRecord(parsed)?.traces as unknown[] | undefined);
  if (!Array.isArray(list)) throw new Error('agent trace file must be an array or {traces: []}');
  const traces = list.map((item) => {
    const trace = asRecord(item);
    if (!trace || typeof trace.taskId !== 'string') {
      throw new Error('agent trace entries require a string taskId');
    }
    return {
      taskId: trace.taskId,
      kind: 'agent' as const,
      query: typeof trace.query === 'string' ? trace.query : '',
      tool: typeof trace.tool === 'string' ? trace.tool : null,
      latencyMs: typeof trace.latencyMs === 'number' ? trace.latencyMs : 0,
      resultBytes: typeof trace.resultBytes === 'number' ? trace.resultBytes : 0,
      error: typeof trace.error === 'string' ? trace.error : null,
    };
  });
  return { status: 'provided', traces };
}

export interface GatewaySearchSession {
  listTools(): Promise<string[]>;
  search: SearchCaller;
  close(): Promise<void>;
}

/**
 * Connects to a real aggregate `/mcp` gateway with the shipped MCP `Client` and
 * exposes read-only `search`. No `exec`/write calls are ever issued.
 */
export async function connectGatewaySearch(options: {
  url: URL;
  accessKey: string;
  fetchImpl?: typeof fetch;
}): Promise<GatewaySearchSession> {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'toolhome-compact-benchmark', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(options.url, {
    requestInit: { headers: { authorization: `Bearer ${options.accessKey}` } },
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  });
  await client.connect(transport, { timeout: 10_000 });
  return {
    async listTools() {
      const result = await client.listTools();
      return result.tools.map((tool) => tool.name);
    },
    async search(arguments_) {
      return (await client.callTool({ name: 'search', arguments: arguments_ })) as CallToolResult;
    },
    async close() {
      await client.close();
    },
  };
}

// ── report assembly ───────────────────────────────────────────────────────

export interface BenchmarkReport {
  generatedAt: string;
  source: string;
  algorithms: RankerId[];
  tasks: { denominator: number; labeled: number; missingLabels: string[] };
  retrieval: RetrievalReport[];
  robustness: (RobustnessReport & { status: 'evaluated' | 'not-labeled' })[];
  /** Only shipped rankers are timed; the coverage baseline is not runtime code. */
  latency: LatencyReport[];
  describe: DescribeInventoryReport;
  tokens: FixedToolTokenCount;
  environment: EnvironmentFingerprint;
  fingerprints: Record<string, CatalogFingerprints>;
  taskCost?: {
    status: 'evaluated' | 'unavailable';
    reason?: string;
    pairs: TaskCostPair[];
  };
}

export interface BenchmarkOptions {
  catalogPath?: string;
  catalogFile?: CatalogFile;
  /** Explicit labeled tasks; overrides both the catalog file and the built-in fixture. */
  tasks?: BenchmarkTask[];
  /** Explicit robustness inputs; `null` reports `not-labeled`. */
  robustness?: BenchmarkRobustness[] | null;
  algorithms?: RankerId[];
  warmupIterations?: number;
  warmIterations?: number;
  pythonBin?: string;
  countTokens?: boolean;
  mcpUrl?: string;
  accessKey?: string;
  agentTracePath?: string;
  k?: number;
  log?: (line: string) => void;
}

export function mapRealTasks(tasks: RealTask[]): BenchmarkTask[] {
  return tasks.map((task) => ({
    id: task.id,
    query: task.query,
    expected: task.expected,
    group: task.group,
    split: task.split ?? 'main',
    note: task.note,
  }));
}

export function mapRealRobustness(inputs: RealRobustness[]): BenchmarkRobustness[] {
  return inputs.map((input) => ({
    id: input.id,
    query: input.query,
    outcome: input.outcome,
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    ...(input.topK === undefined ? {} : { topK: input.topK }),
    note: input.note,
  }));
}

/** Task sets selectable with `--tasks`; `real` and `real-local` target the exported catalogs. */
export const TASK_SETS: Record<
  string,
  { tasks: BenchmarkTask[]; robustness: BenchmarkRobustness[] }
> = {
  fixture: { tasks: fixtureTasks(), robustness: fixtureRobustness() },
  real: {
    tasks: mapRealTasks([...realHostTasks, ...realHostChinesePairing, ...realHostHeldout]),
    robustness: mapRealRobustness(realHostRobustness),
  },
  'real-local': {
    tasks: mapRealTasks(realLocalTasks),
    robustness: mapRealRobustness(realLocalRobustness),
  },
};

/** Resolves `--tasks`: a built-in preset name or a JSON file `{tasks, robustness}`. */
export function resolveTaskSet(
  name: string,
): { tasks: BenchmarkTask[]; robustness: BenchmarkRobustness[] } | undefined {
  const preset = TASK_SETS[name];
  if (preset) return preset;
  if (!name.endsWith('.json')) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(name, 'utf8'));
  const raw = Array.isArray(parsed) ? { tasks: parsed } : asRecord(parsed);
  if (!raw || !Array.isArray(raw.tasks)) {
    throw new Error('task file must be a task array or an object with a "tasks" array');
  }
  return {
    tasks: z.array(taskSchema).parse(raw.tasks) as BenchmarkTask[],
    robustness: Array.isArray(raw.robustness)
      ? (z.array(robustnessSchema).parse(raw.robustness) as BenchmarkRobustness[])
      : [],
  };
}

function fixtureTasks(): BenchmarkTask[] {
  return retrievalTasks.map((task) => ({
    id: task.id,
    query: task.query,
    expected: task.expected,
    group: task.group,
    note: task.note,
  }));
}

function fixtureRobustness(): BenchmarkRobustness[] {
  return robustnessInputs.map((input) => ({
    id: input.id,
    query: input.query,
    outcome: input.outcome,
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    ...(input.topK === undefined ? {} : { topK: input.topK }),
    ...(input.requiresDuplicateProvider === undefined
      ? {}
      : { requiresDuplicateProvider: input.requiresDuplicateProvider }),
    note: input.note,
  }));
}

export async function runBenchmark(options: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const algorithms = options.algorithms ?? ['field-score', 'bm25', 'coverage-baseline'];
  const catalogFile =
    options.catalogFile ?? (options.catalogPath ? loadCatalogFile(options.catalogPath) : undefined);
  const plain = catalogFile === undefined ? buildFixtureCorpus() : buildCatalogCorpus(catalogFile);
  const duplicate =
    catalogFile === undefined ? buildFixtureCorpus({ duplicateProvider: true }) : undefined;
  const log = options.log ?? (() => undefined);

  try {
    const tasks = options.tasks ?? catalogFile?.tasks ?? fixtureTasks();
    const robustness =
      options.tasks !== undefined
        ? (options.robustness ?? null)
        : (catalogFile?.robustness ?? (catalogFile === undefined ? fixtureRobustness() : null));

    const retrieval: RetrievalReport[] = [];
    const latency: LatencyReport[] = [];
    const robustnessReports: (RobustnessReport & { status: 'evaluated' | 'not-labeled' })[] = [];
    const fingerprints: Record<string, CatalogFingerprints> = {};
    const queries = tasks.map((task) => task.query);
    let describeView: CatalogView | undefined;

    for (const rankerId of algorithms) {
      const spec = RANKERS[rankerId];
      const view = buildCatalogView(plain.store, plain.projections, spec);
      describeView ??= view;
      log(
        `evaluating ${rankerId} (coverageGate=${String(spec.coverageGate)}) over ${tasks.length} ` +
          `labeled tasks (${plain.source}); denominator=${tasks.length}`,
      );
      retrieval.push(evaluateRetrieval(view, tasks, { k: options.k ?? 5 }));
      fingerprints[rankerId] = catalogFingerprints(view);
      if (robustness === null) {
        robustnessReports.push({
          algorithm: rankerId,
          coverageGate: spec.coverageGate,
          applied: 0,
          skipped: 0,
          passed: 0,
          failed: [],
          results: [],
          status: 'not-labeled',
        });
      } else {
        const duplicateView = duplicate
          ? buildCatalogView(duplicate.store, duplicate.projections, spec)
          : undefined;
        robustnessReports.push({
          ...evaluateRobustness(
            { plain: view, ...(duplicateView ? { duplicate: duplicateView } : {}) },
            robustness,
          ),
          status: 'evaluated',
        });
      }
      // The coverage baseline is a benchmark hypothetical, never runtime code,
      // so it is not timed.
      if (spec.coverageGate) {
        latency.push(
          measureLatency(view, queries, {
            ...(options.warmupIterations === undefined
              ? {}
              : { warmupIterations: options.warmupIterations }),
            ...(options.warmIterations === undefined
              ? {}
              : { warmIterations: options.warmIterations }),
          }),
        );
      }
    }

    const describe = describeView
      ? describeInventory(describeView, plain.store, plain.projections)
      : {
          total: 0,
          describeErrors: 0,
          definitionTooLarge: 0,
          findNeedsDescribe: 0,
          findDefinitionTooLarge: 0,
          findOversizedSingle: null,
          bytes: { min: 0, p50: 0, p95: 0, max: 0 },
          scopes: [],
        };
    log(
      `describe inventory: total=${describe.total} definitionTooLarge=${describe.definitionTooLarge} ` +
        `findNeedsDescribe=${describe.findNeedsDescribe} findDefinitionTooLarge=${describe.findDefinitionTooLarge}`,
    );

    const tokens = await countFixedToolTokens({
      ...(options.pythonBin === undefined ? {} : { pythonBin: options.pythonBin }),
      ...(options.countTokens === undefined ? {} : { enabled: options.countTokens }),
    });
    if (tokens.status === 'blocked') log(`tiktoken blocked: ${tokens.reason ?? 'unknown reason'}`);

    let taskCost: BenchmarkReport['taskCost'];
    if (options.mcpUrl !== undefined) {
      const session = await connectGatewaySearch({
        url: new URL(options.mcpUrl),
        accessKey: options.accessKey ?? '',
      });
      try {
        log(`collecting script traces from real gateway ${options.mcpUrl}`);
        const scriptTraces = await collectScriptTraces(session.search, tasks);
        const agent = loadAgentTraces(options.agentTracePath);
        taskCost = {
          status: agent.status === 'provided' ? 'evaluated' : 'unavailable',
          ...(agent.reason === undefined ? {} : { reason: agent.reason }),
          pairs: pairTaskCosts(scriptTraces, agent.traces),
        };
      } finally {
        await session.close();
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      source: plain.source,
      algorithms,
      tasks: {
        denominator: tasks.length,
        labeled: retrieval[0]?.labeled ?? 0,
        missingLabels: retrieval[0]?.missingLabels ?? [],
      },
      retrieval,
      robustness: robustnessReports,
      latency,
      describe,
      tokens,
      environment: collectEnvironment(),
      fingerprints,
      ...(taskCost === undefined ? {} : { taskCost }),
    };
  } finally {
    plain.close();
    duplicate?.close();
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

interface CliOptions {
  catalogPath?: string;
  exportCatalog?: boolean;
  dataDir?: string;
  sqlitePath?: string;
  controlUrl?: string;
  controlKeyEnv?: string;
  out?: string;
  tasks?: string;
  algorithms: RankerId[];
  warmupIterations: number;
  warmIterations: number;
  pythonBin?: string;
  countTokens: boolean;
  mcpUrl?: string;
  accessKeyEnv?: string;
  agentTracePath?: string;
  logPath?: string;
  help: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    algorithms: ['field-score', 'bm25', 'coverage-baseline'],
    warmupIterations: 200,
    warmIterations: 1_000,
    countTokens: true,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`missing value for ${flag ?? ''}`);
      index += 1;
      return next;
    };
    switch (flag) {
      case '--catalog':
        options.catalogPath = value();
        break;
      case '--export':
        options.exportCatalog = true;
        break;
      case '--data-dir':
        options.dataDir = value();
        break;
      case '--sqlite':
        options.sqlitePath = value();
        break;
      case '--control-url':
        options.controlUrl = value();
        break;
      case '--control-key-env':
        options.controlKeyEnv = value();
        break;
      case '--out':
        options.out = value();
        break;
      case '--tasks':
        options.tasks = value();
        break;
      case '--algorithm': {
        const selected = value();
        if (selected === 'both') options.algorithms = ['field-score', 'bm25'];
        else if (selected === 'all') {
          options.algorithms = ['field-score', 'bm25', 'coverage-baseline'];
        } else if (selected in RANKERS) options.algorithms = [selected as RankerId];
        else throw new Error(`unknown algorithm: ${selected}`);
        break;
      }
      case '--warmup':
        options.warmupIterations = Number(value());
        break;
      case '--warm':
        options.warmIterations = Number(value());
        break;
      case '--python':
        options.pythonBin = value();
        break;
      case '--no-tokens':
        options.countTokens = false;
        break;
      case '--mcp-url':
        options.mcpUrl = value();
        break;
      case '--access-key-env':
        options.accessKeyEnv = value();
        break;
      case '--agent-trace':
        options.agentTracePath = value();
        break;
      case '--log':
        options.logPath = value();
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag ?? ''}`);
    }
  }
  return options;
}

function appendLog(path: string | undefined, line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  if (path === undefined) {
    process.stderr.write(stamped);
    return;
  }
  try {
    mkdirSync(resolve(path, '..'), { recursive: true });
    appendFileSync(path, stamped);
  } catch {
    process.stderr.write(stamped);
  }
}

function writeOut(path: string | undefined, contents: string): void {
  if (path === undefined) {
    process.stdout.write(contents);
    return;
  }
  writeFileSync(path, contents);
}

function percent(part: number, total: number): string {
  return total === 0 ? 'n/a' : `${((part / total) * 100).toFixed(1)}%`;
}

export function formatSummary(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`compact benchmark — source=${report.source} generated=${report.generatedAt}`);
  lines.push(
    `tasks=${report.tasks.denominator} labeled=${report.tasks.labeled}` +
      (report.tasks.missingLabels.length > 0
        ? ` missingLabels=${report.tasks.missingLabels.length}`
        : ''),
  );
  for (const retrieval of report.retrieval) {
    lines.push(
      `  [${retrieval.algorithm}] top1=${percent(retrieval.overall.top1, retrieval.overall.labeled)}` +
        ` recall@${retrieval.k}=${percent(retrieval.overall.recallAtK, retrieval.overall.labeled)}` +
        ` mrr=${retrieval.overall.mrr.toFixed(3)}` +
        ` dev_mrr=${retrieval.dev.mrr.toFixed(3)}` +
        ` heldout=${retrieval.heldout.tasks === 0 ? 'none' : retrieval.heldout.mrr.toFixed(3)}`,
    );
    for (const [group, aggregate] of Object.entries(retrieval.groups)) {
      lines.push(
        `      ${group}: n=${aggregate.tasks} labeled=${aggregate.labeled}` +
          ` top1=${percent(aggregate.top1, aggregate.labeled)}` +
          ` negatives=${aggregate.negativeCorrect}/${aggregate.negativeTasks}`,
      );
    }
  }
  for (const robustness of report.robustness) {
    lines.push(
      `  [${robustness.algorithm}] robustness ${robustness.status}` +
        (robustness.status === 'evaluated'
          ? ` passed=${robustness.passed}/${robustness.applied} skipped=${robustness.skipped}` +
            (robustness.failed.length > 0 ? ` failed=${robustness.failed.join(',')}` : '')
          : ' (no labels supplied; denominator not evaluated)'),
    );
  }
  for (const latency of report.latency) {
    lines.push(
      `  [${latency.algorithm}] latency cold p95=${latency.cold.p95Ms.toFixed(3)}ms` +
        ` warm p50=${latency.warm.p50Ms.toFixed(3)}ms warm p95=${latency.warm.p95Ms.toFixed(3)}ms` +
        ` (warm=${latency.warm.samples} warmup=${latency.warmupIterations})`,
    );
  }
  lines.push(
    `  describe: total=${report.describe.total} tooLarge=${report.describe.definitionTooLarge}` +
      ` findNeedsDescribe=${report.describe.findNeedsDescribe}` +
      ` findDefinitionTooLarge=${report.describe.findDefinitionTooLarge}` +
      ` bytes(p50=${report.describe.bytes.p50} p95=${report.describe.bytes.p95} max=${report.describe.bytes.max})`,
  );
  lines.push(
    `  tokens: ${report.tokens.status}` +
      (report.tokens.status === 'ok'
        ? ` total=${JSON.stringify(report.tokens.total)}`
        : ` reason=${report.tokens.reason ?? ''}`) +
      ` estimate=${report.tokens.estimate}`,
  );
  lines.push(
    `  hardware: node=${report.environment.node} ${report.environment.platform}/${report.environment.arch}` +
      ` cpu="${report.environment.cpuModel}" cores=${report.environment.cpuCount}`,
  );
  const firstFingerprint = Object.values(report.fingerprints)[0];
  if (firstFingerprint) {
    lines.push(
      `  fingerprints: catalogVersion=${firstFingerprint.catalogVersion}` +
        ` content=${firstFingerprint.contentFingerprint.slice(0, 16)}` +
        ` fixedTools=${firstFingerprint.fixedToolsFingerprint.slice(0, 16)}`,
    );
  }
  if (report.taskCost) {
    lines.push(
      `  task-cost: ${report.taskCost.status}` +
        (report.taskCost.reason === undefined
          ? ` pairs=${report.taskCost.pairs.length}`
          : ` reason=${report.taskCost.reason}`),
    );
  }
  return `${lines.join('\n')}\n`;
}

function helpText(): string {
  return [
    'Usage: tsx scripts/benchmark-compact.ts [options]',
    '',
    'Corpus:',
    '  --catalog <path>        load a server/tool snapshot JSON',
    '  --data-dir <dir>        read <dir>/toolhome.sqlite read-only (fixture if omitted)',
    '  --sqlite <path>         read an explicit toolhome.sqlite read-only',
    '  --control-url <url>     read-only Control API export source',
    '  --control-key-env <var> env var holding the Control Key (never logged)',
    '  --export                export the sanitized catalog instead of benchmarking',
    '',
    'Tasks:',
    '  --tasks <name|path>     fixture (default), real, real-local, or a task JSON file',
    '',
    'Measurement:',
    '  --algorithm <name>      field-score | bm25 | coverage-baseline | both | all',
    '                          (default all; coverage-baseline is field-score without the gate)',
    '  --warmup <n>            discarded warmup finds (default 200)',
    '  --warm <n>              measured warm finds (default 1000)',
    '  --python <cmd>          python for tiktoken; accepts a wrapper such as',
    '                          "uv run --with tiktoken python" (default python3)',
    '  --no-tokens             skip token counting (reported blocked, no fake numbers)',
    '  --out <path>            write the JSON report (default stdout)',
    '  --log <path>            append log file (default stderr)',
    '',
    'Task cost (read-only Client against a real gateway):',
    '  --mcp-url <url>         aggregate /mcp endpoint',
    '  --access-key-env <var>  env var holding the MCP Access Key',
    '  --agent-trace <path>    parent-produced real-agent traces to pair',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  const log = (line: string): void => appendLog(options.logPath, line);
  log(`run start argv=${process.argv.slice(2).join(' ')}`);
  const taskSet = options.tasks === undefined ? undefined : resolveTaskSet(options.tasks);
  if (options.tasks !== undefined && taskSet === undefined) {
    throw new Error(
      `unknown --tasks ${options.tasks}; expected fixture, real, real-local, or a task JSON`,
    );
  }

  if (options.exportCatalog) {
    let file: CatalogFile;
    if (options.controlUrl !== undefined) {
      const keyEnv = options.controlKeyEnv ?? 'TOOLHOME_CONTROL_KEY';
      const controlKey = process.env[keyEnv];
      if (!controlKey) throw new Error(`env ${keyEnv} is not set`);
      file = await exportCatalogFromControl({ url: new URL(options.controlUrl), controlKey });
    } else {
      const sqlitePath =
        options.sqlitePath ??
        (options.dataDir !== undefined
          ? join(resolve(options.dataDir), 'toolhome.sqlite')
          : undefined);
      if (sqlitePath === undefined) {
        throw new Error('--export needs --sqlite, --data-dir, or --control-url');
      }
      if (!existsSync(sqlitePath)) throw new Error(`sqlite file not found: ${sqlitePath}`);
      file = await exportCatalogFromSqlite(sqlitePath);
    }
    writeOut(options.out, `${JSON.stringify(file, null, 2)}\n`);
    log(`exported ${file.servers.length} servers from ${file.source}`);
    return;
  }

  let catalogFile: CatalogFile | undefined;
  if (options.catalogPath !== undefined) {
    catalogFile = loadCatalogFile(options.catalogPath);
  } else if (options.sqlitePath !== undefined || options.dataDir !== undefined) {
    const sqlitePath =
      options.sqlitePath ?? join(resolve(options.dataDir as string), 'toolhome.sqlite');
    if (!existsSync(sqlitePath)) throw new Error(`sqlite file not found: ${sqlitePath}`);
    catalogFile = await exportCatalogFromSqlite(sqlitePath);
  }

  const report = await runBenchmark({
    ...(catalogFile === undefined ? {} : { catalogFile }),
    ...(taskSet === undefined ? {} : { tasks: taskSet.tasks, robustness: taskSet.robustness }),
    algorithms: options.algorithms,
    warmupIterations: options.warmupIterations,
    warmIterations: options.warmIterations,
    ...(options.pythonBin === undefined ? {} : { pythonBin: options.pythonBin }),
    countTokens: options.countTokens,
    ...(options.mcpUrl === undefined ? {} : { mcpUrl: options.mcpUrl }),
    ...(options.accessKeyEnv === undefined
      ? {}
      : { accessKey: process.env[options.accessKeyEnv] ?? '' }),
    ...(options.agentTracePath === undefined ? {} : { agentTracePath: options.agentTracePath }),
    log,
  });
  writeOut(options.out, `${JSON.stringify(report, null, 2)}\n`);
  if (options.out !== undefined) process.stdout.write(formatSummary(report));
  log(`run complete source=${report.source}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
