import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compactTools } from '../../src/data-plane/compact-protocol.js';
import { ToolCatalog } from '../../src/data-plane/tool-catalog.js';
import { aggregateToolName } from '../../src/data-plane/virtualization.js';
import {
  seedCompactCatalog,
  retrievalTasks,
  robustnessInputs,
} from '../fixtures/compact-retrieval.js';
import {
  realHostChinesePairing,
  realHostHeldout,
  realHostRobustness,
  realHostTasks,
  realLocalRobustness,
  realLocalTasks,
} from '../fixtures/compact-real-tasks.js';
import { applicationFetch, controlRequest, createTestRuntime } from '../support/runtime.js';
import {
  buildCatalogCorpus,
  buildCatalogView,
  buildFixtureCorpus,
  catalogFingerprints,
  collectScriptTraces,
  connectGatewaySearch,
  countFixedToolTokens,
  evaluateRetrieval,
  evaluateRobustness,
  findMatches,
  formatSummary,
  isHeldout,
  loadAgentTraces,
  loadCatalogFile,
  measureLatency,
  normalizeCatalogFile,
  pairTaskCosts,
  parseArgs,
  resolveTaskSet,
  runBenchmark,
  TASK_SETS,
  type BenchmarkTask,
  type CatalogFile,
} from '../../scripts/benchmark-compact.js';
import type { CallToolResult } from '@modelcontextprotocol/server';

const opened: { close(): void }[] = [];
const directories: string[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function open<T extends { close(): void }>(corpus: T): T {
  opened.push(corpus);
  return corpus;
}

function syntheticFile(overrides: Partial<CatalogFile> = {}): CatalogFile {
  return {
    formatVersion: 1,
    generatedAt: '2026-10-04T00:00:00.000Z',
    source: 'synthetic',
    servers: [
      {
        slug: 'alpha',
        name: 'Alpha',
        kind: 'remote',
        nodeId: null,
        enabled: true,
        instructions: null,
        tools: [
          {
            name: 'ping',
            description: 'Ping the remote service and report status.',
            inputSchema: { type: 'object', properties: { host: { type: 'string' } } },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function resultWithTools(...tools: string[]): CallToolResult {
  return {
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { kind: 'matches', matches: tools.map((tool) => ({ tool })) },
  } as CallToolResult;
}

describe('compact benchmark fixture coverage', () => {
  it('has at least 20 supported English + rewritten labeled tasks', () => {
    const supported = retrievalTasks.filter(
      (task) => task.group === 'english' || task.group === 'chinese-rewritten',
    );
    expect(supported.length).toBeGreaterThanOrEqual(20);
    expect(supported.filter((task) => task.group === 'english').length).toBe(18);
    expect(supported.filter((task) => task.group === 'chinese-rewritten').length).toBe(4);
  });
});

describe('real catalog task fixture', () => {
  it('has at least 20 main host labels plus 4 Chinese pairs and 8 held-out queries', () => {
    expect(realHostTasks.length).toBeGreaterThanOrEqual(20);
    expect(realHostTasks.every((task) => task.expected !== null)).toBe(true);
    expect(realHostChinesePairing.filter((task) => task.group === 'chinese')).toHaveLength(4);
    expect(
      realHostChinesePairing.filter((task) => task.group === 'chinese-rewritten'),
    ).toHaveLength(4);
    expect(realHostHeldout.length).toBeGreaterThanOrEqual(8);
    expect(realHostHeldout.every((task) => task.split === 'heldout')).toBe(true);
    expect(realLocalTasks.length).toBeGreaterThanOrEqual(10);
    expect(realHostRobustness.length).toBeGreaterThanOrEqual(4);
    expect(realLocalRobustness.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps every expected id consistent with its upstream identity', () => {
    const all = [
      ...realHostTasks,
      ...realHostChinesePairing,
      ...realHostHeldout,
      ...realLocalTasks,
    ];
    for (const task of all) {
      if (task.expected === null) continue;
      expect(task.expected, task.id).toBe(aggregateToolName(task.server, task.tool));
    }
    const ids = all.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps held-out queries distinct from the main-path queries', () => {
    const mainQueries = new Set(
      [...realHostTasks, ...realHostChinesePairing]
        .filter((task) => task.split === 'main')
        .map((task) => task.query),
    );
    for (const task of realHostHeldout) {
      expect(mainQueries.has(task.query), task.id).toBe(false);
    }
  });

  it('exposes the task sets through resolveTaskSet', () => {
    expect(resolveTaskSet('real')!.tasks.length).toBe(
      realHostTasks.length + realHostChinesePairing.length + realHostHeldout.length,
    );
    expect(resolveTaskSet('real-local')!.tasks.length).toBe(realLocalTasks.length);
    expect(resolveTaskSet('fixture')!.tasks.length).toBe(retrievalTasks.length);
    expect(resolveTaskSet('nope')).toBeUndefined();
  });
});

const HOST_CATALOG = process.env.TOOLHOME_REAL_HOST_CATALOG;
const LOCAL_CATALOG = process.env.TOOLHOME_REAL_LOCAL_CATALOG;

describe.skipIf(HOST_CATALOG === undefined)('real host catalog label verification', () => {
  it('resolves every labeled task and robustness expected id in the actual catalog', () => {
    const corpus = open(buildCatalogCorpus(loadCatalogFile(HOST_CATALOG!)));
    const view = buildCatalogView(corpus.store, corpus.projections, 'field-score');
    const expected = [
      ...TASK_SETS.real!.tasks,
      ...realHostRobustness
        .map((input) => (input.expected === undefined ? undefined : input.expected))
        .filter((value): value is string => value !== undefined)
        .map((value) => ({ id: value, expected: value })),
    ];
    const missing = expected
      .filter((task) => task.expected !== null && view.owner(task.expected!) === undefined)
      .map((task) => task.id);
    expect(missing).toEqual([]);
  });
});

describe.skipIf(LOCAL_CATALOG === undefined)('real local catalog label verification', () => {
  it('resolves every local labeled task in the owning-node scope', () => {
    const corpus = open(buildCatalogCorpus(loadCatalogFile(LOCAL_CATALOG!)));
    const view = buildCatalogView(corpus.store, corpus.projections, 'field-score');
    const missing = TASK_SETS['real-local']!.tasks.filter(
      (task) => task.expected !== null && view.owner(task.expected!) === undefined,
    ).map((task) => task.id);
    expect(missing).toEqual([]);
    expect(view.host.scope).toBe('host');
    expect(view.locals.length).toBeGreaterThan(0);
  });
});

describe('runBenchmark on the shipped fixture', () => {
  it('evaluates both rankers against real catalog output and separates groups', async () => {
    const report = await runBenchmark({
      algorithms: ['field-score', 'bm25'],
      warmupIterations: 1,
      warmIterations: 5,
      countTokens: false,
    });

    expect(report.algorithms).toEqual(['field-score', 'bm25']);
    expect(report.tasks.denominator).toBe(retrievalTasks.length);
    expect(report.tasks.labeled).toBeGreaterThanOrEqual(20);
    expect(report.tasks.missingLabels).toEqual([]);

    for (const retrieval of report.retrieval) {
      expect(retrieval.overall.labeled).toBeGreaterThanOrEqual(20);
      expect(retrieval.overall.mrr).toBeGreaterThan(0.5);
      // Pure Chinese originals are reported separately from their rewrites.
      const chinese = retrieval.groups.chinese!;
      expect(chinese.labeled).toBe(0);
      expect(chinese.negativeTasks).toBe(4);
      expect(chinese.negativeCorrect).toBe(4);
      expect(retrieval.groups['chinese-rewritten']!.labeled).toBe(4);
      expect(retrieval.groups.english!.labeled).toBe(18);
    }

    // The shipped field-score ranker must retrieve the DeepWiki structure tool
    // at top-1 for its clear English label, without the benchmark reimplementing
    // any scoring.
    const english = report.retrieval[0]!.outcomes.find(
      (outcome) => outcome.id === 'english-read-structure',
    )!;
    expect(english.rank).toBe(1);
    expect(english.matched).toBe(true);
  });

  it('reports robustness, latency, fingerprint, hardware and blocked tokens', async () => {
    const report = await runBenchmark({
      algorithms: ['field-score'],
      warmupIterations: 1,
      warmIterations: 4,
      countTokens: false,
    });

    const robustness = report.robustness[0]!;
    expect(robustness.status).toBe('evaluated');
    expect(robustness.applied).toBe(robustnessInputs.length);
    expect(robustness.skipped).toBe(0);
    expect(robustness.passed).toBe(robustness.applied);

    const latency = report.latency[0]!;
    expect(latency.warm.samples).toBe(4);
    expect(latency.warmupIterations).toBe(1);
    expect(latency.cold.samples).toBe(retrievalTasks.length);
    expect(latency.warm.p50Ms).toBeLessThanOrEqual(latency.warm.p95Ms);
    expect(latency.warm.p95Ms).toBeLessThanOrEqual(latency.warm.maxMs);

    // tiktoken is not installed in this environment: the benchmark must say so
    // explicitly and never report fabricated counts.
    expect(report.tokens.status).toBe('blocked');
    expect(report.tokens.reason).toContain('disabled');
    expect(report.tokens.perTool).toBeUndefined();
    expect(report.tokens.total).toBeUndefined();
    expect(report.tokens.estimate).toBeGreaterThan(0);

    expect(report.environment.node).toBe(process.version);
    expect(report.environment.cpuCount).toBeGreaterThan(0);
    expect(report.environment.cpuModel.length).toBeGreaterThan(0);

    expect(report.fingerprints['field-score']!.contentFingerprint).toHaveLength(64);
    expect(report.fingerprints['field-score']!.fixedToolsFingerprint).toHaveLength(64);
    expect(report.taskCost).toBeUndefined();
    expect(formatSummary(report)).toContain('compact benchmark');
  });
});

describe('evaluateRetrieval', () => {
  it('reports a denominator and missing labels when real labels are absent', () => {
    const corpus = open(buildCatalogCorpus(syntheticFile()));
    const view = buildCatalogView(corpus.store, corpus.projections, 'field-score');
    const tasks: BenchmarkTask[] = [
      { id: 'hit', query: 'ping the remote service', expected: 'alpha_ping', group: 'english' },
      { id: 'missing', query: 'do a missing thing', expected: 'beta_xyz', group: 'english' },
    ];

    const report = evaluateRetrieval(view, tasks, { k: 5 });
    expect(report.denominator).toBe(2);
    expect(report.labeled).toBe(1);
    expect(report.missingLabels).toEqual(['missing']);
    expect(report.overall.labeled).toBe(1);
    expect(report.outcomes.find((outcome) => outcome.id === 'hit')!.rank).toBe(1);
    expect(report.outcomes.find((outcome) => outcome.id === 'missing')!.missingLabel).toBe(true);
  });

  it('splits dev/heldout deterministically without dropping tasks', () => {
    const corpus = open(buildCatalogCorpus(syntheticFile()));
    const view = buildCatalogView(corpus.store, corpus.projections, 'bm25');
    const tasks: BenchmarkTask[] = retrievalTasks.map((task) => ({
      id: task.id,
      query: task.query,
      expected: task.expected,
      group: task.group,
    }));
    const report = evaluateRetrieval(view, tasks);
    expect(report.dev.tasks + report.heldout.tasks).toBe(report.outcomes.length);
    expect(isHeldout('english-read-structure')).toBe(isHeldout('english-read-structure'));
  });
});

describe('robustness', () => {
  it('skips duplicate-provider inputs when no duplicate corpus exists', () => {
    const corpus = open(buildFixtureCorpus());
    const view = buildCatalogView(corpus.store, corpus.projections, 'field-score');
    const report = evaluateRobustness({ plain: view }, [
      {
        id: 'same-name-across-providers',
        query: 'read wiki structure',
        outcome: 'match',
        expected: 'deepwiki_read_wiki_structure',
        topK: 2,
        requiresDuplicateProvider: true,
      },
    ]);
    expect(report.skipped).toBe(1);
    expect(report.results[0]!.reason).toContain('duplicate-provider');
  });
});

describe('catalog fingerprints', () => {
  it('is stable per algorithm and differs across algorithms', () => {
    const corpus = open(buildFixtureCorpus());
    const fieldScore = catalogFingerprints(
      buildCatalogView(corpus.store, corpus.projections, 'field-score'),
    );
    const again = catalogFingerprints(
      buildCatalogView(corpus.store, corpus.projections, 'field-score'),
    );
    const bm25 = catalogFingerprints(buildCatalogView(corpus.store, corpus.projections, 'bm25'));
    expect(fieldScore.contentFingerprint).toBe(again.contentFingerprint);
    expect(fieldScore.contentFingerprint).not.toBe(bm25.contentFingerprint);
    expect(fieldScore.fixedToolsFingerprint).toBe(bm25.fixedToolsFingerprint);
  });
});

describe('latency', () => {
  it('keeps cold samples separate from warm samples', () => {
    const corpus = open(buildFixtureCorpus());
    const view = buildCatalogView(corpus.store, corpus.projections, 'field-score');
    const report = measureLatency(view, ['search repositories', 'take a screenshot'], {
      warmupIterations: 2,
      warmIterations: 3,
    });
    expect(report.cold.samples).toBe(2);
    expect(report.warm.samples).toBe(3);
    expect(report.queries).toBe(2);
    expect(report.warm.p95Ms).toBeGreaterThanOrEqual(report.warm.p50Ms);
  });
});

describe('fixed-tool token counting', () => {
  it('reports actual tokenizer counts when the python runner succeeds', async () => {
    const encodings = {
      o200k_base: { perText: [11, 12, 23] },
      cl100k_base: { perText: [21, 22, 43] },
    };
    const result = await countFixedToolTokens({
      pythonBin: 'python3',
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          python: '3.14.8',
          tiktoken: '0.12.0',
          encodings,
        }),
        stderr: '',
      }),
    });
    expect(result.status).toBe('ok');
    expect(result.tiktokenVersion).toBe('0.12.0');
    expect(result.pythonVersion).toBe('3.14.8');
    expect(Object.keys(result.perTool!)).toEqual(compactTools().map((tool) => tool.name));
    expect(result.perTool!.search!.o200k_base).toBe(11);
    expect(result.perTool!.exec!.cl100k_base).toBe(22);
    expect(result.total!.o200k_base).toBe(23);
    expect(result.estimate).toBeGreaterThan(0);
  });

  it('reports blocked with a reason and no fabricated counts on failure', async () => {
    const result = await countFixedToolTokens({
      pythonBin: 'python3',
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify({
          ok: false,
          error: 'tiktoken not importable: No module named tiktoken',
        }),
        stderr: '',
      }),
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('tiktoken');
    expect(result.perTool).toBeUndefined();
    expect(result.total).toBeUndefined();
    expect(result.estimate).toBeGreaterThan(0);
  });
});

describe('catalog file input', () => {
  it('merges the control-API servers + snapshots shape', () => {
    const file = normalizeCatalogFile({
      source: 'control',
      servers: [{ id: 's1', slug: 'alpha', name: 'Alpha', kind: 'remote', enabled: true }],
      snapshots: [
        {
          serverId: 's1',
          instructions: 'Alpha instructions',
          fingerprint: 'snap-1',
          tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }],
        },
      ],
    });
    expect(file.servers).toHaveLength(1);
    expect(file.servers[0]!.tools).toHaveLength(1);
    expect(file.servers[0]!.snapshotFingerprint).toBe('snap-1');
  });

  it('runs the benchmark against a catalog without labels and reports the denominator', async () => {
    const report = await runBenchmark({
      catalogFile: syntheticFile(),
      algorithms: ['field-score'],
      warmupIterations: 0,
      warmIterations: 1,
      countTokens: false,
    });
    expect(report.tasks.denominator).toBe(retrievalTasks.length);
    expect(report.tasks.missingLabels.length).toBeGreaterThan(0);
    expect(report.robustness[0]!.status).toBe('not-labeled');
  });
});

describe('task-cost paired protocol', () => {
  it('calls a real gateway over the shipped Client and collects read-only traces', async () => {
    const runtime = createTestRuntime({ config: { mcpToolMode: 'compact' } });
    try {
      const keyResponse = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'POST',
        '/api/v1/access-keys',
        { name: 'benchmark-test' },
      );
      const { secret } = (await keyResponse.json()) as { secret: string };
      seedCompactCatalog(runtime.runtime.store);
      const session = await connectGatewaySearch({
        url: new URL('/mcp', runtime.runtime.config.publicUrl),
        accessKey: secret,
        fetchImpl: (input, init) => applicationFetch(runtime.runtime, new URL(String(input)), init),
      });
      try {
        expect(await session.listTools()).toEqual(['search', 'exec']);
        const traces = await collectScriptTraces(session.search, [
          {
            id: 'english-search-code',
            query: 'search code across repositories',
            expected: null,
            group: 'english',
          },
        ]);
        expect(traces[0]!.kind).toBe('script');
        expect(traces[0]!.error).toBeNull();
        expect(traces[0]!.resultBytes).toBeGreaterThan(0);
      } finally {
        await session.close();
      }
    } finally {
      await runtime.close();
    }
  });

  it('labels script traces by kind and pairs them with agent traces by id', async () => {
    const script = await collectScriptTraces(
      async (arguments_) => resultWithTools(`hit-${String(arguments_.query)}`),
      [{ id: 't1', query: 'one', expected: null, group: 'english' }],
    );
    expect(script[0]!.kind).toBe('script');
    expect(script[0]!.tool).toBe('hit-one');

    const pairs = pairTaskCosts(script, [
      {
        taskId: 't1',
        kind: 'agent',
        query: 'one',
        tool: 'agent-one',
        latencyMs: 5,
        resultBytes: 10,
        error: null,
      },
    ]);
    expect(pairs[0]!.agent!.tool).toBe('agent-one');
    expect(pairs[0]!.script.tool).toBe('hit-one');
  });

  it('marks the agent side unavailable without a trace file', () => {
    const source = loadAgentTraces(undefined);
    expect(source.status).toBe('unavailable');
    expect(source.reason).toContain('parent');
    expect(source.traces).toEqual([]);
  });

  it('loads parent-supplied agent traces from a file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-agent-trace-'));
    directories.push(directory);
    const path = join(directory, 'agent.json');
    writeFileSync(
      path,
      JSON.stringify([
        { taskId: 't1', query: 'one', tool: 'agent-one', latencyMs: 5, resultBytes: 10 },
      ]),
    );
    const source = loadAgentTraces(path);
    expect(source.status).toBe('provided');
    expect(source.traces[0]!.kind).toBe('agent');
    expect(source.traces[0]!.taskId).toBe('t1');
  });
});

describe('coverage baseline', () => {
  it('keeps the shipped default gate on and disables it only for the baseline', () => {
    const corpus = open(buildFixtureCorpus());
    const shipped = buildCatalogView(corpus.store, corpus.projections, 'field-score');
    const baseline = buildCatalogView(corpus.store, corpus.projections, 'coverage-baseline');
    expect(shipped.coverageGate).toBe(true);
    expect(baseline.coverageGate).toBe(false);
    expect(baseline.algorithm).toBe('field-score');
    // Direct construction must preserve the runtime default too.
    const direct = new ToolCatalog(corpus.store, corpus.projections);
    expect(direct.coverageGate).toBe(true);
  });

  it('lifts the gate, changing provider-only and no-overlap precision', () => {
    const corpus = open(buildFixtureCorpus());
    const shipped = buildCatalogView(corpus.store, corpus.projections, 'field-score');
    const baseline = buildCatalogView(corpus.store, corpus.projections, 'coverage-baseline');
    const providerOnly = 'shadcn context7';
    const noOverlap = 'quantum chromodynamics lattice gauge';
    expect(findMatches(shipped.host.search({ action: 'find', query: providerOnly }))).toEqual([]);
    expect(
      findMatches(baseline.host.search({ action: 'find', query: providerOnly })).length,
    ).toBeGreaterThan(0);
    expect(findMatches(shipped.host.search({ action: 'find', query: noOverlap }))).toEqual([]);
    expect(
      findMatches(baseline.host.search({ action: 'find', query: noOverlap })).length,
    ).toBeGreaterThan(0);

    const inputs = TASK_SETS.fixture!.robustness;
    const shippedReport = evaluateRobustness({ plain: shipped }, inputs);
    const baselineReport = evaluateRobustness({ plain: baseline }, inputs);
    expect(shippedReport.failed).toEqual([]);
    expect(baselineReport.failed).toContain('provider-only-overlap');
    expect(baselineReport.failed).toContain('no-overlap');
  });

  it('reports the baseline separately and omits its latency', async () => {
    const report = await runBenchmark({
      algorithms: ['field-score', 'coverage-baseline'],
      warmupIterations: 1,
      warmIterations: 2,
      countTokens: false,
    });
    expect(report.algorithms).toEqual(['field-score', 'coverage-baseline']);
    expect(report.retrieval).toHaveLength(2);
    const baseline = report.retrieval.find((entry) => entry.algorithm === 'coverage-baseline')!;
    expect(baseline.coverageGate).toBe(false);
    expect(
      report.robustness.find((entry) => entry.algorithm === 'coverage-baseline'),
    ).toBeDefined();
    // The hypothetical baseline is never timed; only the shipped ranker is.
    expect(report.latency.map((entry) => entry.algorithm)).toEqual(['field-score']);
    expect(report.describe.total).toBeGreaterThan(0);
    expect(typeof report.describe.definitionTooLarge).toBe('number');
  });
});

describe('parseArgs', () => {
  it('parses the durable flags and rejects unknown ones', () => {
    const options = parseArgs([
      '--algorithm',
      'bm25',
      '--warm',
      '5',
      '--warmup',
      '1',
      '--no-tokens',
    ]);
    expect(options.algorithms).toEqual(['bm25']);
    expect(options.warmIterations).toBe(5);
    expect(options.warmupIterations).toBe(1);
    expect(options.countTokens).toBe(false);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown flag/);
  });
});
