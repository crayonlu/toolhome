/**
 * Repeated real-launch verification for compact/full tool exposure.
 *
 * Starts the built HTTP service (`dist/server/main.js`) as a real process,
 * configures disposable SQLite records through the real Control API, seeds the
 * CLI's local mirror, then launches the built CLI (`dist/server/cli/main.js mcp
 * stdio`) as a real stdio process and drives both surfaces with real SDK
 * clients. `--tool-mode` is exercised in both `compact` and `full`.
 *
 * Run `npm run build:server` first. Logs go to `TOOLHOME_LAUNCH_LOG` (defaults
 * under the private scratch dir) and data lives in `TOOLHOME_LAUNCH_SCRATCH`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { ControlClient } from '../src/control/client.js';
import { prepareLocalGateway } from '../src/node/local-gateway.js';
import { aggregateToolName } from '../src/data-plane/virtualization.js';
import {
  compactFixtureDefinition,
  createCompactFixtureState,
  startCompactFixture,
} from '../tests/support/compact-fixture.js';

export type LaunchMode = 'compact' | 'full';

export interface CompactLaunchOptions {
  mode: LaunchMode;
  /** Base directory for disposable run data; a unique child directory is removed afterwards. */
  scratchDir?: string;
  /** Append-only log destination. Defaults next to the scratch base so cleanup keeps it. */
  logFile?: string;
}

export interface SurfaceReport {
  tools: string[];
  servers?: Record<string, unknown>;
  find?: Record<string, unknown>;
  describe?: Record<string, unknown>;
  mixedDescribe?: Record<string, unknown>;
  exec?: unknown;
  mixed?: { structuredContent?: unknown; meta?: unknown; contentTypes: unknown[] };
  native?: unknown;
}

export interface CompactLaunchReport {
  mode: LaunchMode;
  serviceUrl: string;
  nodeId: string;
  logFile: string;
  expectedInputSchema: unknown;
  hostToolId: string;
  hostMixedId: string;
  localToolId: string;
  localMixedId: string;
  host: SurfaceReport;
  local: SurfaceReport;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distService = join(projectRoot, 'dist', 'server', 'main.js');
const distCli = join(projectRoot, 'dist', 'server', 'cli', 'main.js');
const nodeFixture = join(projectRoot, 'tests', 'fixtures', 'compact-launch-server.ts');
const legacyFixture = join(projectRoot, 'tests', 'fixtures', 'compact-legacy-server.ts');

const MASTER_KEY = 'compact-launch-master-key-00000000000000000000000001';
const CONTROL_KEY = 'tch_ctl_compact-launch-bootstrap-000000000000000000001';
const NODE_ID = 'launch-node';

const accessKeySchema = z.looseObject({ secret: z.string() });
const serverRecordSchema = z.object({ id: z.string() });
const textResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).min(1),
});

function payload(value: unknown): Record<string, unknown> {
  const parsed = textResultSchema.parse(value);
  const text = parsed.content.find((item) => item.type === 'text')?.text;
  if (text === undefined) throw new Error('Text result missing');
  return JSON.parse(text) as Record<string, unknown>;
}

async function inspectSurface(
  client: Client,
  mode: LaunchMode,
  toolId: string,
  mixedId: string,
): Promise<SurfaceReport> {
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  const report: SurfaceReport = { tools };
  if (mode === 'full') {
    const native = z
      .looseObject({})
      .parse(await client.callTool({ name: toolId, arguments: { value: 41 } }));
    report.native = native.structuredContent;
    return report;
  }
  report.servers = payload(
    await client.callTool({ name: 'search', arguments: { action: 'servers' } }),
  );
  report.find = payload(
    await client.callTool({ name: 'search', arguments: { action: 'find', query: 'add number' } }),
  );
  const describe = payload(
    await client.callTool({ name: 'search', arguments: { action: 'describe', tool: toolId } }),
  );
  report.describe = describe;
  report.mixedDescribe = payload(
    await client.callTool({ name: 'search', arguments: { action: 'describe', tool: mixedId } }),
  );
  report.exec = payload(
    await client.callTool({
      name: 'exec',
      arguments: { tool: toolId, arguments: { value: 41 }, definition: describe.definition },
    }),
  );
  const mixed = z
    .looseObject({})
    .parse(await client.callTool({ name: 'exec', arguments: { tool: mixedId, arguments: {} } }));
  report.mixed = {
    structuredContent: mixed.structuredContent,
    meta: mixed._meta,
    contentTypes: Array.isArray(mixed.content)
      ? (mixed.content as { type?: unknown }[]).map((item) => item.type)
      : [],
  };
  return report;
}

export async function runCompactLaunch(
  options: CompactLaunchOptions,
): Promise<CompactLaunchReport> {
  const mode = options.mode;
  const scratchBase = options.scratchDir ?? tmpdir();
  mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
  const runDir = mkdtempSync(join(scratchBase, `toolhome-launch-${mode}-`));
  const dataDir = join(runDir, 'data');
  const localDir = join(runDir, 'local');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(localDir, { recursive: true, mode: 0o700 });
  const logFile = options.logFile ?? join(scratchBase, `toolhome-compact-launch-${mode}.log`);
  mkdirSync(dirname(logFile), { recursive: true });
  const log = (line: string): void => {
    appendFileSync(logFile, `[${new Date().toISOString()}] [${mode}] ${line}\n`);
  };
  log(`launch start runDir=${runDir}`);

  const clients: Client[] = [];
  let service: ChildProcess | undefined;
  let fixture: Awaited<ReturnType<typeof startCompactFixture>> | undefined;
  try {
    if (!existsSync(distService) || !existsSync(distCli)) {
      throw new Error(
        `Built artifacts missing; run "npm run build:server" (${distService}, ${distCli})`,
      );
    }
    fixture = await startCompactFixture();
    const port = await availablePort();
    const serviceUrl = new URL(`http://127.0.0.1:${port}`);
    service = spawn(process.execPath, [distService], {
      cwd: projectRoot,
      env: {
        ...process.env,
        TOOLHOME_HOST: '127.0.0.1',
        TOOLHOME_PORT: String(port),
        TOOLHOME_PUBLIC_URL: serviceUrl.toString(),
        TOOLHOME_DATA_DIR: dataDir,
        TOOLHOME_MASTER_KEY: MASTER_KEY,
        TOOLHOME_BOOTSTRAP_CONTROL_KEY: CONTROL_KEY,
        TOOLHOME_ALLOWED_HOSTS: '127.0.0.1',
        TOOLHOME_LOG_LEVEL: 'info',
        TOOLHOME_MCP_TOOL_MODE: mode,
        TOOLHOME_OAUTH_REFRESH_INTERVAL_SECONDS: '3600',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    service.stdout?.on('data', (chunk: unknown) => log(`[service:out] ${String(chunk).trimEnd()}`));
    service.stderr?.on('data', (chunk: unknown) => log(`[service:err] ${String(chunk).trimEnd()}`));
    await waitForHealth(new URL('/healthz', serviceUrl), service);
    log(`service healthy at ${serviceUrl.toString()}`);

    const remote = serverRecordSchema.parse(
      await control(serviceUrl, 'POST', '/api/v1/servers', {
        slug: 'remote-math',
        name: 'Remote arithmetic fixture',
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
      }),
    );
    await control(serviceUrl, 'POST', `/api/v1/servers/${remote.id}/refresh`);
    const localMath = serverRecordSchema.parse(
      await control(serviceUrl, 'POST', '/api/v1/servers', {
        slug: 'math',
        name: 'Local arithmetic fixture',
        kind: 'node',
        nodeId: NODE_ID,
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', nodeFixture],
          env: {},
          protocolMode: 'legacy',
        },
        credentialId: null,
        enabled: true,
      }),
    );
    const localLegacy = serverRecordSchema.parse(
      await control(serviceUrl, 'POST', '/api/v1/servers', {
        slug: 'legacy',
        name: 'Local legacy fixture',
        kind: 'node',
        nodeId: NODE_ID,
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', legacyFixture],
          env: {},
          protocolMode: 'legacy',
        },
        credentialId: null,
        enabled: true,
      }),
    );
    log(`records remote=${remote.id} math=${localMath.id} legacy=${localLegacy.id}`);

    const access = accessKeySchema.parse(
      await control(serviceUrl, 'POST', '/api/v1/access-keys', { name: `compact-launch-${mode}` }),
    );

    // Seed the local mirror through the same real client the CLI uses, so the
    // stdio process starts with the capability snapshots it serves from.
    const storePath = join(localDir, 'node.sqlite');
    const configPath = join(localDir, 'config.json');
    writeFileSync(
      configPath,
      `${JSON.stringify({ url: serviceUrl.toString(), controlKey: CONTROL_KEY, nodeId: NODE_ID }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const seed = await prepareLocalGateway({
      client: new ControlClient(serviceUrl, CONTROL_KEY),
      nodeId: NODE_ID,
      storePath,
      toolMode: mode,
    });
    try {
      log(`mirror seeded: ${JSON.stringify(await seed.discoverSnapshots())}`);
    } finally {
      await seed.close();
      seed.store.close();
    }

    const hostClient = new Client(
      { name: 'compact-launch-host', version: '1.0.0' },
      { capabilities: {} },
    );
    clients.push(hostClient);
    await hostClient.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', serviceUrl), {
        requestInit: { headers: { authorization: `Bearer ${access.secret}` } },
      }),
      { timeout: 20_000 },
    );
    const host = await inspectSurface(
      hostClient,
      mode,
      aggregateToolName('remote-math', 'add_value'),
      aggregateToolName('remote-math', 'mixed_result'),
    );
    await hostClient.close();
    log(`host surface: ${JSON.stringify(host.tools)}`);

    const cliTransport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, 'mcp', 'stdio', '--node', NODE_ID, '--tool-mode', mode],
      env: {
        ...process.env,
        TOOLHOME_URL: serviceUrl.toString(),
        TOOLHOME_CONTROL_KEY: CONTROL_KEY,
        TOOLHOME_CONFIG: configPath,
        TOOLHOME_LOG_LEVEL: 'error',
      },
      cwd: projectRoot,
      stderr: 'pipe',
    });
    cliTransport.stderr?.on('data', (chunk: unknown) =>
      log(`[cli:err] ${String(chunk).trimEnd()}`),
    );
    const cliClient = new Client(
      { name: 'compact-launch-cli', version: '1.0.0' },
      { capabilities: {} },
    );
    clients.push(cliClient);
    await cliClient.connect(cliTransport, { timeout: 20_000 });
    const local = await inspectSurface(
      cliClient,
      mode,
      aggregateToolName('math', 'add_value'),
      aggregateToolName('math', 'mixed_result'),
    );
    log(`local surface: ${JSON.stringify(local.tools)}`);
    await cliClient.close();

    return {
      mode,
      serviceUrl: serviceUrl.toString(),
      nodeId: NODE_ID,
      logFile,
      expectedInputSchema: compactFixtureDefinition(createCompactFixtureState()).inputSchema,
      hostToolId: aggregateToolName('remote-math', 'add_value'),
      hostMixedId: aggregateToolName('remote-math', 'mixed_result'),
      localToolId: aggregateToolName('math', 'add_value'),
      localMixedId: aggregateToolName('math', 'mixed_result'),
      host,
      local,
    };
  } finally {
    for (const client of clients.reverse()) await client.close().catch(() => undefined);
    if (service !== undefined) await stopChild(service);
    if (fixture !== undefined) await fixture.close().catch(() => undefined);
    rmSync(runDir, { recursive: true, force: true });
    log(`launch done mode=${mode}`);
  }
}

/** Assert the collected surface facts; shared by the script and the durability test. */
export function verifyCompactLaunch(report: CompactLaunchReport): void {
  const surfaces: {
    label: 'host' | 'local';
    surface: SurfaceReport;
    toolId: string;
    mixedId: string;
    slug: string;
  }[] = [
    {
      label: 'host',
      surface: report.host,
      toolId: report.hostToolId,
      mixedId: report.hostMixedId,
      slug: 'remote-math',
    },
    {
      label: 'local',
      surface: report.local,
      toolId: report.localToolId,
      mixedId: report.localMixedId,
      slug: 'math',
    },
  ];
  for (const { label, surface, toolId, mixedId, slug } of surfaces) {
    if (report.mode === 'compact') {
      assert.deepEqual(
        surface.tools,
        ['search', 'exec'],
        `${label}: compact exposes exactly search/exec`,
      );
      assert.equal(
        surface.servers?.scope,
        label === 'host' ? 'host' : 'local',
        `${label}: directory scope`,
      );
      if (label === 'local')
        assert.equal(surface.servers?.nodeLabel, report.nodeId, 'local: node label');
      const directory = Array.isArray(surface.servers?.servers) ? surface.servers.servers : [];
      assert.ok(
        directory.some((entry) => (entry as Record<string, unknown>).server === slug),
        `${label}: directory lists the fixture server`,
      );
      assert.ok(JSON.stringify(surface.find).includes(toolId), `${label}: find returns ${toolId}`);
      assert.deepEqual(
        surface.describe?.inputSchema,
        report.expectedInputSchema,
        `${label}: describe returns the live schema`,
      );
      assert.equal(
        surface.describe?.execution,
        'exec',
        `${label}: ${label === 'host' ? 'remote' : 'local'} fixture stays on exec`,
      );
      assert.equal(surface.describe?.app, undefined, `${label}: describe carries no App binding`);
      assert.deepEqual(
        surface.exec,
        { value: 42 },
        `${label}: exec returns an argument-dependent value`,
      );
      // The mixed-metadata fixture advertises _meta but no ui/resourceUri, so it
      // must not be pushed to the individual endpoint.
      assert.equal(
        surface.mixedDescribe?.execution,
        'exec',
        `${label}: mixed metadata stays on exec (no App)`,
      );
      assert.equal(
        surface.mixedDescribe?.app,
        undefined,
        `${label}: mixed metadata carries no App`,
      );
      assert.deepEqual(
        surface.mixed?.structuredContent,
        { value: 7 },
        `${label}: mixed structuredContent`,
      );
      assert.equal(
        (surface.mixed?.meta as Record<string, unknown> | undefined)?.['fixture/metadata'],
        true,
        `${label}: mixed _meta preserved`,
      );
      assert.deepEqual(
        surface.mixed?.contentTypes,
        ['text', 'image', 'resource_link'],
        `${label}: mixed content preserved`,
      );
    } else {
      assert.ok(surface.tools.includes(toolId), `${label}: full exposes native ${toolId}`);
      assert.ok(surface.tools.includes(mixedId), `${label}: full exposes native ${mixedId}`);
      assert.deepEqual(
        surface.native,
        { value: 42 },
        `${label}: full native call is argument-dependent`,
      );
      if (label === 'local') {
        assert.ok(
          surface.tools.includes(aggregateToolName('legacy', 'state')),
          'local: full exposes the legacy fixture natively',
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const scratchDir = process.env.TOOLHOME_LAUNCH_SCRATCH;
  const logFile = process.env.TOOLHOME_LAUNCH_LOG;
  for (const mode of ['compact', 'full'] as const) {
    const report = await runCompactLaunch({
      mode,
      ...(scratchDir === undefined ? {} : { scratchDir }),
      ...(logFile === undefined ? {} : { logFile }),
    });
    verifyCompactLaunch(report);
    process.stdout.write(
      `Compact launch ${mode}: host=[${report.host.tools.join(', ')}] ` +
        `local=[${report.local.tools.join(', ')}] log=${report.logFile}\n`,
    );
  }
  process.stdout.write('Compact launch verification passed for both tool modes.\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Compact launch FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

async function control(
  baseUrl: URL,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${CONTROL_KEY}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) throw new Error(`Control API ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Test port unavailable');
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForHealth(url: URL, processHandle: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`ToolHome exited before becoming healthy: ${processHandle.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('ToolHome did not become healthy');
}

async function stopChild(processHandle: ChildProcess): Promise<void> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  const exited = once(processHandle, 'exit');
  processHandle.kill('SIGTERM');
  const outcome = await Promise.race([
    exited.then(() => 'exited'),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
  ]);
  if (outcome === 'timeout') {
    processHandle.kill('SIGKILL');
    await once(processHandle, 'exit');
  }
}
