/**
 * Real-market smoke test: installs a curated entry through the live market
 * flow (uv tool install with the pinned version), waits for the job, then
 * performs a handshake against the created server.
 *
 * Requires the `uv` runtime and network access to PyPI — run in CI where both
 * exist (GitHub Actions ubuntu images ship uv). Exits non-zero on any failure.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, type ApplicationRuntime } from '../src/app.js';

const controlKey = 'tch_ctl_smoke-control-key-0000000000000000000000001';
const publicUrl = new URL('http://127.0.0.1:3344');

interface InstallJob {
  status: string;
  step: string;
  error?: string;
  result?: { server: { id: string }; installation?: { entryVersion: string } };
}

async function call(
  runtime: ApplicationRuntime,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await runtime.app.fetch(
    new Request(new URL(path, publicUrl), {
      method,
      headers: {
        host: publicUrl.host,
        authorization: `Bearer ${controlKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const value = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  }
  return value;
}

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'toolhome-smoke-'));
  mkdirSync(directory, { recursive: true });
  const runtime = createApplication({
    host: '127.0.0.1',
    port: 3344,
    publicUrl,
    dataDir: directory,
    databasePath: join(directory, 'toolhome.sqlite'),
    masterKey: 'smoke-master-key-0000000000000000000000000001',
    bootstrapControlKey: controlKey,
    allowedHosts: ['127.0.0.1'],
    logLevel: 'warn',
    oauthUrlClientId: true,
    marketDir: join(directory, 'market'),
    callsRetentionDays: 30,
    oauthRefreshIntervalSeconds: 3600,
  });
  try {
    const started = (await call(runtime, 'POST', '/api/v1/market/fetch/install', {
      values: {},
    })) as { jobId: string; status: string };
    if (started.status !== 'installing') {
      throw new Error(`expected installing, got ${started.status}`);
    }
    let job: InstallJob | null = null;
    const deadline = Date.now() + 420_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error('install job timed out');
      job = (await call(runtime, 'GET', `/api/v1/market/install/${started.jobId}`)) as InstallJob;
      if (job.status === 'failed') throw new Error(`install failed: ${job.error ?? 'unknown'}`);
      if (job.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const serverId = job?.result?.server?.id;
    const version = job?.result?.installation?.entryVersion;
    if (!serverId) throw new Error('install completed without a server id');
    if (version !== '2026.7.10') throw new Error(`unexpected pinned version: ${version}`);

    // Handshake: refresh + capability discovery must reach the uvx process.
    await call(runtime, 'POST', `/api/v1/servers/${serverId}/refresh`);
    const caps = (await call(runtime, 'GET', `/api/v1/servers/${serverId}/capabilities`)) as {
      tools: { name: string }[];
    };
    if (!caps.tools.some((tool) => tool.name === 'fetch')) {
      throw new Error('handshake did not discover the fetch tool');
    }
    console.log(
      `SMOKE PASS: fetch@${version} installed and handshake OK (tools: ${caps.tools
        .map((tool) => tool.name)
        .join(', ')})`,
    );
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('SMOKE FAIL:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
