import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { isHostHosted, type CapabilitySnapshot, type ServerRecord } from '../domain/models.js';
import type { Store } from '../storage/store.js';
import { fingerprint } from '../upstream/stable-json.js';
import {
  COMPACT_BUDGETS,
  CompactError,
  DEFAULT_RANK_ALGORITHM,
  appResourceUri,
  compactErrorResult,
  definitionTooLargeError,
  executionBoundaryForTool,
  invalidCursorError,
  jsonToolResult,
  parseSearchArgs,
  resultByteLength,
  unknownServerError,
  unknownToolError,
  type RankAlgorithm,
  type SearchArgs,
} from './compact-protocol.js';
import { compactContractFingerprint } from './compact-state.js';
import type { RegistryEntry } from './registry.js';
import { ToolProjectionService } from './projection.js';
import { aggregateToolName } from './virtualization.js';

export type { RankAlgorithm } from './compact-protocol.js';

export type CatalogScope = 'host' | 'local';

export interface ToolCatalogOptions {
  /** Which entry this catalog serves: the host's remote/home servers or this machine's nodes. */
  scope?: CatalogScope;
  /** Node label; required for `scope: 'local'` and used as the directory label. */
  nodeId?: string;
  /** Optional override for the scope predicate, mirroring UpstreamManager's `canHost`. */
  hosts?: (server: ServerRecord) => boolean;
  /** Scorer for `find`; both rankers use the same fields and coverage gate. */
  rankAlgorithm?: RankAlgorithm;
  /**
   * When false, `find` skips the multi-token coverage gate and ranks every
   * candidate by score alone. Benchmark-only baseline; the runtime default is
   * true, so shipped discovery never changes.
   */
  coverageGate?: boolean;
}

/** Prefers an exec-observed complete contract over the stored snapshot. */
export type ObservedToolLookup = (tool: string) => { serverId: string; tool: Tool } | undefined;

export interface ResolvedTool {
  entry: RegistryEntry;
  tool: Tool;
}

/** Versioned field weights for the deterministic field-score ranker. */
export const FIELD_WEIGHTS = {
  name: 10,
  title: 8,
  server: 6,
  description: 5,
  parameters: 2,
} as const;

/** Minimum distinct meaningful query tokens that must hit for a multi-word task. */
export const MIN_COVERED_TOKENS = 2;
export const MIN_COVERAGE_RATIO = 0.5;

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'for',
  'with',
  'and',
  'or',
  'to',
  'in',
  'on',
  'at',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'this',
  'that',
  'these',
  'those',
  'my',
  'your',
  'our',
  'their',
  'its',
  'it',
  'as',
  'please',
  'can',
  'could',
  'would',
  'should',
  'do',
  'does',
  'did',
  'i',
  'me',
  'we',
  'you',
  'they',
  'he',
  'she',
  'will',
  'just',
  'about',
  'into',
  'over',
  'after',
  'before',
  'up',
  'down',
  'out',
  'than',
  'then',
  'so',
  'if',
  'but',
  'not',
  'no',
  'some',
  'any',
  'all',
  'using',
  'use',
]);

/**
 * Snapshot-only tool directory for the compact surface.
 *
 * All three discovery actions read the local Store and never connect to an
 * upstream: candidates come from stored capability snapshots, filtered by the
 * same scope predicate and visibility projection as the host's runtime.
 */
export class ToolCatalog {
  readonly #store: Store;
  readonly #projections: ToolProjectionService;
  readonly #scope: CatalogScope;
  readonly #nodeId: string | undefined;
  readonly #predicate: (server: ServerRecord) => boolean;
  readonly #rankAlgorithm: RankAlgorithm;
  readonly #coverageGate: boolean;

  constructor(store: Store, projections: ToolProjectionService, options: ToolCatalogOptions = {}) {
    this.#store = store;
    this.#projections = projections;
    this.#scope = options.scope ?? 'host';
    this.#nodeId = options.nodeId;
    this.#rankAlgorithm = options.rankAlgorithm ?? DEFAULT_RANK_ALGORITHM;
    this.#coverageGate = options.coverageGate ?? true;
    if (this.#scope === 'local' && options.nodeId === undefined && options.hosts === undefined) {
      throw new Error('local scope requires a nodeId label');
    }
    const scope = this.#scope;
    const nodeId = this.#nodeId;
    this.#predicate =
      options.hosts ??
      ((server) => {
        if (scope === 'host') return isHostHosted(server.kind);
        return server.kind === 'node' && server.nodeId === nodeId;
      });
  }

  get scope(): CatalogScope {
    return this.#scope;
  }

  get nodeLabel(): string | undefined {
    return this.#nodeId;
  }

  get rankAlgorithm(): RankAlgorithm {
    return this.#rankAlgorithm;
  }

  get coverageGate(): boolean {
    return this.#coverageGate;
  }

  /** Whether this entry owns and may advertise the server. */
  hosts(server: ServerRecord): boolean {
    return server.enabled && this.#predicate(server);
  }

  /**
   * Run a discovery action. `observed` lets describe prefer an exec-observed
   * complete contract without any network request.
   */
  search(input: unknown, observed?: ObservedToolLookup): CallToolResult {
    try {
      const args = parseSearchArgs(input);
      if (args.action === 'servers') return jsonToolResult(this.#servers(args));
      if (args.action === 'find') return jsonToolResult(this.#find(args));
      return jsonToolResult(this.#describe(args, observed));
    } catch (error) {
      if (CompactError.isInstance(error)) return compactErrorResult(error);
      const message = error instanceof Error ? error.message : String(error);
      return compactErrorResult(
        new CompactError('catalog_unavailable', message, { details: { reason: message } }),
      );
    }
  }

  /** Exact identity lookup against the same scope/visibility boundary as search. */
  resolve(tool: string, observed?: ObservedToolLookup): ResolvedTool {
    const records = this.#hostedRecords();
    if (observed) {
      const hit = observed(tool);
      if (hit) {
        const server = records.find((candidate) => candidate.id === hit.serverId);
        const snapshot = server ? this.#store.getSnapshot(server.id) : null;
        if (
          server &&
          snapshot &&
          this.#projections.isVisible(server.id, hit.tool.name) &&
          aggregateToolName(server.slug, hit.tool.name) === tool
        ) {
          return { entry: { server, snapshot }, tool: hit.tool };
        }
      }
    }
    for (const server of records) {
      const snapshot = this.#store.getSnapshot(server.id);
      if (!snapshot) continue;
      const found = snapshot.tools.find(
        (candidate) =>
          this.#projections.isVisible(server.id, candidate.name) &&
          aggregateToolName(server.slug, candidate.name) === tool,
      );
      if (found) return { entry: { server, snapshot }, tool: found };
    }
    throw unknownToolError(tool);
  }

  // ── servers ─────────────────────────────────────────────────────────────

  #servers(args: SearchArgs): Record<string, unknown> {
    const version = this.#catalogVersion();
    const entries = this.#hostedRecords().map((server) => this.#serverEntry(server));
    // A snapshot whose tools are all hidden must not leak hidden capability.
    const visible = entries.filter(
      (entry) => entry.catalog === 'unindexed' || (entry.visibleTools ?? 0) > 0,
    );
    let offset = 0;
    if (args.cursor !== undefined) {
      const decoded = decodeCursor(args.cursor);
      if (!decoded || decoded.version !== version) throw invalidCursorError();
      offset = decoded.offset;
    }
    const page = visible.slice(offset, offset + args.limit);
    const build = (items: typeof page): Record<string, unknown> => ({
      kind: 'servers',
      scope: this.#scope,
      ...(this.#scope === 'local' ? { nodeLabel: this.#nodeId } : {}),
      servers: items,
      total: visible.length,
      hasMore: offset + items.length < visible.length,
      nextCursor:
        offset + items.length < visible.length
          ? encodeCursor(offset + items.length, version)
          : null,
      catalogVersion: version,
    });
    let items = page;
    while (items.length > 1 && this.#overBudget(build(items), COMPACT_BUDGETS.serversBytes)) {
      items = items.slice(0, -1);
    }
    return build(items);
  }

  #serverEntry(server: ServerRecord): {
    server: string;
    name: string;
    visibleTools: number | null;
    catalog: 'indexed' | 'unindexed';
    lastKnownStatus: string;
  } {
    const snapshot = this.#store.getSnapshot(server.id);
    const status = this.#store.getRuntimeState(server.id)?.status ?? 'unknown';
    if (!snapshot) {
      return {
        server: server.slug,
        name: server.name,
        visibleTools: null,
        catalog: 'unindexed',
        lastKnownStatus: status,
      };
    }
    return {
      server: server.slug,
      name: server.name,
      visibleTools: this.#visibleTools(server, snapshot).length,
      catalog: 'indexed',
      lastKnownStatus: status,
    };
  }

  // ── find ────────────────────────────────────────────────────────────────

  #find(args: SearchArgs): Record<string, unknown> {
    const version = this.#catalogVersion();
    const records = this.#hostedRecords();
    const versionFields = {
      kind: 'matches',
      scope: this.#scope,
      ...(this.#scope === 'local' ? { nodeLabel: this.#nodeId } : {}),
      rankedBy: this.#rankAlgorithm,
    };

    let scoped = records;
    if (args.server !== undefined) {
      const server = records.find((candidate) => candidate.slug === args.server);
      if (!server) throw unknownServerError(args.server);
      scoped = [server];
    }

    const unindexedServers = scoped
      .filter((server) => this.#store.getSnapshot(server.id) === null)
      .map((server) => server.slug);

    const query = args.query ?? '';
    const queryTokens = tokenizeQuery(query);
    const phrase = normalizeForPhrase(query);
    const scored: ScoredTool[] = [];

    if (queryTokens.length > 0) {
      const docs: CandidateDoc[] = [];
      for (const server of scoped) {
        const snapshot = this.#store.getSnapshot(server.id);
        if (!snapshot) continue;
        for (const tool of this.#visibleTools(server, snapshot)) {
          docs.push({
            entry: { server, snapshot },
            server,
            tool,
            id: aggregateToolName(server.slug, tool.name),
          });
        }
      }
      const corpus = this.#rankAlgorithm === 'bm25' ? buildCorpus(docs) : null;
      for (const doc of docs) {
        if (query === doc.id) {
          scored.push({ ...doc, tier: 0, score: Infinity, matchedOn: ['tool'] });
          continue;
        }
        if (query === doc.tool.name) {
          scored.push({ ...doc, tier: 1, score: Infinity, matchedOn: ['name'] });
          continue;
        }
        const ranked = scoreTool(
          doc.server,
          doc.tool,
          queryTokens,
          phrase,
          corpus,
          this.#coverageGate,
        );
        if (ranked !== null)
          scored.push({
            ...doc,
            tier: ranked.tier,
            score: ranked.score,
            matchedOn: ranked.matchedOn,
          });
      }
    }

    scored.sort(
      (left, right) =>
        left.tier - right.tier || right.score - left.score || left.id.localeCompare(right.id),
    );
    const gated = scored.slice(0, args.limit);
    const definitionMode = args.detail === 'definition';

    const build = (
      matches: Record<string, unknown>[],
      hasMore: boolean,
    ): Record<string, unknown> => ({
      ...versionFields,
      matches,
      hasMore,
      ...(unindexedServers.length === 0 ? {} : { unindexedServers }),
      ...(matches.length === 0
        ? {
            guidance:
              'No snapshot match. Try English action/object keywords, action=servers, or a more specific task.',
          }
        : {}),
      catalogVersion: version,
    });

    const matches: Record<string, unknown>[] = [];
    let truncated = false;
    const budget = definitionMode
      ? COMPACT_BUDGETS.findDefinitionBytes
      : COMPACT_BUDGETS.findSummaryBytes;
    for (const candidate of gated) {
      let match = this.#matchSummary(candidate);
      if (definitionMode) {
        const full = this.#matchDefinition(candidate);
        if (this.#overBudget(build([...matches, full], true), budget)) {
          const single = this.#overBudget(build([full], true), COMPACT_BUDGETS.findDefinitionBytes);
          match = {
            ...this.#matchSummary(candidate),
            needsDescribe: true,
            ...(single ? { definitionTooLarge: true } : {}),
          };
        } else {
          match = full;
        }
      }
      if (this.#overBudget(build([...matches, match], true), budget)) {
        truncated = true;
        break;
      }
      matches.push(match);
    }

    const hasMore = truncated || scored.length > matches.length;
    return build(matches, hasMore);
  }

  #matchSummary(candidate: ScoredTool): Record<string, unknown> {
    const summary = summarize(candidate.tool.description);
    const annotations = smallAnnotations(candidate.tool);
    const execution = this.#executionFor(candidate.entry, candidate.tool);
    return {
      tool: candidate.id,
      server: candidate.entry.server.slug,
      name: candidate.tool.name,
      summary: summary.text,
      ...(summary.truncated ? { summaryTruncated: true } : {}),
      matchedOn: candidate.matchedOn,
      execution,
      ...(execution === 'individualEndpoint'
        ? { guidance: this.#endpointGuidance(candidate.entry.server) }
        : {}),
      ...(annotations === null ? {} : { annotations }),
    };
  }

  #matchDefinition(candidate: ScoredTool): Record<string, unknown> {
    const annotations = smallAnnotations(candidate.tool);
    const app = appResourceUri(candidate.tool);
    const taskSupport = candidate.tool.execution?.taskSupport;
    return {
      ...this.#matchSummary(candidate),
      definition: compactContractFingerprint(
        candidate.tool,
        candidate.entry.snapshot.instructions ?? undefined,
      ),
      description: candidate.tool.description ?? '',
      inputSchema: candidate.tool.inputSchema,
      ...(annotations === null ? {} : { annotations }),
      ...(taskSupport === undefined ? {} : { taskSupport }),
      ...(app === null ? {} : { app: { resourceUri: app } }),
    };
  }

  // ── describe ────────────────────────────────────────────────────────────

  #describe(args: SearchArgs, observed?: ObservedToolLookup): Record<string, unknown> {
    const tool = args.tool ?? '';
    const resolved = this.resolve(tool, observed);
    const { entry, tool: contract } = resolved;
    const snapshot = entry.snapshot;
    const annotations = smallAnnotations(contract);
    const app = appResourceUri(contract);
    const taskSupport = contract.execution?.taskSupport;
    const execution = this.#executionFor(entry, contract);
    const payload: Record<string, unknown> = {
      kind: 'definition',
      scope: this.#scope,
      ...(this.#scope === 'local' ? { nodeLabel: this.#nodeId } : {}),
      tool,
      server: entry.server.slug,
      name: contract.name,
      definition: compactContractFingerprint(contract, snapshot.instructions ?? undefined),
      description: contract.description ?? '',
      inputSchema: contract.inputSchema,
      ...(annotations === null ? {} : { annotations }),
      execution,
      ...(execution === 'individualEndpoint'
        ? { guidance: this.#endpointGuidance(entry.server) }
        : {}),
      ...(taskSupport === undefined ? {} : { taskSupport }),
      ...(app === null ? {} : { app: { resourceUri: app } }),
      ...(snapshot.instructions === null ? {} : { upstreamInstructions: snapshot.instructions }),
    };
    const bytes = resultByteLength(jsonToolResult(payload));
    if (bytes > COMPACT_BUDGETS.describeBytes) {
      throw definitionTooLargeError({
        tool,
        server: entry.server.slug,
        bytes,
        budget: COMPACT_BUDGETS.describeBytes,
      });
    }
    return payload;
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  #hostedRecords(): ServerRecord[] {
    return this.#store
      .listServers()
      .filter((server) => this.hosts(server))
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }

  #visibleTools(server: ServerRecord, snapshot: CapabilitySnapshot): Tool[] {
    return this.#projections.apply(server.id, snapshot.tools);
  }

  /**
   * Any App/UI metadata marks the whole server for the individual endpoint
   * until a specific companion tool can be linked reliably.
   */
  #executionFor(entry: RegistryEntry, tool: Tool): 'exec' | 'individualEndpoint' {
    return entry.snapshot.tools.some((candidate) => executionBoundaryForTool(candidate) !== 'exec')
      ? 'individualEndpoint'
      : executionBoundaryForTool(tool);
  }

  #endpointGuidance(server: ServerRecord): string {
    return this.#scope === 'local'
      ? `Use toolhome mcp launch ${server.slug} on this machine.`
      : `Use /mcp/${server.slug}.`;
  }

  #catalogVersion(): string {
    const signature = this.#hostedRecords().map((server) => {
      const snapshot = this.#store.getSnapshot(server.id);
      return {
        slug: server.slug,
        snapshot: snapshot?.fingerprint ?? null,
        visible:
          snapshot === null
            ? null
            : this.#visibleTools(server, snapshot)
                .map((tool) => tool.name)
                .sort(),
      };
    });
    return fingerprint(signature).slice(0, 16);
  }

  #overBudget(payload: Record<string, unknown>, budget: number): boolean {
    return resultByteLength(jsonToolResult(payload)) > budget;
  }
}

interface CandidateDoc {
  entry: RegistryEntry;
  server: ServerRecord;
  tool: Tool;
  id: string;
}

interface ScoredTool extends CandidateDoc {
  tier: number;
  score: number;
  matchedOn: string[];
}

interface Summary {
  text: string;
  truncated: boolean;
}

// ── tokenization and scoring ──────────────────────────────────────────────

/** Unicode-aware tokenizer: NFKC, camelCase split, deduped meaningful tokens. */
export function tokenizeQuery(input: string): string[] {
  const camelSplit = input.normalize('NFKC').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const match of camelSplit.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0];
    if (token.length === 0 || STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function normalizeForPhrase(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenizeField(input: string): string[] {
  const camelSplit = input.normalize('NFKC').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return [...camelSplit.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]);
}

interface FieldScore {
  score: number;
  hits: Set<string>;
}

type FieldName = 'name' | 'title' | 'server' | 'description' | 'parameters';

interface FieldSpec {
  name: FieldName;
  text: string;
  weight: number;
  coverage: boolean;
}

function candidateFields(server: ServerRecord, tool: Tool): FieldSpec[] {
  return [
    { name: 'name', text: tool.name, weight: FIELD_WEIGHTS.name, coverage: true },
    { name: 'title', text: tool.title ?? '', weight: FIELD_WEIGHTS.title, coverage: true },
    {
      name: 'server',
      text: `${server.slug} ${server.name}`,
      weight: FIELD_WEIGHTS.server,
      coverage: false,
    },
    {
      name: 'description',
      text: tool.description ?? '',
      weight: FIELD_WEIGHTS.description,
      coverage: true,
    },
    {
      name: 'parameters',
      text: parameterText(tool),
      weight: FIELD_WEIGHTS.parameters,
      coverage: true,
    },
  ];
}

function scoreField(
  fieldText: string,
  weight: number,
  queryTokens: string[],
  phrase: string,
): FieldScore {
  const fieldTokens = new Set(tokenizeField(fieldText));
  const hits = new Set<string>();
  let score = 0;
  for (const token of queryTokens) {
    if (fieldTokens.has(token)) {
      score += weight;
      hits.add(token);
    }
  }
  if (phrase.length > 0 && normalizeForPhrase(fieldText).includes(phrase)) {
    score += 2 * weight;
  }
  return { score, hits };
}

// ── BM25 (same fields, same coverage gate, same phrase bonus) ─────────────

interface FieldStats {
  count: number;
  avgdl: number;
  df: Map<string, number>;
}

type CorpusStats = Record<FieldName, FieldStats>;

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function buildCorpus(docs: CandidateDoc[]): CorpusStats {
  const tokensByField: Record<FieldName, string[][]> = {
    name: [],
    title: [],
    server: [],
    description: [],
    parameters: [],
  };
  for (const doc of docs) {
    for (const field of candidateFields(doc.server, doc.tool)) {
      tokensByField[field.name].push(tokenizeField(field.text));
    }
  }
  const corpus = {} as CorpusStats;
  for (const name of Object.keys(tokensByField) as FieldName[]) {
    const lists = tokensByField[name];
    const df = new Map<string, number>();
    let total = 0;
    for (const tokens of lists) {
      total += tokens.length;
      for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
    }
    corpus[name] = {
      count: lists.length,
      avgdl: lists.length === 0 ? 0 : total / lists.length,
      df,
    };
  }
  return corpus;
}

function bm25Field(
  fieldText: string,
  weight: number,
  queryTokens: string[],
  phrase: string,
  stats: FieldStats,
): FieldScore {
  const fieldTokens = tokenizeField(fieldText);
  const frequencies = new Map<string, number>();
  for (const token of fieldTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const hits = new Set<string>();
  let raw = 0;
  const length = fieldTokens.length;
  for (const query of queryTokens) {
    const frequency = frequencies.get(query);
    if (frequency === undefined) continue;
    const documentFrequency = stats.df.get(query) ?? 0;
    if (documentFrequency === 0) continue;
    const idf = Math.log(1 + (stats.count - documentFrequency + 0.5) / (documentFrequency + 0.5));
    const norm = stats.avgdl === 0 ? 1 : length / stats.avgdl;
    raw +=
      (idf * (frequency * (BM25_K1 + 1))) / (frequency + BM25_K1 * (1 - BM25_B + BM25_B * norm));
    hits.add(query);
  }
  let score = weight * raw;
  if (phrase.length > 0 && normalizeForPhrase(fieldText).includes(phrase)) {
    score += 2 * weight;
  }
  return { score, hits };
}

function scoreTool(
  server: ServerRecord,
  tool: Tool,
  queryTokens: string[],
  phrase: string,
  corpus: CorpusStats | null,
  coverageGate: boolean,
): { tier: number; score: number; matchedOn: string[] } | null {
  let score = 0;
  const matchedOn: string[] = [];
  const coverageHits = new Set<string>();
  for (const field of candidateFields(server, tool)) {
    if (field.text.length === 0) continue;
    const result =
      corpus === null
        ? scoreField(field.text, field.weight, queryTokens, phrase)
        : bm25Field(field.text, field.weight, queryTokens, phrase, corpus[field.name]);
    if (result.hits.size > 0) matchedOn.push(field.name);
    score += result.score;
    if (field.coverage) for (const hit of result.hits) coverageHits.add(hit);
  }

  // Baseline: score-only ranking keeps every candidate, including zero-hit ones.
  if (!coverageGate) return { tier: 2, score, matchedOn };

  const total = queryTokens.length;
  const covered = coverageHits.size;
  const passes =
    total === 1
      ? covered >= 1
      : covered >= MIN_COVERED_TOKENS && covered / total >= MIN_COVERAGE_RATIO;
  // A provider-slug-only overlap or a single common word must not pass.
  if (!passes) return null;
  return { tier: 2, score, matchedOn };
}

function parameterText(tool: Tool): string {
  const schema = tool.inputSchema;
  const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === 'string')
    : [];
  return [...properties, ...required].join(' ');
}

// ── summaries and annotations ─────────────────────────────────────────────

function summarize(description: string | undefined): Summary {
  const normalized = (description ?? '').trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) return { text: '', truncated: false };
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(normalized);
  const chosen = sentence ? sentence[1]! : normalized;
  const points = Array.from(chosen);
  const truncated = chosen.length < normalized.length || points.length > 240;
  return { text: points.slice(0, 240).join(''), truncated };
}

function smallAnnotations(tool: Tool): Record<string, unknown> | null {
  const annotations = tool.annotations;
  if (!annotations) return null;
  const output: Record<string, unknown> = {};
  if (annotations.readOnlyHint !== undefined) output.readOnlyHint = annotations.readOnlyHint;
  if (annotations.destructiveHint !== undefined) {
    output.destructiveHint = annotations.destructiveHint;
  }
  if (annotations.idempotentHint !== undefined) output.idempotentHint = annotations.idempotentHint;
  if (annotations.openWorldHint !== undefined) output.openWorldHint = annotations.openWorldHint;
  return Object.keys(output).length === 0 ? null : output;
}

// ── cursors ───────────────────────────────────────────────────────────────

interface CatalogCursor {
  offset: number;
  version: string;
}

function encodeCursor(offset: number, version: string): string {
  return Buffer.from(JSON.stringify({ offset, version }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CatalogCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!isRecord(parsed)) return null;
    const offset = parsed.offset;
    const version = parsed.version;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return null;
    if (typeof version !== 'string') return null;
    return { offset, version };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
