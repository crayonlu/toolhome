/**
 * Real-agent full-vs-compact cost benchmark.
 *
 * Launches an isolated local ToolHome runtime (in-process `createTestRuntime`,
 * served over real HTTP) seeded with a representative many-tool catalog plus
 * the shipped arithmetic fixture, then drives the real `grok` CLI against the
 * runtime's `/mcp` endpoint through an ephemeral per-run project config that
 * disables the machine's existing MCP servers. Every metric comes from the captured grok
 * stream: token usage, turns, tool calls and outputs are parsed from the real
 * NDJSON; nothing is estimated or fabricated. When grok is unavailable the run
 * is reported `blocked` with the reason, never as a synthetic total.
 *
 * The fixture catalog is read-only apart from the arithmetic `add_value` tool,
 * which mutates only disposable per-run state. No remote/upstream server is
 * contacted: the only network traffic is loopback to the local fixtures.
 *
 * Usage:
 *   npx tsx scripts/benchmark-compact-agent.ts
 *   npx tsx scripts/benchmark-compact-agent.ts --tasks add-number --modes compact
 *   npx tsx scripts/benchmark-compact-agent.ts --out report.json --log run.log
 *
 * See `--help`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { CallToolRequestParamsSchema } from '@modelcontextprotocol/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, Server, type Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpToolMode } from '../src/config.js';
import { estimateTokens } from '../src/data-plane/compact-protocol.js';
import { aggregateToolName } from '../src/data-plane/virtualization.js';
import { SecretBox } from '../src/security/secret-box.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import { seedCompactCatalog } from '../tests/fixtures/compact-retrieval.js';
import { startCompactFixture } from '../tests/support/compact-fixture.js';
import { controlRequest, createTestRuntime, type TestRuntime } from '../tests/support/runtime.js';
import type { TaskTrace } from './benchmark-compact.js';

/** Round tag used when the caller does not supply one. */
export const DEFAULT_AGENT_ROUND = 'r1';
/** Raw-transcript directory name placed under the caller-supplied scratch base. */
export const RAW_DIR_NAME = 'agent-benchmark-runs';

/** Round-tagged raw transcript file name; keeps rounds from colliding. */
export function rawFileName(round: string, mode: McpToolMode, taskId: string): string {
  return `${round}-${mode}-${taskId}.ndjson`;
}

const CATALOG_MASTER_KEY = 'agent-benchmark-catalog-key-0000000000000000000000001';
const GROK_SERVER_ALIAS = 'benchmark';
const DISABLED_SERVERS = ['toolhome', 'toolhome-local'];
const PLACEHOLDER_SETTINGS = {
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  maxTotalTimeoutMs: 600_000,
  maxConcurrency: 1,
  restart: 'on-failure' as const,
};

// ── tasks ─────────────────────────────────────────────────────────────────

export interface AgentTaskExpectation {
  /** Exact aggregate tool id the task must exercise on the fixture. */
  expectedTool: string;
  /** Case-insensitive regex the final answer must match. */
  answerRegex?: string;
  /** Lower-case terms that must all appear in the final answer. */
  answerTerms?: string[];
}

export interface AgentBenchmarkTask {
  id: string;
  group: 'arithmetic' | 'read-only';
  /** User-style task prompt; deliberately names no tool or discovery strategy. */
  prompt: string;
  /** Disposable state mutation is only authorized for the arithmetic fixture. */
  mutatesFixtureState: boolean;
  expectation: AgentTaskExpectation;
}

export const AGENT_BENCHMARK_TASKS: AgentBenchmarkTask[] = [
  {
    id: 'add-number',
    group: 'arithmetic',
    mutatesFixtureState: true,
    prompt:
      'Using the benchmark MCP server only, increase the fixture current value by 41 and report the resulting numeric value. Do not use any other server or tool.',
    expectation: { expectedTool: aggregateToolName('math', 'add_value'), answerRegex: '\\b42\\b' },
  },
  {
    id: 'read-mixed-value',
    group: 'read-only',
    mutatesFixtureState: false,
    prompt:
      'Using the benchmark MCP server only, read the fixture mixed-content result and report the numeric value it contains. Do not use any other server or tool.',
    expectation: {
      expectedTool: aggregateToolName('math', 'mixed_result'),
      answerRegex: '\\b7\\b',
    },
  },
  {
    id: 'read-mixed-types',
    group: 'read-only',
    mutatesFixtureState: false,
    prompt:
      'Using the benchmark MCP server only, read the fixture mixed-content result and report the three content types it returns, in order. Do not use any other server or tool.',
    expectation: {
      expectedTool: aggregateToolName('math', 'mixed_result'),
      // The fixture returns `resource_link`; models frequently render the enum
      // as `resource`, so the shorter stem is what the answer is checked for.
      answerTerms: ['text', 'image', 'resource'],
    },
  },
];

// ── representative catalog ────────────────────────────────────────────────

/**
 * Flattens the shipped compact-retrieval fixture into one live catalog server
 * so full mode really lists many tool schemas. Visibility projections are
 * honoured (disabled server, hidden server/tool) and duplicate names are
 * de-duplicated with a provider prefix that keeps a single `__` when grok
 * qualifies it (`benchmark__github-search_repositories`).
 */
export function representativeCatalogTools(): Tool[] {
  const directory = mkdtempSync(join(tmpdir(), 'toolhome-agent-catalog-'));
  const store = new SqliteStore(
    join(directory, 'catalog.sqlite'),
    new SecretBox(CATALOG_MASTER_KEY),
  );
  try {
    seedCompactCatalog(store);
    const tools: Tool[] = [];
    const seen = new Set<string>();
    for (const server of [...store.listServers()].sort((a, b) => a.slug.localeCompare(b.slug))) {
      if (!server.enabled) continue;
      if (store.getServerProjection(server.id)?.defaultVisibility === 'hidden') continue;
      const snapshot = store.getSnapshot(server.id);
      if (!snapshot) continue;
      const hidden = new Set(
        store
          .listToolProjections(server.id)
          .filter((projection) => projection.visibility === 'hidden')
          .map((projection) => projection.upstreamToolName),
      );
      for (const tool of snapshot.tools) {
        if (hidden.has(tool.name)) continue;
        const name = `${server.slug}-${tool.name}`.replace(/[^A-Za-z0-9_-]/g, '-');
        if (seen.has(name)) continue;
        seen.add(name);
        tools.push({ ...tool, name });
      }
    }
    return tools;
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

// ── runtime fixtures ──────────────────────────────────────────────────────

export interface CatalogFixture {
  url: URL;
  tools: Tool[];
  close(): Promise<void>;
}

/** Live read-only HTTP MCP server exposing the representative catalog. */
export async function startCatalogFixture(tools: Tool[]): Promise<CatalogFixture> {
  const handler = createMcpHandler(
    () => {
      const server = new Server(
        { name: 'catalog-fixture', version: '1' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler('tools/list', () => ({ tools }));
      server.setRequestHandler(
        'tools/call',
        { params: CallToolRequestParamsSchema, result: z.looseObject({}) },
        async (request) => ({
          content: [
            { type: 'text' as const, text: JSON.stringify({ ok: true, tool: request.name }) },
          ],
        }),
      );
      return server;
    },
    { legacy: 'reject' },
  );
  const http = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => handler.fetch(request),
  });
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Catalog fixture port unavailable');
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    tools,
    async close() {
      await handler.close();
      await new Promise<void>((resolveClose, rejectClose) =>
        http.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    },
  };
}

// ── tools/list footprint ──────────────────────────────────────────────────

export interface ToolFootprint {
  mode: McpToolMode;
  count: number;
  bytes: number;
  estimatedTokens: number;
  names: string[];
}

async function measureToolFootprint(
  url: URL,
  accessKey: string,
  mode: McpToolMode,
): Promise<ToolFootprint> {
  const client = new Client({ name: 'toolhome-agent-footprint', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${accessKey}` } },
  });
  await client.connect(transport, { timeout: 15_000 });
  try {
    const listed = (await client.listTools()).tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    return {
      mode,
      count: listed.length,
      bytes: Buffer.byteLength(JSON.stringify(listed), 'utf8'),
      estimatedTokens: estimateTokens(listed),
      names: listed.map((tool) => tool.name),
    };
  } finally {
    await client.close();
  }
}

// ── isolated runtime launch ───────────────────────────────────────────────

export interface AgentRuntimeHandle {
  mode: McpToolMode;
  url: URL;
  /** MCP access secret; kept in memory only and never serialized. */
  accessKey: string;
  footprint: ToolFootprint;
  catalog: CatalogFixture;
  fixtureToolNames: string[];
  close(): Promise<void>;
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Probe port unavailable');
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

export async function launchAgentRuntime(options: {
  mode: McpToolMode;
  scratchDir?: string;
  catalogTools?: Tool[];
}): Promise<AgentRuntimeHandle> {
  const mode = options.mode;
  const base = options.scratchDir ?? tmpdir();
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(base, `toolhome-agent-${mode}-`));
  const port = await availablePort();
  const publicUrl = new URL(`http://127.0.0.1:${port}`);
  const testRuntime: TestRuntime = createTestRuntime({
    directory,
    persist: true,
    config: {
      host: '127.0.0.1',
      port,
      publicUrl,
      allowedHosts: ['127.0.0.1'],
      logLevel: 'error',
      marketDir: join(directory, 'market'),
      mcpToolMode: mode,
    },
  });
  const http = serve({
    hostname: '127.0.0.1',
    port,
    fetch: (request) => testRuntime.runtime.app.fetch(request),
  });
  let catalog: CatalogFixture | undefined;
  let fixture: Awaited<ReturnType<typeof startCompactFixture>> | undefined;
  try {
    await once(http, 'listening');
    const keyResponse = await controlRequest(
      testRuntime.runtime,
      testRuntime.controlKey,
      'POST',
      '/api/v1/access-keys',
      { name: `agent-benchmark-${mode}` },
    );
    const { secret } = (await keyResponse.json()) as { secret: string };

    fixture = await startCompactFixture();
    const math = testRuntime.runtime.store.createServer({
      slug: 'math',
      name: 'Arithmetic fixture',
      kind: 'remote',
      nodeId: null,
      transport: {
        type: 'streamable-http',
        url: fixture.url.toString(),
        protocolMode: 'modern',
        allowSseFallback: false,
        headers: {},
      },
      credentialId: null,
      enabled: true,
      settings: PLACEHOLDER_SETTINGS,
    });
    await testRuntime.runtime.upstreams.refresh(math.id);

    const catalogTools = options.catalogTools ?? representativeCatalogTools();
    catalog = await startCatalogFixture(catalogTools);
    const catalogServer = testRuntime.runtime.store.createServer({
      slug: 'catalog',
      name: 'Representative catalog',
      kind: 'remote',
      nodeId: null,
      transport: {
        type: 'streamable-http',
        url: catalog.url.toString(),
        protocolMode: 'modern',
        allowSseFallback: false,
        headers: {},
      },
      credentialId: null,
      enabled: true,
      settings: PLACEHOLDER_SETTINGS,
    });
    await testRuntime.runtime.upstreams.refresh(catalogServer.id);

    const footprint = await measureToolFootprint(new URL('/mcp', publicUrl), secret, mode);
    const mathSnapshot = testRuntime.runtime.store.getSnapshot(math.id);
    const fixtureToolNames = (mathSnapshot?.tools ?? []).map((tool) => tool.name);

    return {
      mode,
      url: new URL('/mcp', publicUrl),
      accessKey: secret,
      footprint,
      catalog,
      fixtureToolNames,
      async close() {
        await new Promise<void>((resolveClose) => {
          http.close(() => resolveClose());
        });
        await catalog?.close().catch(() => undefined);
        await fixture?.close().catch(() => undefined);
        await testRuntime.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await new Promise<void>((resolveClose) => {
      http.close(() => resolveClose());
    });
    await catalog?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    await testRuntime.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

// ── grok isolation config ─────────────────────────────────────────────────

/**
 * Builds the ephemeral project `.grok/config.toml` written into each run's
 * disposable cwd.
 *
 * The installed build's `GROK_CONFIG`/`GROK_CONFIG_PATH` overlay is confined to
 * an allowlist of soft settings (`models`, `features`, `toolset`,
 * `shell_environment_policy`) and silently drops `mcp_servers` /
 * `disabled_mcp_servers`, so MCP isolation cannot be injected through the
 * overlay. Project-scoped `.grok/config.toml` is the documented surface that
 * contributes `[mcp_servers]`; the file is created under a fresh temp cwd and
 * removed with it, so no user or persistent config is touched. A same-named
 * project entry replaces the user server entirely, which is how the machine's
 * `toolhome` servers are disabled.
 */
export function buildProjectConfig(options: { url: string; accessKey: string }): string {
  const disabled = DISABLED_SERVERS.map(
    (name) =>
      `[mcp_servers.${name}]\nurl = "http://127.0.0.1:1/disabled-${name}"\nenabled = false\n`,
  ).join('\n');
  return [
    `[mcp_servers.${GROK_SERVER_ALIAS}]`,
    `url = ${JSON.stringify(options.url)}`,
    `headers = { Authorization = ${JSON.stringify(`Bearer ${options.accessKey}`)} }`,
    'tool_timeout_sec = 120',
    '',
    disabled,
  ].join('\n');
}

// ── grok stream parsing ───────────────────────────────────────────────────

export interface GrokUsage {
  source: 'end' | 'summed' | 'unavailable';
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalTokens: number | null;
  modelCalls: number | null;
}

export interface GrokCall {
  name: string;
  /** Qualified ToolHome tool targeted by `use_tool` (e.g. benchmark__math_add-5fvalue). */
  target: string | null;
  /** For `use_tool` on the compact `exec` tool, the aggregate id in the arguments. */
  innerTool: string | null;
  inputHash: string | null;
}

export interface ParsedGrokRun {
  format: 'streaming' | 'json' | 'empty';
  finalText: string;
  calls: GrokCall[];
  toolHomeCalls: string[];
  grokTools: string[];
  usage: GrokUsage;
  numTurns: number | null;
  sessionId: string | null;
  requestId: string | null;
  stopReason: string | null;
  modelUsage: Record<string, unknown> | null;
  errors: string[];
  unparsedLines: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const EMPTY_USAGE: GrokUsage = {
  source: 'unavailable',
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
  totalTokens: null,
  modelCalls: null,
};

function readUsage(raw: unknown): GrokUsage {
  const usage = asRecord(raw);
  if (!usage) return { ...EMPTY_USAGE };
  const modelCalls = (() => {
    const models = asRecord(usage.modelUsage);
    if (!models) return null;
    const counts = Object.values(models)
      .map((model) => readNumber(asRecord(model)?.modelCalls))
      .filter((value): value is number => value !== null);
    return counts.length === 0 ? null : counts.reduce((sum, value) => sum + value, 0);
  })();
  return {
    source: 'end',
    inputTokens: readNumber(usage.input_tokens),
    outputTokens: readNumber(usage.output_tokens),
    cacheReadInputTokens: readNumber(usage.cache_read_input_tokens),
    cacheCreationInputTokens: readNumber(usage.cache_creation_input_tokens),
    totalTokens: readNumber(usage.total_tokens),
    modelCalls,
  };
}

function hashInput(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 16);
}

export function sha256Short(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function stripServerPrefix(target: string | null): string | null {
  if (target === null) return null;
  const prefix = `${GROK_SERVER_ALIAS}__`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}

/** Parses real `grok --output-format streaming-json` NDJSON (and `json`) output. */
export function parseGrokStream(stdout: string): ParsedGrokRun {
  const events: Record<string, unknown>[] = [];
  let unparsedLines = 0;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const record = asRecord(parsed);
      if (record && typeof record.type === 'string') events.push(record);
      else unparsedLines += 1;
    } catch {
      unparsedLines += 1;
    }
  }

  if (events.length === 0) {
    const whole = asRecord(
      (() => {
        try {
          return JSON.parse(stdout.trim()) as unknown;
        } catch {
          return null;
        }
      })(),
    );
    if (whole && (typeof whole.text === 'string' || whole.usage !== undefined)) {
      return {
        format: 'json',
        finalText: typeof whole.text === 'string' ? whole.text : '',
        calls: [],
        toolHomeCalls: [],
        grokTools: [],
        usage: readUsage(whole.usage),
        numTurns: readNumber(whole.num_turns),
        sessionId: typeof whole.sessionId === 'string' ? whole.sessionId : null,
        requestId: typeof whole.requestId === 'string' ? whole.requestId : null,
        stopReason: typeof whole.stopReason === 'string' ? whole.stopReason : null,
        modelUsage: asRecord(whole.modelUsage),
        errors: [],
        unparsedLines,
      };
    }
    return {
      format: 'empty',
      finalText: '',
      calls: [],
      toolHomeCalls: [],
      grokTools: [],
      usage: { ...EMPTY_USAGE },
      numTurns: null,
      sessionId: null,
      requestId: null,
      stopReason: null,
      modelUsage: null,
      errors: [],
      unparsedLines,
    };
  }

  const calls: GrokCall[] = [];
  const seenCallIds = new Set<string>();
  const texts: string[] = [];
  const errors: string[] = [];
  let grokTools: string[] = [];
  let endUsage: GrokUsage | null = null;
  let numTurns: number | null = null;
  let sessionId: string | null = null;
  let requestId: string | null = null;
  let stopReason: string | null = null;
  let modelUsage: Record<string, unknown> | null = null;
  const summed: Record<string, number | null> = {};

  for (const event of events) {
    switch (event.type) {
      case 'text':
        if (typeof event.data === 'string') texts.push(event.data);
        break;
      case 'tool_call': {
        const key = typeof event.toolCallId === 'string' ? event.toolCallId : `${calls.length}`;
        if (seenCallIds.has(key)) break;
        seenCallIds.add(key);
        const name = typeof event.toolName === 'string' ? event.toolName : 'unknown';
        const rawInput = asRecord(event.rawInput);
        const target =
          name === 'use_tool' && typeof rawInput?.tool_name === 'string'
            ? rawInput.tool_name
            : name === 'search_tool'
              ? 'search_tool'
              : null;
        const toolInput = asRecord(rawInput?.tool_input);
        const innerTool = typeof toolInput?.tool === 'string' ? toolInput.tool : null;
        calls.push({ name, target, innerTool, inputHash: hashInput(event.rawInput) });
        break;
      }
      case 'available_commands':
        if (Array.isArray(event.tools)) {
          grokTools = event.tools.filter((tool): tool is string => typeof tool === 'string');
        }
        break;
      case 'usage': {
        const usage = readUsage(event.usage);
        for (const field of [
          'inputTokens',
          'outputTokens',
          'cacheReadInputTokens',
          'cacheCreationInputTokens',
          'totalTokens',
        ] as const) {
          const value = usage[field];
          if (value === null) continue;
          summed[field] = (summed[field] ?? 0) + value;
        }
        break;
      }
      case 'end': {
        modelUsage = asRecord(event.modelUsage);
        endUsage = readUsage({ ...asRecord(event.usage), modelUsage });
        numTurns = readNumber(event.num_turns);
        sessionId = typeof event.sessionId === 'string' ? event.sessionId : null;
        requestId = typeof event.requestId === 'string' ? event.requestId : null;
        stopReason = typeof event.stopReason === 'string' ? event.stopReason : null;
        if (Array.isArray(event.errors)) {
          for (const item of event.errors) {
            if (typeof item === 'string') errors.push(item);
          }
        }
        break;
      }
      case 'error':
        if (typeof event.message === 'string') errors.push(event.message);
        break;
      default:
        break;
    }
  }

  const usage: GrokUsage = endUsage ?? {
    source: Object.keys(summed).length === 0 ? 'unavailable' : 'summed',
    inputTokens: summed.inputTokens ?? null,
    outputTokens: summed.outputTokens ?? null,
    cacheReadInputTokens: summed.cacheReadInputTokens ?? null,
    cacheCreationInputTokens: summed.cacheCreationInputTokens ?? null,
    totalTokens: summed.totalTokens ?? null,
    modelCalls: null,
  };

  const toolHomeCalls: string[] = [];
  for (const call of calls) {
    for (const candidate of [
      call.target === null ? null : stripServerPrefix(call.target),
      call.innerTool,
    ]) {
      if (candidate !== null && candidate.length > 0 && !toolHomeCalls.includes(candidate)) {
        toolHomeCalls.push(candidate);
      }
    }
  }

  return {
    format: 'streaming',
    finalText: texts.join(''),
    calls,
    toolHomeCalls,
    grokTools,
    usage,
    numTurns,
    sessionId,
    requestId,
    stopReason,
    modelUsage,
    errors,
    unparsedLines,
  };
}

// ── grok invocation ───────────────────────────────────────────────────────

export interface GrokRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runGrokAgent(options: {
  prompt: string;
  cwd: string;
  model?: string;
  maxTurns: number;
  timeoutMs?: number;
}): Promise<GrokRunResult> {
  const args = [
    '--single',
    options.prompt,
    '--output-format',
    'streaming-json',
    '--max-turns',
    String(options.maxTurns),
    '--no-subagents',
    '--always-approve',
    '--tools',
    'search_tool,use_tool',
    '--cwd',
    options.cwd,
  ];
  if (options.model !== undefined) args.push('--model', options.model);
  const started = performance.now();
  return new Promise<GrokRunResult>((resolveRun) => {
    const child = spawn('grok', args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 180_000);
    child.stdout.on('data', (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolveRun({
        exitCode: null,
        signal: null,
        timedOut,
        stdout,
        stderr: `${stderr}${String(error)}`,
        durationMs: performance.now() - started,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolveRun({
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: performance.now() - started,
      });
    });
  });
}

export function grokVersion(): string | null {
  try {
    return execFileSync('grok', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

// ── scoring + run records ─────────────────────────────────────────────────

export interface AgentRunResult {
  taskId: string;
  mode: McpToolMode;
  status: 'ok' | 'error';
  exitCode: number | null;
  error: string | null;
  sessionHash: string | null;
  usage: GrokUsage;
  numTurns: number | null;
  stopReason: string | null;
  durationMs: number;
  calls: GrokCall[];
  toolHomeCalls: string[];
  grokTools: string[];
  usedExpectedTool: boolean;
  passed: boolean;
  answerText: string;
  rawFile: string | null;
}

function scoreAnswer(task: AgentBenchmarkTask, text: string): boolean {
  const normalized = text.toLowerCase();
  if (task.expectation.answerRegex !== undefined) {
    return new RegExp(task.expectation.answerRegex, 'i').test(text);
  }
  if (task.expectation.answerTerms !== undefined) {
    return task.expectation.answerTerms.every((term) => normalized.includes(term.toLowerCase()));
  }
  return false;
}

// ── paired benchmark ──────────────────────────────────────────────────────

export interface AgentBenchmarkPair {
  taskId: string;
  prompt: string;
  expectedTool: string;
  full: AgentRunResult;
  compact: AgentRunResult;
}

export interface TokenTotals {
  runs: number;
  runsWithUsage: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalTokens: number | null;
}

function sumField(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
}

export function sumTokenTotals(runs: AgentRunResult[]): TokenTotals {
  return {
    runs: runs.length,
    runsWithUsage: runs.filter((run) => run.usage.source !== 'unavailable').length,
    inputTokens: sumField(runs.map((run) => run.usage.inputTokens)),
    outputTokens: sumField(runs.map((run) => run.usage.outputTokens)),
    cacheReadInputTokens: sumField(runs.map((run) => run.usage.cacheReadInputTokens)),
    cacheCreationInputTokens: sumField(runs.map((run) => run.usage.cacheCreationInputTokens)),
    totalTokens: sumField(runs.map((run) => run.usage.totalTokens)),
  };
}

export interface AgentBenchmarkReport {
  generatedAt: string;
  round: string;
  grokVersion: string | null;
  model: string | null;
  modes: McpToolMode[];
  footprints: Partial<Record<McpToolMode, ToolFootprint>>;
  grokTools: string[];
  pairs: AgentBenchmarkPair[];
  totals: Partial<Record<McpToolMode, TokenTotals>>;
  notes: string[];
}

export interface AgentBenchmarkOptions {
  modes?: McpToolMode[];
  taskIds?: string[];
  model?: string;
  maxTurns?: number;
  /** Round tag written into raw file names and the report; defaults to r1. */
  round?: string;
  /** Runtime/scratch base; defaults to the system temp directory. */
  scratchDir?: string;
  /** Raw transcript directory; defaults to <scratchDir>/agent-benchmark-runs. */
  rawDir?: string;
  log?: (line: string) => void;
}

async function runTask(
  handle: AgentRuntimeHandle,
  task: AgentBenchmarkTask,
  options: {
    projectConfig: string;
    model?: string;
    maxTurns: number;
    round: string;
    rawDir: string;
    cwdBase: string;
    secret: string;
  },
): Promise<AgentRunResult> {
  const cwd = mkdtempSync(join(options.cwdBase, `grok-${handle.mode}-${task.id}-`));
  mkdirSync(join(cwd, '.grok'), { recursive: true, mode: 0o700 });
  writeFileSync(join(cwd, '.grok', 'config.toml'), options.projectConfig, { mode: 0o600 });
  const result = await runGrokAgent({
    prompt: task.prompt,
    cwd,
    maxTurns: options.maxTurns,
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  rmSync(cwd, { recursive: true, force: true });

  const sanitize = (value: string): string =>
    options.secret.length === 0 ? value : value.split(options.secret).join('[redacted]');
  mkdirSync(options.rawDir, { recursive: true, mode: 0o700 });
  const rawFile = join(options.rawDir, rawFileName(options.round, handle.mode, task.id));
  writeFileSync(rawFile, sanitize(result.stdout), { mode: 0o600 });

  const parsed = parseGrokStream(result.stdout);
  const usedExpectedTool = parsed.toolHomeCalls.includes(task.expectation.expectedTool);
  const passed =
    parsed.format !== 'empty' && usedExpectedTool && scoreAnswer(task, parsed.finalText);
  const errorMessage = result.timedOut
    ? 'grok run timed out'
    : result.exitCode !== 0
      ? `grok exited ${String(result.exitCode)}: ${sanitize(result.stderr).trim().slice(0, 500)}`
      : parsed.errors.length > 0
        ? parsed.errors.join('; ').slice(0, 500)
        : null;

  return {
    taskId: task.id,
    mode: handle.mode,
    status: errorMessage === null ? 'ok' : 'error',
    exitCode: result.exitCode,
    error: errorMessage,
    sessionHash: parsed.sessionId === null ? null : sha256Short(parsed.sessionId),
    usage: parsed.usage,
    numTurns: parsed.numTurns,
    stopReason: parsed.stopReason,
    durationMs: Math.round(result.durationMs),
    calls: parsed.calls,
    toolHomeCalls: parsed.toolHomeCalls,
    grokTools: parsed.grokTools,
    usedExpectedTool,
    passed,
    answerText: parsed.finalText.trim().slice(0, 2_000),
    rawFile,
  };
}

export async function runAgentBenchmark(
  options: AgentBenchmarkOptions = {},
): Promise<AgentBenchmarkReport> {
  const modes = options.modes ?? (['full', 'compact'] as McpToolMode[]);
  const tasks = AGENT_BENCHMARK_TASKS.filter(
    (task) => options.taskIds === undefined || options.taskIds.includes(task.id),
  );
  if (tasks.length === 0) throw new Error('no benchmark tasks selected');
  const log = options.log ?? (() => undefined);
  const base = options.scratchDir ?? tmpdir();
  const round = options.round ?? DEFAULT_AGENT_ROUND;
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const cwdBase = mkdtempSync(join(base, 'agent-benchmark-cwd-'));
  const rawDir = options.rawDir ?? join(base, RAW_DIR_NAME);
  const maxTurns = options.maxTurns ?? 8;

  const report: AgentBenchmarkReport = {
    generatedAt: new Date().toISOString(),
    round,
    grokVersion: grokVersion(),
    model: options.model ?? null,
    modes,
    footprints: {},
    grokTools: [],
    pairs: [],
    totals: {},
    notes: [
      'Costs come only from captured grok usage; missing usage is reported unavailable, never zero.',
      'Runs may be non-zero cost even when a task answer check fails; failures are reported as-is.',
      'Only loopback fixtures are contacted; the arithmetic fixture state is disposable.',
      'MCP isolation uses an ephemeral per-run project .grok/config.toml because the installed build rejects mcp_servers in the GROK_CONFIG overlay.',
    ],
  };

  const runsByMode = new Map<McpToolMode, Map<string, AgentRunResult>>();
  try {
    for (const mode of modes) {
      const handle = await launchAgentRuntime({ mode, scratchDir: base });
      try {
        report.footprints[mode] = handle.footprint;
        const projectConfig = buildProjectConfig({
          url: handle.url.toString(),
          accessKey: handle.accessKey,
        });
        log(
          `[${mode}] runtime ${handle.url.toString()} tools=${handle.footprint.count} ` +
            `fixtureTools=${handle.fixtureToolNames.join(',')}`,
        );
        const runs = new Map<string, AgentRunResult>();
        for (const task of tasks) {
          log(`[${mode}] grok task=${task.id}`);
          const run = await runTask(handle, task, {
            projectConfig,
            maxTurns,
            round,
            rawDir,
            cwdBase,
            secret: handle.accessKey,
            ...(options.model === undefined ? {} : { model: options.model }),
          });
          log(
            `[${mode}] task=${task.id} passed=${run.passed} turns=${String(run.numTurns)} ` +
              `input=${String(run.usage.inputTokens)} output=${String(run.usage.outputTokens)} ` +
              `calls=${run.toolHomeCalls.join('|')}`,
          );
          runs.set(task.id, run);
          if (run.grokTools.length > 0) report.grokTools = run.grokTools;
        }
        runsByMode.set(mode, runs);
      } finally {
        await handle.close();
      }
    }
  } finally {
    rmSync(cwdBase, { recursive: true, force: true });
  }

  if (modes.includes('full') && modes.includes('compact')) {
    for (const task of tasks) {
      const full = runsByMode.get('full')?.get(task.id);
      const compact = runsByMode.get('compact')?.get(task.id);
      if (!full || !compact) continue;
      report.pairs.push({
        taskId: task.id,
        prompt: task.prompt,
        expectedTool: task.expectation.expectedTool,
        full,
        compact,
      });
    }
  }

  for (const mode of modes) {
    const runs = [...(runsByMode.get(mode)?.values() ?? [])];
    report.totals[mode] = sumTokenTotals(runs);
  }

  validateAgentBenchmarkReport(report, { minPairs: report.pairs.length > 0 ? 1 : 0 });
  return report;
}

// ── validation + sanitization ─────────────────────────────────────────────

function totalsEqual(left: TokenTotals | undefined, right: TokenTotals): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Validates that the report is internally consistent: paired modes are present,
 * session ids are hashed, and per-mode totals are exactly the recomputed sums
 * of captured runs (so a fabricated total cannot pass).
 */
export function validateAgentBenchmarkReport(
  report: AgentBenchmarkReport,
  options: { minPairs?: number } = {},
): void {
  const minPairs = options.minPairs ?? 3;
  if (report.pairs.length < minPairs) {
    throw new Error(`expected at least ${minPairs} paired task runs, found ${report.pairs.length}`);
  }
  for (const pair of report.pairs) {
    if (pair.full.mode !== 'full' || pair.compact.mode !== 'compact') {
      throw new Error(`pair ${pair.taskId} is not full/compact ordered`);
    }
    if (pair.full.taskId !== pair.compact.taskId) {
      throw new Error(`pair ${pair.taskId} task ids differ across modes`);
    }
    for (const run of [pair.full, pair.compact]) {
      if (run.sessionHash !== null && !/^[0-9a-f]{16}$/.test(run.sessionHash)) {
        throw new Error(`run ${run.taskId}/${run.mode} session id was not hashed`);
      }
    }
  }
  if (report.pairs.length > 0) {
    for (const mode of report.modes) {
      const runs = report.pairs.map((pair) => (mode === 'full' ? pair.full : pair.compact));
      const expected = sumTokenTotals(runs);
      if (!totalsEqual(report.totals[mode], expected)) {
        throw new Error(`totals for ${mode} do not match the captured runs`);
      }
    }
  }
}

/**
 * Re-derives call traces and pass/fail for an existing report from the raw grok
 * transcripts saved beside it. Token usage, durations, footprints and session
 * hashes are left exactly as captured; nothing is re-estimated. This makes a
 * scoring change auditable without spending new model runs.
 */
export function rescoreReportFromRaw(
  report: AgentBenchmarkReport,
  rawDir: string,
): AgentBenchmarkReport {
  const tasks = new Map(AGENT_BENCHMARK_TASKS.map((task) => [task.id, task]));
  for (const pair of report.pairs) {
    for (const run of [pair.full, pair.compact]) {
      const task = tasks.get(run.taskId);
      if (!task) continue;
      const rawFile =
        run.rawFile ??
        join(rawDir, rawFileName(report.round ?? DEFAULT_AGENT_ROUND, run.mode, run.taskId));
      const parsed = parseGrokStream(readFileSync(rawFile, 'utf8'));
      run.rawFile = rawFile;
      run.calls = parsed.calls;
      run.toolHomeCalls = parsed.toolHomeCalls;
      run.usage = parsed.usage;
      run.numTurns = parsed.numTurns;
      run.stopReason = parsed.stopReason;
      run.answerText = parsed.finalText.trim().slice(0, 2_000);
      run.usedExpectedTool = parsed.toolHomeCalls.includes(task.expectation.expectedTool);
      run.passed =
        run.status === 'ok' && run.usedExpectedTool && scoreAnswer(task, parsed.finalText);
    }
  }
  for (const mode of report.modes) {
    report.totals[mode] = sumTokenTotals(
      report.pairs.map((pair) => (mode === 'full' ? pair.full : pair.compact)),
    );
  }
  return report;
}

/** Reports `blocked` when the environment cannot produce real numbers. */
export function assertNoSecrets(report: AgentBenchmarkReport, secrets: string[]): void {
  const serialized = JSON.stringify(report);
  for (const secret of secrets) {
    if (secret.length > 0 && serialized.includes(secret)) {
      throw new Error('report leaked an access secret');
    }
  }
  if (/Bearer\s+[A-Za-z0-9._~+/-]{12,}/.test(serialized)) {
    throw new Error('report contains a bearer credential');
  }
}

// ── summary + trace export ────────────────────────────────────────────────

function num(value: number | null): string {
  return value === null ? 'unavailable' : String(value);
}

export function formatAgentSummary(report: AgentBenchmarkReport): string {
  const lines: string[] = [];
  lines.push(
    `agent compact benchmark — round=${report.round} generated=${report.generatedAt} grok=${report.grokVersion ?? 'unavailable'} model=${report.model ?? 'default'}`,
  );
  for (const mode of report.modes) {
    const footprint = report.footprints[mode];
    const totals = report.totals[mode];
    lines.push(
      `  [${mode}] tools=${footprint?.count ?? 'unavailable'}` +
        ` schemaBytes=${footprint?.bytes ?? 'unavailable'}` +
        ` estTokens=${footprint?.estimatedTokens ?? 'unavailable'}`,
    );
    lines.push(
      `  [${mode}] runs=${totals?.runs ?? 0} withUsage=${totals?.runsWithUsage ?? 0}` +
        ` input=${num(totals?.inputTokens ?? null)} output=${num(totals?.outputTokens ?? null)}` +
        ` cacheRead=${num(totals?.cacheReadInputTokens ?? null)}`,
    );
  }
  for (const pair of report.pairs) {
    lines.push(
      `  pair ${pair.taskId}: full passed=${pair.full.passed} input=${num(pair.full.usage.inputTokens)}` +
        ` calls=[${pair.full.toolHomeCalls.join(', ')}] | compact passed=${pair.compact.passed}` +
        ` input=${num(pair.compact.usage.inputTokens)} calls=[${pair.compact.toolHomeCalls.join(', ')}]`,
    );
  }
  if (report.grokTools.length > 0) {
    lines.push(`  grok meta-tools (constant): ${report.grokTools.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Maps captured agent runs to the shared `TaskTrace` shape for pairing. */
export function toAgentTraces(report: AgentBenchmarkReport): TaskTrace[] {
  const traces: TaskTrace[] = [];
  for (const pair of report.pairs) {
    for (const run of [pair.full, pair.compact]) {
      traces.push({
        taskId: run.taskId,
        kind: 'agent',
        query: pair.prompt,
        tool: run.toolHomeCalls[0] ?? null,
        latencyMs: run.durationMs,
        resultBytes: run.answerText.length,
        error: run.error,
      });
    }
  }
  return traces;
}

// ── multi-round aggregation ───────────────────────────────────────────────

export interface AggregateModeStats {
  mode: McpToolMode;
  runs: number;
  passes: number;
  failures: number;
  runsWithUsage: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalTokens: number | null;
  meanTurns: number | null;
  totalToolCalls: number;
  totalDiscoveryCalls: number;
  meanDiscoveryCalls: number | null;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface RoundAgentSummary {
  round: string;
  generatedAt: string;
  footprints: Partial<Record<McpToolMode, ToolFootprint>>;
  modes: Partial<Record<McpToolMode, AggregateModeStats>>;
}

export interface AgentBenchmarkAggregate {
  generatedAt: string;
  grokVersion: string | null;
  rounds: string[];
  perRound: RoundAgentSummary[];
  combined: Partial<Record<McpToolMode, AggregateModeStats>>;
  tasks: Record<string, Partial<Record<McpToolMode, { runs: number; passes: number }>>>;
  gate: {
    strictPaired: boolean;
    passed: boolean;
    failures: { round: string; taskId: string; mode: McpToolMode }[];
  };
  notes: string[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function isDiscoveryCall(call: GrokCall): boolean {
  if (call.name === 'search_tool') return true;
  return call.target !== null && call.target.endsWith('__search');
}

function runsForMode(report: AgentBenchmarkReport, mode: McpToolMode): AgentRunResult[] {
  return report.pairs.map((pair) => (mode === 'full' ? pair.full : pair.compact));
}

export function modeStats(mode: McpToolMode, runs: AgentRunResult[]): AggregateModeStats {
  const totals = sumTokenTotals(runs);
  const latencies = runs.map((run) => run.durationMs).sort((left, right) => left - right);
  const turns = runs.map((run) => run.numTurns).filter((value): value is number => value !== null);
  const discovery = runs.map((run) => run.calls.filter(isDiscoveryCall).length);
  return {
    mode,
    runs: runs.length,
    passes: runs.filter((run) => run.passed).length,
    failures: runs.filter((run) => !run.passed).length,
    runsWithUsage: totals.runsWithUsage,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens,
    totalTokens: totals.totalTokens,
    meanTurns:
      turns.length === 0 ? null : turns.reduce((sum, value) => sum + value, 0) / turns.length,
    totalToolCalls: runs.reduce((sum, run) => sum + run.calls.length, 0),
    totalDiscoveryCalls: discovery.reduce((sum, value) => sum + value, 0),
    meanDiscoveryCalls:
      discovery.length === 0
        ? null
        : discovery.reduce((sum, value) => sum + value, 0) / discovery.length,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
  };
}

/** Combines round reports into success, usage, discovery and latency aggregates. */
export function aggregateAgentReports(reports: AgentBenchmarkReport[]): AgentBenchmarkAggregate {
  if (reports.length === 0) throw new Error('at least one round report is required');
  const rounds = reports.map((report) => report.round ?? DEFAULT_AGENT_ROUND);
  const modes = [...new Set(reports.flatMap((report) => report.modes))];
  const perRound: RoundAgentSummary[] = reports.map((report) => ({
    round: report.round ?? DEFAULT_AGENT_ROUND,
    generatedAt: report.generatedAt,
    footprints: report.footprints,
    modes: Object.fromEntries(
      report.modes.map((mode) => [mode, modeStats(mode, runsForMode(report, mode))]),
    ),
  }));
  const combined: Partial<Record<McpToolMode, AggregateModeStats>> = {};
  for (const mode of modes) {
    combined[mode] = modeStats(
      mode,
      reports.flatMap((report) => runsForMode(report, mode)),
    );
  }
  const tasks: AgentBenchmarkAggregate['tasks'] = {};
  const failures: AgentBenchmarkAggregate['gate']['failures'] = [];
  for (const report of reports) {
    const round = report.round ?? DEFAULT_AGENT_ROUND;
    for (const pair of report.pairs) {
      for (const run of [pair.full, pair.compact]) {
        const bucket = (tasks[run.taskId] ??= {});
        const entry = (bucket[run.mode] ??= { runs: 0, passes: 0 });
        entry.runs += 1;
        if (run.passed) entry.passes += 1;
        else failures.push({ round, taskId: run.taskId, mode: run.mode });
      }
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    grokVersion:
      reports.map((report) => report.grokVersion).find((value) => value !== null) ?? null,
    rounds,
    perRound,
    combined,
    tasks,
    gate: { strictPaired: true, passed: failures.length === 0, failures },
    notes: [
      'Per-round and combined figures are sums/counts over the captured runs; no value is estimated.',
      'The strict paired gate passes only when every task/mode/round run passes its answer check.',
      'A failing run is retained in every aggregate; it is never dropped or re-run to force a pass.',
    ],
  };
}

function modeLine(stats: AggregateModeStats | undefined): string {
  if (!stats) return 'unavailable';
  return (
    `runs=${stats.runs} passes=${stats.passes} failures=${stats.failures} ` +
    `input=${num(stats.inputTokens)} output=${num(stats.outputTokens)} ` +
    `cacheRead=${num(stats.cacheReadInputTokens)} total=${num(stats.totalTokens)} ` +
    `meanTurns=${stats.meanTurns === null ? 'unavailable' : stats.meanTurns.toFixed(1)} ` +
    `discoveryCalls=${stats.totalDiscoveryCalls} ` +
    `p50=${stats.p50LatencyMs}ms p95=${stats.p95LatencyMs}ms`
  );
}

export function formatAggregateSummary(aggregate: AgentBenchmarkAggregate): string {
  const lines: string[] = [];
  lines.push(
    `agent compact benchmark aggregate — rounds=${aggregate.rounds.join(',')} generated=${aggregate.generatedAt} grok=${aggregate.grokVersion ?? 'unavailable'}`,
  );
  for (const round of aggregate.perRound) {
    lines.push(`  [${round.round}]`);
    for (const [mode, stats] of Object.entries(round.modes)) {
      lines.push(`    ${mode}: ${modeLine(stats)}`);
    }
  }
  for (const [mode, stats] of Object.entries(aggregate.combined)) {
    lines.push(`  combined ${mode}: ${modeLine(stats)}`);
  }
  for (const [taskId, modes] of Object.entries(aggregate.tasks)) {
    const parts = Object.entries(modes).map(
      ([mode, entry]) => `${mode}=${entry!.passes}/${entry!.runs}`,
    );
    lines.push(`  task ${taskId}: ${parts.join(' ')}`);
  }
  lines.push(
    `  strict paired gate: ${aggregate.gate.passed ? 'PASS' : 'FAIL'}` +
      (aggregate.gate.failures.length === 0
        ? ''
        : ` failures=${aggregate.gate.failures
            .map((item) => `${item.round}/${item.taskId}/${item.mode}`)
            .join(',')}`),
  );
  return `${lines.join('\n')}\n`;
}

// ── CLI ───────────────────────────────────────────────────────────────────

interface CliOptions {
  modes: McpToolMode[];
  taskIds?: string[];
  model?: string;
  maxTurns: number;
  /** Report path, or `-` for stdout. */
  out: string;
  /** Append-only log path; no log file is written when omitted. */
  log?: string;
  scratchDir?: string;
  rawDir?: string;
  round: string;
  rescore: boolean;
  /** Round report paths to combine; enables aggregate mode. */
  aggregate?: string[];
  help: boolean;
}

export function parseAgentArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    modes: ['full', 'compact'],
    maxTurns: 8,
    out: '-',
    round: DEFAULT_AGENT_ROUND,
    rescore: false,
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
      case '--modes':
        options.modes = value()
          .split(',')
          .map((mode) => mode.trim())
          .filter((mode): mode is McpToolMode => mode === 'full' || mode === 'compact');
        break;
      case '--tasks':
        options.taskIds = value()
          .split(',')
          .map((task) => task.trim())
          .filter(Boolean);
        break;
      case '--model':
        options.model = value();
        break;
      case '--max-turns':
        options.maxTurns = Number(value());
        break;
      case '--out':
        options.out = value();
        break;
      case '--log':
        options.log = value();
        break;
      case '--scratch':
        options.scratchDir = value();
        break;
      case '--rescore':
        options.rescore = true;
        break;
      case '--raw-dir':
        options.rawDir = value();
        break;
      case '--round':
        options.round = value();
        break;
      case '--aggregate':
        options.aggregate = value()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
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

function appendLog(path: string, line: string): void {
  try {
    mkdirSync(resolve(path, '..'), { recursive: true });
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Logging must never fail the benchmark.
  }
}

function helpText(): string {
  return [
    'Usage: tsx scripts/benchmark-compact-agent.ts [options]',
    '',
    '  --modes <list>      full | compact (default both)',
    `  --tasks <list>      task ids (default: ${AGENT_BENCHMARK_TASKS.map((task) => task.id).join(',')})`,
    '  --model <id>        grok model id (default: CLI default)',
    '  --max-turns <n>     grok max turns (default 8)',
    '  --round <label>     round tag for raw/aggregate evidence (default r1)',
    '  --out <path>        report JSON path (default stdout)',
    '  --log <path>        append-only log path (no log file by default)',
    '  --scratch <dir>     scratch base for ephemeral runtime data (default system temp)',
    '  --raw-dir <dir>     raw transcript directory (default <scratch>/agent-benchmark-runs)',
    '  --rescore           re-derive pass/fail from captured raw transcripts in <out>, no model runs',
    '  --aggregate <list>  combine round report JSON paths into one aggregate report',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseAgentArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (options.out !== '-' && !isAbsolute(options.out)) options.out = resolve(options.out);
  const writeOut = (contents: string): void => {
    if (options.out === '-') process.stdout.write(contents);
    else writeFileSync(options.out, contents);
  };
  if (options.aggregate !== undefined) {
    const reports = options.aggregate.map(
      (path) => JSON.parse(readFileSync(path, 'utf8')) as AgentBenchmarkReport,
    );
    const aggregate = aggregateAgentReports(reports);
    writeOut(`${JSON.stringify(aggregate, null, 2)}\n`);
    if (options.out !== '-') process.stdout.write(formatAggregateSummary(aggregate));
    return;
  }
  if (options.rescore) {
    if (options.out === '-') throw new Error('--rescore needs a file --out');
    const raw = JSON.parse(readFileSync(options.out, 'utf8')) as AgentBenchmarkReport;
    rescoreReportFromRaw(raw, options.rawDir ?? join(tmpdir(), RAW_DIR_NAME));
    validateAgentBenchmarkReport(raw, { minPairs: raw.pairs.length > 0 ? 1 : 0 });
    assertNoSecrets(raw, []);
    writeFileSync(options.out, `${JSON.stringify(raw, null, 2)}\n`);
    process.stdout.write(formatAgentSummary(raw));
    return;
  }
  const logPath = options.log;
  const log = (line: string): void => {
    if (logPath !== undefined) appendLog(logPath, line);
  };
  log(`run start round=${options.round} argv=${process.argv.slice(2).join(' ')}`);
  const report = await runAgentBenchmark({
    modes: options.modes,
    maxTurns: options.maxTurns,
    round: options.round,
    ...(options.taskIds === undefined ? {} : { taskIds: options.taskIds }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.scratchDir === undefined ? {} : { scratchDir: options.scratchDir }),
    ...(options.rawDir === undefined ? {} : { rawDir: options.rawDir }),
    log,
  });
  writeOut(`${JSON.stringify(report, null, 2)}\n`);
  if (options.out !== '-') process.stdout.write(formatAgentSummary(report));
  log(`run complete round=${options.round} pairs=${report.pairs.length} out=${options.out}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `agent benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
