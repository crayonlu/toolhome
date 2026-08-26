import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, type ApplicationRuntime } from '../../src/app.js';
import type { RuntimeConfig } from '../../src/config.js';

export interface TestRuntime {
  runtime: ApplicationRuntime;
  controlKey: string;
  directory: string;
  close(): Promise<void>;
}

export function createTestRuntime(options?: {
  directory?: string;
  persist?: boolean;
  config?: Partial<RuntimeConfig>;
}): TestRuntime {
  const directory = options?.directory ?? mkdtempSync(join(tmpdir(), 'toolhome-test-'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const controlKey = 'tch_ctl_test-bootstrap-control-key-00000000000000000001';
  const runtime = createApplication({
    host: '127.0.0.1',
    port: 3344,
    publicUrl: new URL('http://toolhome.test'),
    dataDir: directory,
    databasePath: join(directory, 'toolhome.sqlite'),
    masterKey: 'test-master-encryption-key-0000000000000000000001',
    bootstrapControlKey: controlKey,
    allowedHosts: ['toolhome.test'],
    logLevel: 'error',
    oauthUrlClientId: true,
    marketDir: '/tmp/toolhome-test-market',
    callsRetentionDays: 30,
    oauthRefreshIntervalSeconds: 3600,
    ...options?.config,
  });
  return {
    runtime,
    controlKey,
    directory,
    async close() {
      await runtime.close();
      if (!options?.persist) rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function controlRequest(
  runtime: ApplicationRuntime,
  controlKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return applicationFetch(runtime, new URL(path, runtime.config.publicUrl), {
    method,
    headers: {
      authorization: `Bearer ${controlKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function applicationFetch(
  runtime: ApplicationRuntime,
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('host', runtime.config.publicUrl.host);
  return runtime.app.fetch(new Request(input, { ...init, headers }));
}

export async function jsonResponse(response: Response): Promise<unknown> {
  const value = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}
