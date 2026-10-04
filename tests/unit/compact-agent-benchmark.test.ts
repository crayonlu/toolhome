import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_BENCHMARK_TASKS,
  DEFAULT_AGENT_ROUND,
  aggregateAgentReports,
  assertNoSecrets,
  buildProjectConfig,
  formatAgentSummary,
  formatAggregateSummary,
  parseAgentArgs,
  parseGrokStream,
  rawFileName,
  representativeCatalogTools,
  rescoreReportFromRaw,
  sumTokenTotals,
  toAgentTraces,
  validateAgentBenchmarkReport,
  type AgentBenchmarkReport,
  type AgentRunResult,
  type GrokUsage,
} from '../../scripts/benchmark-compact-agent.js';

/** Catalog size is read from the shipped fixture so count checks stay dynamic. */
const CATALOG_TOOLS = representativeCatalogTools();
const CATALOG_TOOL_COUNT = CATALOG_TOOLS.length;
const MATH_TOOL_COUNT = 3;

function usage(overrides: Partial<GrokUsage> = {}): GrokUsage {
  return {
    source: 'end',
    inputTokens: 20_000,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 20_050,
    modelCalls: 2,
    ...overrides,
  };
}

function agentRun(
  taskId: string,
  mode: 'full' | 'compact',
  overrides: Partial<AgentRunResult> = {},
): AgentRunResult {
  return {
    taskId,
    mode,
    status: 'ok',
    exitCode: 0,
    error: null,
    sessionHash: '0123456789abcdef',
    usage: usage(),
    numTurns: 3,
    stopReason: 'end_turn',
    durationMs: 1_000,
    calls: [{ name: 'search_tool', target: 'search_tool', innerTool: null, inputHash: null }],
    toolHomeCalls: [mode === 'full' ? 'math_add_value' : 'search', 'exec'],
    grokTools: ['search_tool', 'use_tool'],
    usedExpectedTool: true,
    passed: true,
    answerText: 'value 42',
    rawFile: `/scratch/${mode}-${taskId}.ndjson`,
    ...overrides,
  };
}

function reportFixture(): AgentBenchmarkReport {
  const pairs = AGENT_BENCHMARK_TASKS.map((task) => ({
    taskId: task.id,
    prompt: task.prompt,
    expectedTool: task.expectation.expectedTool,
    full: agentRun(task.id, 'full', { toolHomeCalls: [task.expectation.expectedTool] }),
    compact: agentRun(task.id, 'compact', { toolHomeCalls: ['search', 'exec'] }),
  }));
  return {
    generatedAt: '2026-10-04T13:00:00.000Z',
    round: DEFAULT_AGENT_ROUND,
    grokVersion: 'grok 1.0.45',
    model: 'gpt-6.1-sol',
    modes: ['full', 'compact'],
    footprints: {
      full: {
        mode: 'full',
        count: CATALOG_TOOL_COUNT + MATH_TOOL_COUNT,
        bytes: 12_345,
        estimatedTokens: 3_087,
        names: [],
      },
      compact: { mode: 'compact', count: 2, bytes: 900, estimatedTokens: 225, names: [] },
    },
    grokTools: ['search_tool', 'use_tool'],
    pairs,
    totals: {
      full: sumTokenTotals(pairs.map((pair) => pair.full)),
      compact: sumTokenTotals(pairs.map((pair) => pair.compact)),
    },
    notes: [],
  };
}

describe('agent benchmark tasks', () => {
  it('defines three unique user tasks that name no tool or discovery strategy', () => {
    expect(AGENT_BENCHMARK_TASKS).toHaveLength(3);
    expect(new Set(AGENT_BENCHMARK_TASKS.map((task) => task.id)).size).toBe(3);
    for (const task of AGENT_BENCHMARK_TASKS) {
      expect(task.prompt.length).toBeGreaterThan(0);
      expect(task.prompt).toMatch(/benchmark MCP server/);
      for (const forbidden of ['add_value', 'mixed_result', 'math_', 'exec', 'search_tool']) {
        expect(task.prompt).not.toContain(forbidden);
      }
      expect(task.expectation.expectedTool).toMatch(/^math_/);
    }
    const mutating = AGENT_BENCHMARK_TASKS.filter((task) => task.mutatesFixtureState);
    expect(mutating.map((task) => task.id)).toEqual(['add-number']);
  });
});

describe('representative catalog fixture', () => {
  it('seeds many unique live tools without a double-underscore delimiter', () => {
    const tools = CATALOG_TOOLS;
    // Count is read from the fixture, so a fixture change does not break the test.
    expect(tools.length).toBe(CATALOG_TOOL_COUNT);
    expect(CATALOG_TOOL_COUNT).toBeGreaterThanOrEqual(20);
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(name).not.toContain('__');
    }
    expect(names.some((name) => name.startsWith('math-'))).toBe(false);
  });
});

describe('grok isolation config', () => {
  it('adds the benchmark server and disables the machine servers in one project TOML', () => {
    const toml = buildProjectConfig({
      url: 'http://127.0.0.1:9999/mcp',
      accessKey: 'tch_mcp_test-secret',
    });
    expect(toml).toContain('[mcp_servers.benchmark]');
    expect(toml).toContain('url = "http://127.0.0.1:9999/mcp"');
    expect(toml).toContain('Authorization = "Bearer tch_mcp_test-secret"');
    expect(toml).toContain('[mcp_servers.toolhome]');
    expect(toml).toContain('[mcp_servers.toolhome-local]');
    expect(toml).toContain('enabled = false');
  });
});

describe('parseGrokStream', () => {
  it('derives exact usage, turns and discovered ToolHome calls from real NDJSON', () => {
    const stdout = [
      '{"type":"available_commands","tools":["search_tool","use_tool"],"commands":[]}',
      '{"type":"tool_call","toolCallId":"c1","toolName":"use_tool","rawInput":{"tool_name":"benchmark__search","tool_input":{"action":"find","query":"add a number"}}}',
      '{"type":"tool_call_update","toolCallId":"c1","status":"completed"}',
      '{"type":"tool_call","toolCallId":"c2","toolName":"use_tool","rawInput":{"tool_name":"benchmark__exec","tool_input":{"tool":"math_add_value","arguments":{"value":41}}}}',
      '{"type":"usage","messageId":"m1","stopReason":"tool_use","usage":{"input_tokens":20000,"output_tokens":50,"cache_read_input_tokens":100,"cache_creation_input_tokens":0,"total_tokens":20150}}',
      '{"type":"usage","messageId":"m2","stopReason":"end_turn","usage":{"input_tokens":21000,"output_tokens":30,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"total_tokens":21030}}',
      '{"type":"text","data":"The resulting value is 42."}',
      '{"type":"end","stopReason":"end_turn","sessionId":"01a10707-14e3-7a43-8615-a740f900d625","requestId":"r1","usage":{"input_tokens":21000,"output_tokens":30,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"total_tokens":21030},"num_turns":3,"modelUsage":{"gpt-6.1-sol":{"modelCalls":2}}}',
    ].join('\n');

    const parsed = parseGrokStream(stdout);
    expect(parsed.format).toBe('streaming');
    expect(parsed.unparsedLines).toBe(0);
    // End-event aggregate usage wins; per-response numbers are never reported as the total.
    expect(parsed.usage.source).toBe('end');
    expect(parsed.usage.inputTokens).toBe(21_000);
    expect(parsed.usage.outputTokens).toBe(30);
    expect(parsed.usage.cacheReadInputTokens).toBe(0);
    expect(parsed.usage.totalTokens).toBe(21_030);
    expect(parsed.usage.modelCalls).toBe(2);
    expect(parsed.numTurns).toBe(3);
    expect(parsed.sessionId).toBe('01a10707-14e3-7a43-8615-a740f900d625');
    expect(parsed.toolHomeCalls).toEqual(['search', 'exec', 'math_add_value']);
    expect(parsed.calls.map((call) => call.name)).toEqual(['use_tool', 'use_tool']);
    expect(parsed.calls[1]!.innerTool).toBe('math_add_value');
    expect(parsed.grokTools).toEqual(['search_tool', 'use_tool']);
    expect(parsed.finalText).toBe('The resulting value is 42.');
  });

  it('sums per-response usage only when no end event is present', () => {
    const parsed = parseGrokStream(
      [
        '{"type":"usage","usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}',
        '{"type":"usage","usage":{"input_tokens":200,"output_tokens":20,"total_tokens":220}}',
      ].join('\n'),
    );
    expect(parsed.usage.source).toBe('summed');
    expect(parsed.usage.inputTokens).toBe(300);
    expect(parsed.usage.outputTokens).toBe(30);
  });

  it('falls back to the json object shape and reports unavailable usage honestly', () => {
    const parsed = parseGrokStream(
      '{"text":"READY","stopReason":"end_turn","sessionId":"abc","usage":{"input_tokens":17200,"output_tokens":5,"total_tokens":17205},"num_turns":1}',
    );
    expect(parsed.format).toBe('json');
    expect(parsed.usage.inputTokens).toBe(17_200);
    expect(parsed.numTurns).toBe(1);
    expect(parsed.finalText).toBe('READY');

    const empty = parseGrokStream('');
    expect(empty.format).toBe('empty');
    expect(empty.usage.source).toBe('unavailable');
    expect(empty.usage.inputTokens).toBeNull();
  });
});

describe('token totals', () => {
  it('sums only captured numbers and never invents a zero for missing usage', () => {
    const totals = sumTokenTotals([
      agentRun('a', 'full'),
      agentRun('b', 'full', { usage: usage({ inputTokens: 5_000, outputTokens: 25 }) }),
    ]);
    expect(totals.runs).toBe(2);
    expect(totals.runsWithUsage).toBe(2);
    expect(totals.inputTokens).toBe(25_000);
    expect(totals.outputTokens).toBe(75);

    const missing = sumTokenTotals([
      agentRun('c', 'full', {
        usage: {
          source: 'unavailable',
          inputTokens: null,
          outputTokens: null,
          cacheReadInputTokens: null,
          cacheCreationInputTokens: null,
          totalTokens: null,
          modelCalls: null,
        },
      }),
    ]);
    expect(missing.runsWithUsage).toBe(0);
    expect(missing.inputTokens).toBeNull();
    expect(missing.outputTokens).toBeNull();
  });
});

describe('report validation', () => {
  it('accepts a report whose totals match the captured runs', () => {
    const report = reportFixture();
    expect(() => validateAgentBenchmarkReport(report)).not.toThrow();
    expect(report.totals.full!.inputTokens).toBe(60_000);
    expect(report.totals.compact!.inputTokens).toBe(60_000);
  });

  it('rejects fabricated totals that do not match the captured runs', () => {
    const report = reportFixture();
    report.totals.full = { ...report.totals.full!, inputTokens: 1 };
    expect(() => validateAgentBenchmarkReport(report)).toThrow(/totals for full/);
  });

  it('rejects too few pairs and unhashed session ids', () => {
    const report = reportFixture();
    report.pairs = report.pairs.slice(0, 2);
    expect(() => validateAgentBenchmarkReport(report)).toThrow(/at least 3 paired/);

    const withRawSession = reportFixture();
    withRawSession.pairs[0]!.full.sessionHash = '01a10707-14e3-7a43-8615-a740f900d625';
    expect(() => validateAgentBenchmarkReport(withRawSession)).toThrow(/not hashed/);
  });
});

describe('summary and traces', () => {
  it('renders the actual captured totals, not placeholders', () => {
    const summary = formatAgentSummary(reportFixture());
    expect(summary).toContain('input=60000');
    expect(summary).toContain('output=150');
    expect(summary).toContain('grok meta-tools (constant): search_tool, use_tool');
    expect(summary).toContain('pair add-number: full passed=true');
    expect(summary).toContain(`[full] tools=${CATALOG_TOOL_COUNT + MATH_TOOL_COUNT}`);
    expect(summary).toContain('[compact] tools=2');
  });

  it('maps captured runs to agent TaskTrace entries', () => {
    const traces = toAgentTraces(reportFixture());
    expect(traces).toHaveLength(6);
    expect(traces.every((trace) => trace.kind === 'agent')).toBe(true);
    expect(traces[0]!.query).toBe(AGENT_BENCHMARK_TASKS[0]!.prompt);
    expect(traces[0]!.tool).toBe(AGENT_BENCHMARK_TASKS[0]!.expectation.expectedTool);
  });

  it('re-derives pass/fail and totals from captured NDJSON without new model runs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-rescore-'));
    try {
      writeFileSync(
        join(directory, 'full-add-number.ndjson'),
        [
          '{"type":"tool_call","toolCallId":"c1","toolName":"use_tool","rawInput":{"tool_name":"benchmark__math_add-5fvalue","tool_input":{"value":41}}}',
          '{"type":"text","data":"42"}',
          '{"type":"end","sessionId":"sid","usage":{"input_tokens":1000,"output_tokens":10,"total_tokens":1010},"num_turns":2}',
        ].join('\n'),
      );
      writeFileSync(
        join(directory, 'compact-add-number.ndjson'),
        [
          '{"type":"tool_call","toolCallId":"c1","toolName":"use_tool","rawInput":{"tool_name":"benchmark__search","tool_input":{"action":"find"}}}',
          '{"type":"tool_call","toolCallId":"c2","toolName":"use_tool","rawInput":{"tool_name":"benchmark__exec","tool_input":{"tool":"math_add-5fvalue"}}}',
          '{"type":"text","data":"value 42"}',
          '{"type":"end","sessionId":"sid2","usage":{"input_tokens":500,"output_tokens":5,"total_tokens":505},"num_turns":3}',
        ].join('\n'),
      );
      const task = AGENT_BENCHMARK_TASKS[0]!;
      const report: AgentBenchmarkReport = {
        generatedAt: 'fixture',
        round: DEFAULT_AGENT_ROUND,
        grokVersion: null,
        model: null,
        modes: ['full', 'compact'],
        footprints: {},
        grokTools: [],
        notes: [],
        totals: {},
        pairs: [
          {
            taskId: task.id,
            prompt: task.prompt,
            expectedTool: task.expectation.expectedTool,
            full: agentRun(task.id, 'full', {
              passed: false,
              usedExpectedTool: false,
              rawFile: join(directory, 'full-add-number.ndjson'),
            }),
            compact: agentRun(task.id, 'compact', {
              passed: false,
              usedExpectedTool: false,
              rawFile: join(directory, 'compact-add-number.ndjson'),
            }),
          },
        ],
      };
      rescoreReportFromRaw(report, directory);
      expect(report.pairs[0]!.full.passed).toBe(true);
      expect(report.pairs[0]!.compact.passed).toBe(true);
      expect(report.pairs[0]!.full.toolHomeCalls).toEqual(['math_add-5fvalue']);
      expect(report.pairs[0]!.compact.toolHomeCalls).toEqual([
        'search',
        'exec',
        'math_add-5fvalue',
      ]);
      // Totals are recomputed from the captured transcripts, not carried over.
      expect(report.totals.full!.inputTokens).toBe(1_000);
      expect(report.totals.compact!.inputTokens).toBe(500);
      expect(() => validateAgentBenchmarkReport(report, { minPairs: 1 })).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails when a report leaks an access secret or bearer credential', () => {
    const report = reportFixture();
    report.notes = ['Authorization: Bearer tch_mcp_abcdefghijklmno'];
    expect(() => assertNoSecrets(report, [])).toThrow(/bearer credential/);
    const clean = reportFixture();
    clean.notes = ['no credentials here'];
    expect(() => assertNoSecrets(clean, ['tch_mcp_secret'])).not.toThrow();
    clean.notes = ['contains tch_mcp_secret inline'];
    expect(() => assertNoSecrets(clean, ['tch_mcp_secret'])).toThrow(/leaked/);
  });
});

describe('cli defaults and round tagging', () => {
  it('defaults to stdout, no log, system scratch and round r1', () => {
    const options = parseAgentArgs([]);
    expect(options.out).toBe('-');
    expect(options.round).toBe(DEFAULT_AGENT_ROUND);
    expect(options.log).toBeUndefined();
    expect(options.scratchDir).toBeUndefined();
    expect(options.rawDir).toBeUndefined();
    expect(options.aggregate).toBeUndefined();
    expect(options.modes).toEqual(['full', 'compact']);
  });

  it('parses round, scratch, log and aggregate flags', () => {
    const options = parseAgentArgs([
      '--round',
      'r2',
      '--scratch',
      '/tmp/scratch',
      '--out',
      '/tmp/report.json',
      '--log',
      '/tmp/run.log',
      '--raw-dir',
      '/tmp/raw',
      '--aggregate',
      'a.json,b.json',
    ]);
    expect(options.round).toBe('r2');
    expect(options.scratchDir).toBe('/tmp/scratch');
    expect(options.out).toBe('/tmp/report.json');
    expect(options.log).toBe('/tmp/run.log');
    expect(options.rawDir).toBe('/tmp/raw');
    expect(options.aggregate).toEqual(['a.json', 'b.json']);
  });

  it('tags raw transcript names with the round', () => {
    expect(rawFileName('r2', 'full', 'add-number')).toBe('r2-full-add-number.ndjson');
    expect(rawFileName('r3', 'compact', 'read-mixed-value')).toBe(
      'r3-compact-read-mixed-value.ndjson',
    );
  });

  it('ships no hardcoded goal scratch path', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../scripts/benchmark-compact-agent.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('grok-goal');
    expect(source).not.toContain('/var/folders');
  });
});

describe('multi-round aggregation', () => {
  it('combines success, usage, cache, discovery and latency and keeps failures visible', () => {
    const r1 = reportFixture();
    r1.round = 'r1';
    const r2 = reportFixture();
    r2.round = 'r2';
    // One genuine failure in round 2 must survive into the aggregate.
    r2.pairs[0]!.full = agentRun('add-number', 'full', {
      passed: false,
      usedExpectedTool: false,
      durationMs: 9_000,
      usage: usage({
        inputTokens: 111,
        outputTokens: 11,
        cacheReadInputTokens: 5,
        totalTokens: 127,
      }),
    });
    r2.totals.full = sumTokenTotals(r2.pairs.map((pair) => pair.full));

    const aggregate = aggregateAgentReports([r1, r2]);
    expect(aggregate.rounds).toEqual(['r1', 'r2']);
    expect(aggregate.combined.full!.runs).toBe(6);
    expect(aggregate.combined.full!.passes).toBe(5);
    expect(aggregate.combined.full!.failures).toBe(1);
    // r1: 3 x 20000 input; r2: 2 x 20000 + 111.
    expect(aggregate.combined.full!.inputTokens).toBe(100_111);
    expect(aggregate.combined.full!.outputTokens).toBe(6 * 50 - 39);
    expect(aggregate.combined.full!.cacheReadInputTokens).toBe(5);
    expect(aggregate.combined.full!.totalTokens).toBe(5 * 20_050 + 127);
    expect(aggregate.combined.full!.meanTurns).toBe(3);
    expect(aggregate.combined.full!.totalDiscoveryCalls).toBe(6);
    expect(aggregate.combined.full!.p50LatencyMs).toBe(1_000);
    expect(aggregate.combined.full!.p95LatencyMs).toBe(9_000);
    expect(aggregate.tasks['add-number']!.full).toEqual({ runs: 2, passes: 1 });
    expect(aggregate.gate.passed).toBe(false);
    expect(aggregate.gate.failures).toEqual([{ round: 'r2', taskId: 'add-number', mode: 'full' }]);
    const summary = formatAggregateSummary(aggregate);
    expect(summary).toContain('rounds=r1,r2');
    expect(summary).toContain('combined full:');
    expect(summary).toContain('strict paired gate: FAIL');
    expect(summary).toContain('r2/add-number/full');
  });

  it('passes the strict paired gate only when every captured run passes', () => {
    const round = reportFixture();
    round.round = 'r1';
    const aggregate = aggregateAgentReports([round]);
    expect(aggregate.gate.passed).toBe(true);
    expect(aggregate.combined.compact!.passes).toBe(3);
    expect(formatAggregateSummary(aggregate)).toContain('strict paired gate: PASS');
  });
});
