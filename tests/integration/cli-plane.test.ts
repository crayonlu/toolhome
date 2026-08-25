import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTestRuntime, controlRequest, jsonResponse } from '../support/runtime.js';
import { parseFrames, type CliExecFrame } from '../../src/cli-plane/frames.js';

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'cli-fixture.mjs',
);

interface CliBody {
  slug: string;
  name: string;
  command: string;
  executionMode: 'host' | 'docker';
  entrypoint: string | null;
  authStrategy: 'none' | 'azure-service-principal' | 'tailscale-auth-key';
  containerVolumes: { source: string; target: string; readOnly: boolean }[];
  allowList: { allow: string[][]; deny: string[][] };
  interactive: boolean;
  credentialId: string | null;
  credentialBindings: Record<string, string>;
  platform: string | null;
  probe: { command: string; args: string[] } | null;
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

function cliBody(overrides: Partial<CliBody> = {}): CliBody {
  return {
    slug: 'fixture',
    name: 'Fixture CLI',
    command: fixturePath,
    executionMode: 'host',
    entrypoint: null,
    authStrategy: 'none',
    containerVolumes: [],
    allowList: { allow: [], deny: [] },
    interactive: false,
    credentialId: null,
    credentialBindings: {},
    platform: null,
    probe: null,
    enabled: true,
    timeoutMs: 60_000,
    maxOutputBytes: 64 * 1024,
    ...overrides,
  };
}

async function execFrames(
  runtime: ReturnType<typeof createTestRuntime>,
  slug: string,
  body: unknown,
): Promise<{ response: Response; frames: CliExecFrame[] }> {
  const response = await controlRequest(
    runtime.runtime,
    runtime.controlKey,
    'POST',
    `/cli/${slug}/exec`,
    body,
  );
  const frames = parseFrames(await response.text());
  return { response, frames };
}

function streamText(frames: CliExecFrame[], stream: 'stdout' | 'stderr'): string {
  return frames
    .filter((frame) => frame.type === stream)
    .map((frame) => (frame as { data: string }).data)
    .join('');
}

describe('CLI registry', () => {
  it('creates, lists, fetches, updates, deletes and survives a store reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-cli-registry-'));
    const first = createTestRuntime({ directory, persist: true });
    let cliId: string;
    try {
      const created = (await jsonResponse(
        await controlRequest(first.runtime, first.controlKey, 'POST', '/api/v1/clis', cliBody()),
      )) as { id: string; slug: string; command: string };
      expect(created.slug).toBe('fixture');
      expect(created.command).toBe(fixturePath);
      cliId = created.id;

      const list = (await jsonResponse(
        await controlRequest(first.runtime, first.controlKey, 'GET', '/api/v1/clis'),
      )) as { slug: string }[];
      expect(list.map((entry) => entry.slug)).toContain('fixture');

      const fetched = (await jsonResponse(
        await controlRequest(first.runtime, first.controlKey, 'GET', `/api/v1/clis/${cliId}`),
      )) as { name: string };
      expect(fetched.name).toBe('Fixture CLI');

      const updated = (await jsonResponse(
        await controlRequest(first.runtime, first.controlKey, 'PATCH', `/api/v1/clis/${cliId}`, {
          name: 'Renamed CLI',
          timeoutMs: 5_000,
        }),
      )) as { name: string; timeoutMs: number };
      expect(updated.name).toBe('Renamed CLI');
      expect(updated.timeoutMs).toBe(5_000);
    } finally {
      await first.close();
    }

    // A fresh runtime on the same directory must boot the pre-existing database
    // (rename-baseline migration) and still see the CLI record.
    const second = createTestRuntime({ directory });
    try {
      const list = (await jsonResponse(
        await controlRequest(second.runtime, second.controlKey, 'GET', '/api/v1/clis'),
      )) as { id: string; slug: string; name: string }[];
      const persisted = list.find((entry) => entry.slug === 'fixture');
      expect(persisted).toBeDefined();
      expect(persisted?.name).toBe('Renamed CLI');

      const deleted = (await jsonResponse(
        await controlRequest(
          second.runtime,
          second.controlKey,
          'DELETE',
          `/api/v1/clis/${persisted?.id}`,
        ),
      )) as { deleted: boolean };
      expect(deleted).toEqual({ deleted: true });

      const after = (await jsonResponse(
        await controlRequest(second.runtime, second.controlKey, 'GET', '/api/v1/clis'),
      )) as { slug: string }[];
      expect(after.map((entry) => entry.slug)).not.toContain('fixture');
    } finally {
      await second.close();
    }
  });

  it('persists CLI authentication strategy and state volumes across reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-cli-runtime-'));
    const first = createTestRuntime({ directory, persist: true });
    try {
      const created = (await jsonResponse(
        await controlRequest(
          first.runtime,
          first.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({
            slug: 'azure-runtime',
            executionMode: 'docker',
            command: 'mcr.microsoft.com/azure-cli:2.89.0',
            entrypoint: 'az',
            authStrategy: 'azure-service-principal',
            containerVolumes: [
              { source: 'toolhome-azure-cli-state', target: '/root/.azure', readOnly: false },
            ],
          }),
        ),
      )) as { id: string; authStrategy: string; containerVolumes: unknown[] };
      expect(created.authStrategy).toBe('azure-service-principal');
      expect(created.containerVolumes).toEqual([
        { source: 'toolhome-azure-cli-state', target: '/root/.azure', readOnly: false },
      ]);
    } finally {
      await first.close();
    }
    const second = createTestRuntime({ directory });
    try {
      const clis = (await jsonResponse(
        await controlRequest(second.runtime, second.controlKey, 'GET', '/api/v1/clis'),
      )) as { slug: string; authStrategy: string; containerVolumes: unknown[] }[];
      expect(clis.find((cli) => cli.slug === 'azure-runtime')).toMatchObject({
        authStrategy: 'azure-service-principal',
        containerVolumes: [
          { source: 'toolhome-azure-cli-state', target: '/root/.azure', readOnly: false },
        ],
      });
    } finally {
      await second.close();
    }
  });

  it('preserves Docker authentication settings during a partial CLI update', async () => {
    const runtime = createTestRuntime();
    try {
      const created = (await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({
            slug: 'partial-update-auth',
            executionMode: 'docker',
            command: 'mcr.microsoft.com/azure-cli:2.89.0',
            authStrategy: 'azure-service-principal',
            credentialBindings: {
              AZURE_CLIENT_ID: 'env:AZURE_CLIENT_ID',
              AZURE_CLIENT_SECRET: 'env:AZURE_CLIENT_SECRET',
              AZURE_TENANT_ID: 'env:AZURE_TENANT_ID',
            },
            containerVolumes: [
              { source: 'toolhome-azure-cli-state', target: '/root/.azure', readOnly: false },
            ],
          }),
        ),
      )) as { id: string };

      const updated = (await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'PATCH',
          `/api/v1/clis/${created.id}`,
          { enabled: false },
        ),
      )) as {
        authStrategy: string;
        credentialBindings: Record<string, string>;
        containerVolumes: unknown[];
        enabled: boolean;
      };

      expect(updated).toMatchObject({
        authStrategy: 'azure-service-principal',
        credentialBindings: {
          AZURE_CLIENT_ID: 'env:AZURE_CLIENT_ID',
          AZURE_CLIENT_SECRET: 'env:AZURE_CLIENT_SECRET',
          AZURE_TENANT_ID: 'env:AZURE_TENANT_ID',
        },
        containerVolumes: [
          { source: 'toolhome-azure-cli-state', target: '/root/.azure', readOnly: false },
        ],
        enabled: false,
      });
    } finally {
      await runtime.close();
    }
  });

  it('does not inject non-interactive enforcement variables into interactive Docker CLIs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-cli-interactive-docker-'));
    const argsFile = join(directory, 'docker-args.txt');
    const dockerPath = join(directory, 'docker');
    writeFileSync(
      dockerPath,
      `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
exit 0
`,
    );
    chmodSync(dockerPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ''}`;
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({
            slug: 'interactive-docker',
            command: 'example/cli:latest',
            executionMode: 'docker',
            entrypoint: 'cli',
            interactive: true,
          }),
        ),
      );
      const { response } = await execFrames(runtime, 'interactive-docker', {
        argv: ['status'],
      });
      expect(response.status).toBe(200);
      const args = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
      expect(args).not.toContain('--env');
      expect(args).toContain('example/cli:latest');
      expect(args.at(-1)).toBe('status');
    } finally {
      await runtime.close();
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the CLI auth bootstrap when checking Docker CLI status', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-cli-status-auth-'));
    const argsFile = join(directory, 'docker-args.txt');
    const dockerPath = join(directory, 'docker');
    writeFileSync(
      dockerPath,
      `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
printf 'version=azure-cli\\nloggedIn=true\\n'
exit 0
`,
    );
    chmodSync(dockerPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ''}`;
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({
            slug: 'azure-status',
            executionMode: 'docker',
            command: 'mcr.microsoft.com/azure-cli:2.89.0',
            entrypoint: 'az',
            authStrategy: 'azure-service-principal',
            containerVolumes: [
              { source: 'toolhome-azure-cli-state', target: '/root/.azure', readOnly: false },
            ],
            probe: { command: 'az', args: ['version'] },
          }),
        ),
      );
      const status = (await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'GET',
          '/cli/azure-status/status',
        ),
      )) as { installed: boolean; loggedIn: boolean };
      expect(status).toMatchObject({ installed: true, loggedIn: true });
      const args = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
      expect(args).toContain('--entrypoint');
      expect(args[args.indexOf('--entrypoint') + 1]).toBe('/bin/sh');
      expect(args).toContain('toolhome-azure-cli-state:/root/.azure');
      expect(args.some((arg) => arg.includes('az login --service-principal'))).toBe(true);
    } finally {
      await runtime.close();
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists a Docker entrypoint across updates and reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-cli-entrypoint-'));
    const first = createTestRuntime({ directory, persist: true });
    try {
      const created = (await jsonResponse(
        await controlRequest(
          first.runtime,
          first.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({
            slug: 'docker-fixture',
            executionMode: 'docker',
            command: 'example/cli:latest',
            entrypoint: 'example-cli',
          }),
        ),
      )) as { id: string; entrypoint: string | null };
      expect(created.entrypoint).toBe('example-cli');
      const updated = (await jsonResponse(
        await controlRequest(
          first.runtime,
          first.controlKey,
          'PATCH',
          `/api/v1/clis/${created.id}`,
          {
            entrypoint: 'example-cli-v2',
          },
        ),
      )) as { entrypoint: string | null };
      expect(updated.entrypoint).toBe('example-cli-v2');
    } finally {
      await first.close();
    }
    const second = createTestRuntime({ directory });
    try {
      const clis = (await jsonResponse(
        await controlRequest(second.runtime, second.controlKey, 'GET', '/api/v1/clis'),
      )) as { slug: string; entrypoint: string | null }[];
      expect(clis.find((cli) => cli.slug === 'docker-fixture')?.entrypoint).toBe('example-cli-v2');
    } finally {
      await second.close();
    }
  });

  it('rejects Docker-only authentication and volumes on host CLIs', async () => {
    const runtime = createTestRuntime();
    try {
      const authResponse = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'POST',
        '/api/v1/clis',
        cliBody({ slug: 'host-auth', authStrategy: 'azure-service-principal' }),
      );
      expect(authResponse.status).toBe(400);
      expect((await authResponse.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'validation_error' },
      });

      const volumeResponse = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'POST',
        '/api/v1/clis',
        cliBody({
          slug: 'host-volume',
          containerVolumes: [{ source: 'host:path', target: '/root/state', readOnly: false }],
        }),
      );
      expect(volumeResponse.status).toBe(400);
      expect((await volumeResponse.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'validation_error' },
      });
    } finally {
      await runtime.close();
    }
  });

  it('rejects a duplicate slug with 409', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody(),
        ),
      );
      const response = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'POST',
        '/api/v1/clis',
        cliBody(),
      );
      expect(response.status).toBe(409);
    } finally {
      await runtime.close();
    }
  });
});

describe('CLI exec', () => {
  it('streams stdout, stderr and exit frames with the real code and duration', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody(),
        ),
      );
      const { response, frames } = await execFrames(runtime, 'fixture', { argv: ['mix'] });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/x-ndjson');
      expect(streamText(frames, 'stdout')).toContain('out-line');
      expect(streamText(frames, 'stderr')).toContain('err-line');
      const exit = frames.find((frame) => frame.type === 'exit');
      expect(exit).toMatchObject({ type: 'exit', code: 1, result: 'error' });
      if (exit?.type === 'exit') expect(exit.durationMs).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });

  it('rejects a shell-string argv body with a 400 validation error', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody(),
        ),
      );
      const response = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'POST',
        '/cli/fixture/exec',
        { argv: 'echo hello' },
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('validation_error');
    } finally {
      await runtime.close();
    }
  });

  it('passes stdin through the API to the child process', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody(),
        ),
      );
      const { frames } = await execFrames(runtime, 'fixture', {
        argv: ['stdin'],
        stdin: 'ToolHome API input',
      });
      expect(streamText(frames, 'stdout')).toBe('ToolHome API input\n');
      expect(frames.find((frame) => frame.type === 'exit')).toMatchObject({
        code: 0,
        result: 'ok',
      });
    } finally {
      await runtime.close();
    }
  });

  it('does not allow a per-exec output limit to exceed the CLI policy', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({ maxOutputBytes: 2048 }),
        ),
      );
      const { frames } = await execFrames(runtime, 'fixture', {
        argv: ['huge', '65536'],
        maxOutputBytes: 64 * 1024,
      });
      const retained = frames
        .filter(
          (frame): frame is { type: 'stdout' | 'stderr'; data: string } =>
            frame.type === 'stdout' || frame.type === 'stderr',
        )
        .reduce((sum, frame) => sum + Buffer.byteLength(frame.data), 0);
      expect(retained).toBeLessThanOrEqual(2048);
      expect(frames.find((frame) => frame.type === 'exit')).toMatchObject({ truncated: true });
    } finally {
      await runtime.close();
    }
  });

  it('does not allow a per-exec timeout to exceed the CLI policy', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({ timeoutMs: 100 }),
        ),
      );
      const { frames } = await execFrames(runtime, 'fixture', {
        argv: ['sleep', '500'],
        timeoutMs: 5_000,
      });
      const exit = frames.find((frame) => frame.type === 'exit');
      expect(exit).toMatchObject({ code: null, result: 'timeout' });
      if (exit?.type === 'exit') expect(exit.durationMs).toBeLessThan(400);
    } finally {
      await runtime.close();
    }
  });

  it('returns a structured 404 for an unknown slug without spawning', async () => {
    const runtime = createTestRuntime();
    try {
      const response = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'POST',
        '/cli/unknown/exec',
        { argv: ['echo', 'x'] },
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('cli_not_found');
    } finally {
      await runtime.close();
    }
  });

  it('returns a structured 403 for a disabled CLI without spawning', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({ enabled: false }),
        ),
      );
      const response = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'POST',
        '/cli/fixture/exec',
        { argv: ['echo', 'x'] },
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('cli_disabled');
    } finally {
      await runtime.close();
    }
  });

  it('rejects a deny-listed argv before any output or exit frame', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({ allowList: { allow: [], deny: [['mix']] } }),
        ),
      );
      const response = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'POST',
        '/cli/fixture/exec',
        { argv: ['mix'] },
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('cli_denied');
    } finally {
      await runtime.close();
    }
  });

  it('kills a still-running child and reports a timeout exit frame', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({ timeoutMs: 400 }),
        ),
      );
      const { frames } = await execFrames(runtime, 'fixture', { argv: ['sleep', '10000'] });
      const exit = frames.find((frame) => frame.type === 'exit');
      expect(exit).toMatchObject({ type: 'exit', code: null, result: 'timeout' });
      if (exit?.type === 'exit') expect(exit.durationMs).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });

  it('caps retained output at the configured limit and flags truncation', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({ maxOutputBytes: 2048 }),
        ),
      );
      const { frames } = await execFrames(runtime, 'fixture', { argv: ['huge', '65536'] });
      const exit = frames.find((frame) => frame.type === 'exit');
      expect(exit).toMatchObject({ type: 'exit', truncated: true });
      const retained = frames
        .filter(
          (frame): frame is { type: 'stdout' | 'stderr'; data: string } =>
            frame.type === 'stdout' || frame.type === 'stderr',
        )
        .reduce((sum, frame) => sum + Buffer.byteLength(frame.data), 0);
      expect(retained).toBeLessThanOrEqual(2048);
    } finally {
      await runtime.close();
    }
  });
});

describe('CLI exec environment', () => {
  it('injects non-interactive enforcement vars into every exec', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody(),
        ),
      );
      const { frames } = await execFrames(runtime, 'fixture', {
        argv: ['env', 'CI', 'NO_COLOR', 'PAGER', 'TERM'],
      });
      const data = streamText(frames, 'stdout');
      expect(data).toContain('CI=true');
      expect(data).toContain('NO_COLOR=1');
      expect(data).toContain('PAGER=cat');
      expect(data).toContain('TERM=dumb');
    } finally {
      await runtime.close();
    }
  });

  it('projects a bearer credential into the CLI environment through bindings', async () => {
    const runtime = createTestRuntime();
    try {
      const credential = (await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/credentials', {
          name: 'github-token',
          payload: { type: 'bearer', token: 'gh-secret-token' },
        }),
      )) as { id: string };
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({ credentialId: credential.id, credentialBindings: { GH_TOKEN: 'token' } }),
        ),
      );
      const { frames } = await execFrames(runtime, 'fixture', {
        argv: ['env', 'GH_TOKEN'],
      });
      expect(streamText(frames, 'stdout')).toContain('GH_TOKEN=gh-secret-token');
    } finally {
      await runtime.close();
    }
  });

  it('projects an API key credential into a selected CLI environment variable', async () => {
    const runtime = createTestRuntime();
    try {
      const credential = (await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/credentials', {
          name: 'tailscale-key',
          payload: { type: 'api-key', headerName: 'Authorization', value: 'ts-secret' },
        }),
      )) as { id: string };
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({ credentialId: credential.id, credentialBindings: { TS_API_KEY: 'value' } }),
        ),
      );
      const { frames } = await execFrames(runtime, 'fixture', {
        argv: ['env', 'TS_API_KEY'],
      });
      expect(streamText(frames, 'stdout')).toContain('TS_API_KEY=ts-secret');
    } finally {
      await runtime.close();
    }
  });

  it('projects an OAuth access token and rejects an OAuth credential pending authorization', async () => {
    const runtime = createTestRuntime();
    try {
      const authorized = (await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/credentials', {
          name: 'oauth-ready',
          payload: { type: 'oauth', accessToken: 'oauth-secret', tokenType: 'Bearer' },
        }),
      )) as { id: string };
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({
            credentialId: authorized.id,
            credentialBindings: { OAUTH_TOKEN: 'accessToken' },
          }),
        ),
      );
      const ready = await execFrames(runtime, 'fixture', { argv: ['env', 'OAUTH_TOKEN'] });
      expect(streamText(ready.frames, 'stdout')).toContain('OAUTH_TOKEN=oauth-secret');

      const pending = (await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/credentials', {
          name: 'oauth-pending',
          payload: { type: 'oauth', tokenType: 'Bearer' },
        }),
      )) as { id: string };
      const create = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'POST',
        '/api/v1/clis',
        cliBody({
          slug: 'oauth-pending',
          credentialId: pending.id,
          credentialBindings: { OAUTH_TOKEN: 'accessToken' },
        }),
      );
      expect(create.status).toBe(201);
      const pendingExec = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'POST',
        '/cli/oauth-pending/exec',
        { argv: ['env', 'OAUTH_TOKEN'] },
      );
      expect(pendingExec.status).toBe(400);
      expect((await pendingExec.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'credential_authorization_required' },
      });
    } finally {
      await runtime.close();
    }
  });

  it('injects attached Env Credential variables into the child environment', async () => {
    const runtime = createTestRuntime();
    try {
      const credential = (await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/credentials', {
          name: 'azure-sp',
          payload: {
            type: 'env',
            variables: { AZURE_CLIENT_ID: 'sp-123', TOOLHOME_TOKEN: 's3cret' },
          },
        }),
      )) as { id: string };
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({ credentialId: credential.id }),
        ),
      );
      const { frames } = await execFrames(runtime, 'fixture', {
        argv: ['env', 'AZURE_CLIENT_ID', 'TOOLHOME_TOKEN'],
      });
      const data = streamText(frames, 'stdout');
      expect(data).toContain('AZURE_CLIENT_ID=sp-123');
      expect(data).toContain('TOOLHOME_TOKEN=s3cret');
    } finally {
      await runtime.close();
    }
  });

  it('allows an allow-listed argv and denies argv not matching any allow rule', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({ allowList: { allow: [['echo', '*'], ['probe']], deny: [] } }),
        ),
      );
      const allowed = await execFrames(runtime, 'fixture', { argv: ['echo', 'hello', 'world'] });
      const allowedExit = allowed.frames.find((frame) => frame.type === 'exit');
      expect(allowedExit).toMatchObject({ type: 'exit', code: 0 });

      const denied = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'POST',
        '/cli/fixture/exec',
        { argv: ['huge', '1024'] },
      );
      expect(denied.status).toBe(403);
      const body = (await denied.json()) as { error: { code: string } };
      expect(body.error.code).toBe('cli_denied');
    } finally {
      await runtime.close();
    }
  });
});

describe('CLI status and audit', () => {
  it('uses the declared Docker probe command as the probe entrypoint', async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'toolhome-docker-probe-'));
    const dockerPath = join(fakeBin, 'docker');
    const argsLog = join(fakeBin, 'docker-args.log');
    writeFileSync(
      dockerPath,
      `#!/bin/sh
printf '<%s>' "$@" > "${argsLog}"
printf 'version=probe-1.0.0\\nloggedIn=true\\n'
exit 0
`,
    );
    chmodSync(dockerPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({
            slug: 'docker-probe',
            command: 'example/cli:latest',
            executionMode: 'docker',
            entrypoint: 'main-entrypoint',
            probe: { command: 'probe-entrypoint', args: ['probe'] },
          }),
        ),
      );
      const status = (await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'GET',
          '/cli/docker-probe/status',
        ),
      )) as { version: string; loggedIn: boolean };
      expect(status).toMatchObject({ version: 'probe-1.0.0', loggedIn: true });
      const args = readFileSync(argsLog, 'utf8')
        .split('><')
        .map((item) => item.replace(/^<|>$/g, ''));
      expect(args).toContain('--entrypoint');
      expect(args[args.indexOf('--entrypoint') + 1]).toBe('probe-entrypoint');
      expect(args).toContain('example/cli:latest');
    } finally {
      await runtime.close();
      process.env.PATH = previousPath;
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('returns structured probe fields from the status endpoint', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody({ probe: { command: fixturePath, args: ['probe', '2.1.0', 'true'] } }),
        ),
      );
      const status = (await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'GET', '/cli/fixture/status'),
      )) as { installed: boolean; version: string; loggedIn: boolean; lastCheckedAt: string };
      expect(status.installed).toBe(true);
      expect(status.version).toBe('2.1.0');
      expect(status.loggedIn).toBe(true);
      expect(status.lastCheckedAt).toBeTruthy();
    } finally {
      await runtime.close();
    }
  });

  it('records CLI execs in Events, Calls and Overview', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody(),
        ),
      );
      await execFrames(runtime, 'fixture', { argv: ['echo', 'calls'] });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const cliEvents = (await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'GET',
          '/api/v1/events?plane=cli&limit=50',
        ),
      )) as { type: string; detail: { slug: string } }[];
      expect(
        cliEvents.some((event) => event.type === 'cli.exec' && event.detail.slug === 'fixture'),
      ).toBe(true);
      const mcpEvents = (await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'GET',
          '/api/v1/events?plane=mcp&limit=50',
        ),
      )) as { type: string }[];
      expect(mcpEvents.every((event) => !event.type.startsWith('cli.'))).toBe(true);

      const calls = (await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'GET',
          '/api/v1/calls?endpoint_type=cli&limit=50',
        ),
      )) as {
        total: number;
        items: { endpointType: string; principalKind: string; exposedToolName: string }[];
      };
      expect(calls.total).toBe(1);
      expect(calls.items[0]).toMatchObject({
        endpointType: 'cli',
        principalKind: 'cli',
        exposedToolName: 'fixture',
      });

      const stats = (await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'GET',
          '/api/v1/calls/stats?endpoint_type=cli',
        ),
      )) as { total: number; success: number };
      expect(stats).toMatchObject({ total: 1, success: 1 });

      const overview = (await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'GET', '/api/v1/overview'),
      )) as { clis: { total: number; enabled: number } };
      expect(overview.clis).toEqual({ total: 1, enabled: 1 });
    } finally {
      await runtime.close();
    }
  });

  it('redacts secret-looking argv values from CLI audit events', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody(),
        ),
      );
      await execFrames(runtime, 'fixture', { argv: ['echo', '--token', 'super-secret'] });
      const events = (await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'GET', '/api/v1/events?limit=50'),
      )) as { type: string; message: string; detail: { argv: string[] } }[];
      const execEvent = events.find((event) => event.type === 'cli.exec');
      expect(execEvent?.detail.argv).toEqual(['echo', '--token', '[REDACTED]']);
      expect(execEvent?.message).not.toContain('super-secret');
    } finally {
      await runtime.close();
    }
  });

  it('records every exec in the events stream with slug, argv, code and duration', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/clis',
          cliBody(),
        ),
      );
      await execFrames(runtime, 'fixture', { argv: ['echo', 'hello'] });
      const events = (await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'GET', '/api/v1/events?limit=50'),
      )) as {
        type: string;
        detail: { slug: string; argv: string[]; exitCode: number; durationMs: number };
      }[];
      const execEvent = events.find((event) => event.type === 'cli.exec');
      expect(execEvent).toBeDefined();
      expect(execEvent?.detail.slug).toBe('fixture');
      expect(execEvent?.detail.argv).toEqual(['echo', 'hello']);
      expect(execEvent?.detail.exitCode).toBe(0);
      expect(execEvent?.detail.durationMs).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });
});
