import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  apiKeyRecordSchema,
  credentialRecordSchema,
  serverRecordSchema,
} from '../src/domain/models.js';
import {
  connectTestClient,
  structuredResult,
  waitFor,
  type TestMcpClient,
} from '../tests/support/mcp-client.js';
import { startRemoteFixture } from '../tests/support/remote-fixture.js';

const issuedKeySchema = z.object({ key: apiKeyRecordSchema, secret: z.string() });
const taskCreatedSchema = z
  .object({ resultType: z.literal('task'), taskId: z.string(), status: z.string() })
  .passthrough();
const taskStateSchema = z
  .object({ resultType: z.literal('complete'), taskId: z.string(), status: z.string() })
  .passthrough();

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = fileURLToPath(new URL('../tests/fixtures/stdio-server.ts', import.meta.url));
const dataDirectory = mkdtempSync(join(tmpdir(), 'toolhome-real-'));
const controlKey = 'tch_ctl_real-bootstrap-control-key-0000000000000000000001';
const masterKey = 'real-master-encryption-key-000000000000000000000001';
const remote = await startRemoteFixture();
const port = await availablePort();
const baseUrl = new URL(`http://127.0.0.1:${port}`);
const clients: TestMcpClient[] = [];
let output = '';
const builtEntrypoint = join(projectRoot, 'dist', 'server', 'main.js');
const childArguments = existsSync(builtEntrypoint)
  ? [builtEntrypoint]
  : ['--import', 'tsx', 'src/main.ts'];

const child = spawn(process.execPath, childArguments, {
  cwd: projectRoot,
  env: {
    ...process.env,
    TOOLHOME_HOST: '127.0.0.1',
    TOOLHOME_PORT: String(port),
    TOOLHOME_PUBLIC_URL: baseUrl.toString(),
    TOOLHOME_DATA_DIR: dataDirectory,
    TOOLHOME_MASTER_KEY: masterKey,
    TOOLHOME_BOOTSTRAP_CONTROL_KEY: controlKey,
    TOOLHOME_ALLOWED_HOSTS: '127.0.0.1',
    TOOLHOME_LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout?.on('data', (chunk: unknown) => {
  output = appendOutput(output, String(chunk));
});
child.stderr?.on('data', (chunk: unknown) => {
  output = appendOutput(output, String(chunk));
});

try {
  await waitForHealth(new URL('/healthz', baseUrl), child);
  const remoteCredential = credentialRecordSchema.parse(
    await control('POST', '/api/v1/credentials', {
      name: 'Remote real credential',
      payload: { type: 'bearer', token: 'remote-fixture-token' },
    }),
  );
  const homeCredential = credentialRecordSchema.parse(
    await control('POST', '/api/v1/credentials', {
      name: 'Home real credential',
      payload: { type: 'env', variables: { FIXTURE_SECRET: 'real-home-secret' } },
    }),
  );
  const remoteServer = serverRecordSchema.parse(
    await control('POST', '/api/v1/servers', {
      slug: 'remote',
      name: 'Remote real fixture',
      kind: 'remote',
      transport: {
        type: 'streamable-http',
        url: remote.url.toString(),
        protocolMode: 'modern',
        allowSseFallback: false,
        headers: {},
      },
      credentialId: remoteCredential.id,
      enabled: true,
      settings: { maxConcurrency: 4 },
    }),
  );
  const homeServer = serverRecordSchema.parse(
    await control('POST', '/api/v1/servers', {
      slug: 'home',
      name: 'Home real fixture',
      kind: 'home',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['--import', 'tsx', fixturePath],
        env: {},
        protocolMode: 'legacy',
      },
      credentialId: homeCredential.id,
      enabled: true,
      settings: { maxConcurrency: 2 },
    }),
  );
  await control('POST', `/api/v1/servers/${remoteServer.id}/refresh`);
  await control('POST', `/api/v1/servers/${homeServer.id}/refresh`);
  const access = issuedKeySchema.parse(
    await control('POST', '/api/v1/access-keys', { name: 'Real environment harness' }),
  );

  const aggregate = await connectTestClient(new URL('/mcp', baseUrl), access.secret);
  clients.push(aggregate);
  const tools = await aggregate.client.listTools();
  assert(tools.tools.some((tool) => tool.name === 'remote.echo'));
  assert(tools.tools.some((tool) => tool.name === 'home.confirm'));
  assert.deepEqual(
    structuredResult(
      await aggregate.client.callTool({ name: 'remote.echo', arguments: { live: true } }),
    ),
    {
      arguments: { live: true },
      authorization: 'Bearer remote-fixture-token',
      secret: null,
      server: 'remote',
    },
  );
  assert.equal(
    structuredResult(await aggregate.client.callTool({ name: 'home.confirm', arguments: {} }))
      .source,
    'legacy-push',
  );
  assert.equal(
    structuredResult(await aggregate.client.callTool({ name: 'home.echo', arguments: {} })).secret,
    'real-home-secret',
  );

  const progress: number[] = [];
  assert.equal(
    structuredResult(
      await aggregate.client.callTool(
        { name: 'remote.progress', arguments: {} },
        {
          onprogress(update) {
            progress.push(update.progress);
          },
        },
      ),
    ).progressed,
    true,
  );
  assert(progress.includes(1));

  const controller = new AbortController();
  const cancellation: Promise<{ kind: 'fulfilled' } | { error: unknown; kind: 'rejected' }> =
    aggregate.client
      .callTool({ name: 'remote.slow', arguments: {} }, { signal: controller.signal })
      .then(
        () => ({ kind: 'fulfilled' }),
        (error: unknown) => ({ error, kind: 'rejected' }),
      );
  await waitFor(() => remote.slowStarted() === 1);
  controller.abort(new Error('Cancel real fixture request'));
  assert.equal((await cancellation).kind, 'rejected');
  await waitFor(() => remote.slowCancelled() === 1);

  const toolChanges = aggregate.listChanges.tools;
  remote.toolsChanged();
  await waitFor(() => aggregate.listChanges.tools > toolChanges);
  const refreshedTools = await aggregate.client.listTools(undefined, {
    cacheMode: 'refresh',
  });
  assert(refreshedTools.tools.some((tool) => tool.name === 'remote.dynamic'));

  const created = taskCreatedSchema.parse(
    aggregate.taskResult(
      await aggregate.client.callTool({ name: 'remote.start-task', arguments: {} }),
    ),
  );
  assert.match(created.taskId, /^toolhome-task:remote:/);
  const task = taskStateSchema.parse(
    await aggregate.tasks.request(
      { method: 'tasks/get', params: { taskId: created.taskId } },
      { timeout: 10_000, maxTotalTimeout: 10_000 },
    ),
  );
  assert.equal(task.taskId, created.taskId);
  assert.equal(task.status, 'completed');
  await aggregate.tasks.request(
    { method: 'tasks/update', params: { taskId: created.taskId, ttlMs: 120_000 } },
    { timeout: 10_000, maxTotalTimeout: 10_000 },
  );
  await aggregate.tasks.request(
    { method: 'tasks/cancel', params: { taskId: created.taskId } },
    { timeout: 10_000, maxTotalTimeout: 10_000 },
  );
  const cancelledTask = taskStateSchema.parse(
    await aggregate.tasks.request(
      { method: 'tasks/get', params: { taskId: created.taskId } },
      { timeout: 10_000, maxTotalTimeout: 10_000 },
    ),
  );
  assert.equal(cancelledTask.status, 'cancelled');

  const individual = await connectTestClient(new URL('/mcp/remote', baseUrl), access.secret);
  clients.push(individual);
  assert((await individual.client.listTools()).tools.some((tool) => tool.name === 'echo'));
  assert(
    (await individual.client.listResources()).resources.some(
      (resource) => resource.uri === 'fixture://data',
    ),
  );
  assert.equal(
    structuredResult(
      await individual.client.callTool({ name: 'echo', arguments: { individual: true } }),
    ).server,
    'remote',
  );

  const legacyHarness = await connectTestClient(
    new URL('/mcp', baseUrl),
    access.secret,
    globalThis.fetch,
    '2025-06-18',
  );
  clients.push(legacyHarness);
  for (const interaction of [
    { name: 'remote.confirm', source: 'modern-mrtr' },
    { name: 'home.confirm', source: 'legacy-push' },
  ]) {
    assert.equal(
      structuredResult(
        await legacyHarness.client.callTool({
          name: interaction.name,
          arguments: {},
        }),
      ).source,
      interaction.source,
    );
  }
  assert.equal(
    structuredResult(
      await legacyHarness.client.callTool({
        name: 'home.client-extension',
        arguments: {},
      }),
    ).source,
    'legacy-client-extension',
  );
  assert(legacyHarness.clientRequests.includes('toolhome/home/fixture/client-resource'));

  const denied = await fetch(new URL('/api/v1/servers', baseUrl), {
    headers: { authorization: `Bearer ${access.secret}` },
  });
  assert.equal(denied.status, 401);
  process.stdout.write(
    'Real environment: process boundary, aggregate/individual, modern/legacy, progress, cancellation, list changes, MRTR, Tasks and auth passed.\n',
  );
} catch (error) {
  if (output !== '') process.stderr.write(`ToolHome process output:\n${output}\n`);
  throw error;
} finally {
  for (const openClient of clients.reverse()) {
    await openClient.close().catch(() => undefined);
  }
  await stopChild(child);
  await remote.close();
  rmSync(dataDirectory, { recursive: true, force: true });
}

async function control(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${controlKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
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

function appendOutput(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-16_384);
}
