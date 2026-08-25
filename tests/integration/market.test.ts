import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  applicationFetch,
  createTestRuntime,
  controlRequest,
  jsonResponse,
} from '../support/runtime.js';
import { credentialRecordSchema, serverRecordSchema } from '../../src/domain/models.js';

interface MarketItem {
  id: string;
  plane: 'mcp' | 'cli';
  kind: string;
  installed: boolean;
}

async function marketList(runtime: Parameters<typeof controlRequest>[0], controlKey: string) {
  return jsonResponse(
    await controlRequest(runtime, controlKey, 'GET', '/api/v1/market'),
  ) as unknown as MarketItem[];
}

async function installEntry(
  runtime: Parameters<typeof controlRequest>[0],
  controlKey: string,
  id: string,
  values: Record<string, string> = {},
) {
  const started = (await jsonResponse(
    await controlRequest(runtime, controlKey, 'POST', `/api/v1/market/${id}/install`, { values }),
  )) as { jobId: string };
  for (;;) {
    const job = (await jsonResponse(
      await controlRequest(runtime, controlKey, 'GET', `/api/v1/market/install/${started.jobId}`),
    )) as { status: string; result?: unknown; error?: string };
    if (job.status !== 'installing') {
      if (job.status === 'failed') throw new Error(job.error ?? 'install failed');
      return job.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('market', () => {
  it('lists the curated catalog with install status and hosting planes', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const items = await marketList(runtime, controlKey);
      expect(items.length).toBeGreaterThan(20);
      expect(
        items.some(
          (item) => item.id === 'github' && item.kind === 'remote' && item.plane === 'mcp',
        ),
      ).toBe(true);
      expect(
        items.some(
          (item) => item.id === 'resend' && item.kind === 'home-stdio' && item.plane === 'mcp',
        ),
      ).toBe(true);
      expect(
        items.some((item) => item.id === 'fetch' && item.kind === 'uvx' && item.plane === 'mcp'),
      ).toBe(true);
      expect(
        items.some(
          (item) => item.id === 'gh-cli' && item.kind === 'cli-image' && item.plane === 'cli',
        ),
      ).toBe(true);
      expect(
        items.some(
          (item) => item.id === 'host-shell' && item.kind === 'cli-binary' && item.plane === 'cli',
        ),
      ).toBe(true);
      for (const item of items) expect(item.installed).toBe(false);
    } finally {
      await close();
    }
  });

  it('cleans up a CLI and credential when the installation marker cannot be written', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    const createInstallation = runtime.store.createInstallation.bind(runtime.store);
    vi.spyOn(runtime.store, 'createInstallation').mockImplementation((input) => {
      if (input.entryId === 'host-shell') throw new Error('installation write failed');
      return createInstallation(input);
    });
    try {
      const started = await controlRequest(
        runtime,
        controlKey,
        'POST',
        '/api/v1/market/host-shell/install',
        { values: {} },
      );
      expect(started.status).toBe(200);
      const body = (await started.json()) as { jobId: string };
      for (;;) {
        const job = (await jsonResponse(
          await controlRequest(runtime, controlKey, 'GET', `/api/v1/market/install/${body.jobId}`),
        )) as { status: string };
        if (job.status !== 'installing') {
          expect(job.status).toBe('failed');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(
        (await jsonResponse(await controlRequest(runtime, controlKey, 'GET', '/api/v1/clis'))) as unknown[],
      ).toHaveLength(0);
      expect(
        (await jsonResponse(
          await controlRequest(runtime, controlKey, 'GET', '/api/v1/credentials'),
        )) as unknown[],
      ).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
      await close();
    }
  });

  it('installs and uninstalls a hosted CLI as a CLI target', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const result = (await installEntry(runtime, controlKey, 'host-shell')) as {
        cliId: string;
        installation: { targetType: string; targetId: string };
        credential: { id: string; type: string };
      };
      expect(result.credential.type).toBe('env');
      expect(result.installation).toMatchObject({ targetType: 'cli', targetId: result.cliId });

      const clis = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', '/api/v1/clis'),
      )) as {
        id: string;
        slug: string;
        command: string;
        executionMode: string;
        entrypoint: string | null;
      }[];
      expect(clis.find((cli) => cli.id === result.cliId)).toMatchObject({
        slug: 'host-shell',
        command: '/bin/sh',
        executionMode: 'host',
        entrypoint: null,
        allowList: { allow: [['-c', '*']], deny: [] },
      });

      await jsonResponse(
        await controlRequest(
          runtime,
          controlKey,
          'POST',
          '/api/v1/market/host-shell/uninstall',
          {},
        ),
      );
      expect(
        (await jsonResponse(
          await controlRequest(runtime, controlKey, 'GET', '/api/v1/clis'),
        )) as unknown[],
      ).toHaveLength(0);
      expect(
        (
          (await jsonResponse(
            await controlRequest(runtime, controlKey, 'GET', '/api/v1/market/installations'),
          )) as { entryId: string }[]
        ).some((item) => item.entryId === 'host-shell'),
      ).toBe(false);
    } finally {
      await close();
    }
  });

  it('keeps the CLI and installation marker consistent when uninstall fails', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      await installEntry(runtime, controlKey, 'host-shell');
      const deleteInstallation = vi.spyOn(runtime.store, 'deleteInstallation').mockImplementation(
        () => {
          throw new Error('installation delete failed');
        },
      );

      const response = await controlRequest(
        runtime,
        controlKey,
        'POST',
        '/api/v1/market/host-shell/uninstall',
        {},
      );
      expect(response.status).toBe(500);
      expect(
        (await jsonResponse(await controlRequest(runtime, controlKey, 'GET', '/api/v1/clis'))) as unknown[],
      ).toHaveLength(1);
      expect(
        (
          (await jsonResponse(
            await controlRequest(runtime, controlKey, 'GET', '/api/v1/market/installations'),
          )) as { entryId: string }[]
        ).some((item) => item.entryId === 'host-shell'),
      ).toBe(true);

      deleteInstallation.mockRestore();
      const retry = await controlRequest(
        runtime,
        controlKey,
        'POST',
        '/api/v1/market/host-shell/uninstall',
        {},
      );
      expect(retry.status).toBe(200);
    } finally {
      vi.restoreAllMocks();
      await close();
    }
  });

  it('rolls back an MCP uninstall when metadata cleanup fails', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const result = (await installEntry(runtime, controlKey, 'context7', {
        CONTEXT7_API_KEY: 'ctx-test',
      })) as { server: { id: string }; credential: { id: string } };
      vi.spyOn(runtime.store, 'deleteInstallation').mockImplementation(() => {
        throw new Error('installation delete failed');
      });

      const response = await controlRequest(
        runtime,
        controlKey,
        'POST',
        '/api/v1/market/context7/uninstall',
        {},
      );
      expect(response.status).toBe(500);
      expect(
        (await jsonResponse(await controlRequest(runtime, controlKey, 'GET', '/api/v1/servers'))) as {
          id: string;
        }[],
      ).toEqual(expect.arrayContaining([expect.objectContaining({ id: result.server.id })]));
      expect(
        (await jsonResponse(
          await controlRequest(runtime, controlKey, 'GET', '/api/v1/credentials'),
        )) as { id: string }[],
      ).toEqual(expect.arrayContaining([expect.objectContaining({ id: result.credential.id })]));
      expect(
        (
          (await jsonResponse(
            await controlRequest(runtime, controlKey, 'GET', '/api/v1/market/installations'),
          )) as { entryId: string }[]
        ).some((item) => item.entryId === 'context7'),
      ).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await close();
    }
  });

  it('rejects a concurrent install for the same market entry', async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'toolhome-market-concurrent-'));
    const uvPath = join(fakeBin, 'uv');
    writeFileSync(uvPath, '#!/bin/sh\nsleep 1\nexit 0\n');
    chmodSync(uvPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const responses = await Promise.all(
        [1, 2].map(() =>
          controlRequest(runtime, controlKey, 'POST', '/api/v1/market/fetch/install', {
            values: {},
          }),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const started = responses.find((response) => response.status === 200);
      if (!started) throw new Error('install request was not accepted');
      const body = (await started.json()) as { jobId: string };
      for (;;) {
        const job = (await jsonResponse(
          await controlRequest(runtime, controlKey, 'GET', `/api/v1/market/install/${body.jobId}`),
        )) as { status: string; error?: string };
        if (job.status !== 'installing') {
          expect(job.status, job.error).toBe('completed');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const installations = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', '/api/v1/market/installations'),
      )) as { entryId: string }[];
      expect(installations.filter((item) => item.entryId === 'fetch')).toHaveLength(1);
    } finally {
      await close();
      process.env.PATH = previousPath;
    }
  });

  it('rejects a second pending secret install for the same hosted CLI', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const first = await controlRequest(
        runtime,
        controlKey,
        'POST',
        '/api/v1/market/gh-cli/install',
        { values: {} },
      );
      expect(first.status).toBe(200);
      const second = await controlRequest(
        runtime,
        controlKey,
        'POST',
        '/api/v1/market/gh-cli/install',
        { values: {} },
      );
      expect(second.status).toBe(409);
      expect((await second.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'market_operation_in_progress' },
      });
    } finally {
      await close();
    }
  });

  it('reclaims a market entry after its install job is interrupted', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const started = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'POST', '/api/v1/market/gh-cli/install', {
          values: {},
        }),
      )) as { jobId: string; actionId: string };
      runtime.store.updateInstallJob(started.jobId, { status: 'interrupted' });

      const retry = await controlRequest(
        runtime,
        controlKey,
        'POST',
        '/api/v1/market/gh-cli/install',
        { values: {} },
      );
      expect(retry.status).toBe(200);
      expect((await retry.json()) as { status: string }).toMatchObject({
        status: 'awaiting_secret',
      });
    } finally {
      await close();
    }
  });

  it('allows only one concurrent completion for a hosted CLI secret action', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const started = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'POST', '/api/v1/market/gh-cli/install', {
          values: {},
        }),
      )) as { actionId: string; actionUrl: string };
      const actionUrl = new URL(started.actionUrl);
      const token = actionUrl.searchParams.get('token');
      if (!token) throw new Error('secure action token missing');
      const requests = [1, 2].map(() =>
        applicationFetch(
          runtime,
          new URL(`/api/v1/secure-actions/${started.actionId}/complete`, runtime.config.publicUrl),
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${controlKey}`,
              'content-type': 'application/json',
              host: runtime.config.publicUrl.host,
            },
            body: JSON.stringify({ token, values: { GH_TOKEN: 'gh-test-token' } }),
          },
        ),
      );
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    } finally {
      await close();
    }
  });

  it('allows a secure action URL to be completed without a control key', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const started = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'POST', '/api/v1/market/gh-cli/install', {
          values: {},
        }),
      )) as { actionId: string; actionUrl: string };
      const actionUrl = new URL(started.actionUrl);
      const token = actionUrl.searchParams.get('token');
      if (!token) throw new Error('secure action token missing');
      const info = await applicationFetch(
        runtime,
        new URL(
          `/api/v1/secure-actions/${started.actionId}?token=${encodeURIComponent(token)}`,
          runtime.config.publicUrl,
        ),
      );
      expect(info.status).toBe(200);
      expect((await info.json()) as { entryId: string }).toMatchObject({ entryId: 'gh-cli' });
      const completed = await applicationFetch(
        runtime,
        new URL(`/api/v1/secure-actions/${started.actionId}/complete`, runtime.config.publicUrl),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', host: runtime.config.publicUrl.host },
          body: JSON.stringify({
            token: actionUrl.searchParams.get('token'),
            values: { GH_TOKEN: 'gh-test-token' },
          }),
        },
      );
      expect(completed.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('does not consume a secure action when its install job is no longer resumable', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const started = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'POST', '/api/v1/market/gh-cli/install', {
          values: {},
        }),
      )) as { jobId: string; actionId: string; actionUrl: string };
      const token = new URL(started.actionUrl).searchParams.get('token');
      if (!token) throw new Error('secure action token missing');
      runtime.store.updateInstallJob(started.jobId, { status: 'interrupted' });

      const completed = await controlRequest(
        runtime,
        controlKey,
        'POST',
        `/api/v1/secure-actions/${started.actionId}/complete`,
        { token, values: { GH_TOKEN: 'gh-test-token' } },
      );
      expect(completed.status).toBe(404);

      const info = await applicationFetch(
        runtime,
        new URL(
          `/api/v1/secure-actions/${started.actionId}?token=${encodeURIComponent(token)}`,
          runtime.config.publicUrl,
        ),
      );
      expect(info.status).toBe(200);
      expect((await info.json()) as { status: string }).toMatchObject({ status: 'pending' });
    } finally {
      await close();
    }
  });

  it('fails an install job once its secure action expires and releases the entry', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const started = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'POST', '/api/v1/market/gh-cli/install', {
          values: {},
        }),
      )) as { jobId: string; actionId: string };

      const before = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', `/api/v1/market/install/${started.jobId}`),
      )) as { status: string };
      expect(before.status).toBe('awaiting_secret');

      // Simulate the secret-link TTL elapsing.
      const getSecureAction = runtime.store.getSecureAction.bind(runtime.store);
      vi.spyOn(runtime.store, 'getSecureAction').mockImplementation((id) => {
        const action = getSecureAction(id);
        if (action?.id === started.actionId) {
          return { ...action, expiresAt: new Date(Date.now() - 1000).toISOString() };
        }
        return action;
      });

      const job = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', `/api/v1/market/install/${started.jobId}`),
      )) as { status: string; error?: string };
      expect(job.status).toBe('failed');
      expect(job.error).toBe('secure_action_expired');

      // The expired wait must not wedge the entry: a fresh install starts cleanly.
      const retried = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'POST', '/api/v1/market/gh-cli/install', {
          values: {},
        }),
      )) as { status: string };
      expect(retried.status).toBe('awaiting_secret');
    } finally {
      vi.restoreAllMocks();
      await close();
    }
  });

  it('completes a hosted CLI secret action and resumes the CLI install path', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const started = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'POST', '/api/v1/market/gh-cli/install', {
          values: {},
        }),
      )) as { jobId: string; status: string; actionId: string; actionUrl: string };
      expect(started.status).toBe('awaiting_secret');
      const actionUrl = new URL(started.actionUrl);
      expect(actionUrl.pathname).toContain(`/market/actions/${started.actionId}`);

      const completed = (await jsonResponse(
        await controlRequest(
          runtime,
          controlKey,
          'POST',
          `/api/v1/secure-actions/${started.actionId}/complete`,
          {
            token: actionUrl.searchParams.get('token'),
            values: { GH_TOKEN: 'gh-test-token' },
          },
        ),
      )) as { status: string };
      expect(['installing', 'completed']).toContain(completed.status);

      let job: {
        status: string;
        result?: { cliId: string; installation: { targetType: string } };
        error?: string;
      };
      for (;;) {
        job = (await jsonResponse(
          await controlRequest(
            runtime,
            controlKey,
            'GET',
            `/api/v1/market/install/${started.jobId}`,
          ),
        )) as typeof job;
        if (job.status !== 'installing') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(job.status, job.error).toBe('completed');
      expect(job.result?.installation.targetType).toBe('cli');
      const credentials = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', '/api/v1/credentials'),
      )) as { id: string; type: string }[];
      expect(credentials.some((credential) => credential.type === 'env')).toBe(true);
    } finally {
      await close();
    }
  });

  it('installs and uninstalls a remote bearer entry', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const result = (await installEntry(runtime, controlKey, 'context7', {
        CONTEXT7_API_KEY: 'ctx-test',
      })) as { server: unknown; credential: unknown };
      const server = serverRecordSchema.parse(result.server);
      const credential = credentialRecordSchema.parse(result.credential);
      expect(server.slug).toBe('context7');
      expect(credential.type).toBe('bearer');

      const afterInstall = await marketList(runtime, controlKey);
      expect(afterInstall.find((item) => item.id === 'context7')?.installed).toBe(true);

      const uninstall = await jsonResponse(
        await controlRequest(runtime, controlKey, 'POST', '/api/v1/market/context7/uninstall', {}),
      );
      expect(uninstall).toEqual({ uninstalled: true });

      const afterUninstall = await marketList(runtime, controlKey);
      expect(afterUninstall.find((item) => item.id === 'context7')?.installed).toBe(false);
    } finally {
      await close();
    }
  });

  it('installs a remote oauth entry with an empty credential', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const result = (await installEntry(runtime, controlKey, 'deepwiki')) as {
        server: unknown;
        credential: unknown;
      };
      const credential = credentialRecordSchema.parse(result.credential);
      expect(credential.type).toBe('oauth');
      expect(credential.status).toBe('pending');
    } finally {
      await close();
    }
  });

  it('elicits secrets via URL and rejects missing non-secret values', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      // A required secret is elicited through a one-time action URL — never
      // accepted through the install request itself.
      const elicit = await controlRequest(
        runtime,
        controlKey,
        'POST',
        '/api/v1/market/exa/install',
        {
          values: {},
        },
      );
      expect(elicit.status).toBe(200);
      const body = (await elicit.json()) as { status: string; actionUrl: string };
      expect(body.status).toBe('awaiting_secret');
      expect(body.actionUrl).toMatch(/^http:\/\/toolhome\.test\/market\/actions\//);
      // The response carries only job + action URL — no secret, no values echo.
      expect(Object.keys(body).sort()).toEqual(['actionId', 'actionUrl', 'jobId', 'status']);

      // Missing non-secret required value is still a validation error.
      const missing = await controlRequest(
        runtime,
        controlKey,
        'POST',
        '/api/v1/market/sqlite/install',
        {
          values: {},
        },
      );
      expect(missing.status).toBe(400);

      const unknown = await controlRequest(
        runtime,
        controlKey,
        'POST',
        '/api/v1/market/does-not-exist/install',
        {},
      );
      expect(unknown.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('is idempotent: reinstalling an entry reports already-installed without duplicates', async () => {
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      await installEntry(runtime, controlKey, 'context7', { CONTEXT7_API_KEY: 'ctx-test' });
      const second = await controlRequest(
        runtime,
        controlKey,
        'POST',
        '/api/v1/market/context7/install',
        { values: { CONTEXT7_API_KEY: 'ctx-test' } },
      );
      expect(second.status).toBe(200);
      const body = (await second.json()) as { status: string };
      expect(body.status).toBe('already_installed');
      const servers = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', '/api/v1/servers'),
      )) as { slug: string }[];
      expect(servers.filter((server) => server.slug === 'context7')).toHaveLength(1);
      const installations = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', '/api/v1/market/installations'),
      )) as {
        entryId: string;
        entryVersion: string;
        source: string;
        targetType: string;
        targetId: string;
      }[];
      const row = installations.find((item) => item.entryId === 'context7');
      expect(row?.source).toBe('curated');
      expect(row?.entryVersion).toBe('unpinned');
      expect(row?.targetType).toBe('server');
      expect(row?.targetId).toBeTruthy();
    } finally {
      await close();
    }
  });

  it('installs a uvx entry via uv tool install', async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'toolhome-uv-'));
    const uvPath = join(fakeBin, 'uv');
    const argsLog = join(fakeBin, 'uv-args.log');
    writeFileSync(uvPath, `#!/bin/sh\necho "$@" > "${argsLog}"\nexit 0\n`);
    chmodSync(uvPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath}`;
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const result = (await installEntry(runtime, controlKey, 'fetch')) as {
        server: unknown;
        credential: unknown;
      };
      const server = serverRecordSchema.parse(result.server);
      const credential = credentialRecordSchema.parse(result.credential);
      expect(server.slug).toBe('fetch');
      expect(server.transport.type).toBe('stdio');
      if (server.transport.type === 'stdio') {
        expect(server.transport.command).toBe('uvx');
        expect(server.transport.args).toEqual(['mcp-server-fetch']);
        expect(server.transport.env?.UV_CACHE_DIR).toBeDefined();
        expect(server.transport.env?.UV_TOOL_DIR).toBeDefined();
      }
      expect(credential.type).toBe('env');
      const recorded = readFileSync(argsLog, 'utf8');
      expect(recorded).toContain('tool install mcp-server-fetch==2026.7.10');
      expect(recorded).toContain('--with');
      expect(recorded).toContain('mcp<2');
      const installations = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', '/api/v1/market/installations'),
      )) as { entryId: string; entryVersion: string; recipeRevision: string }[];
      const row = installations.find((item) => item.entryId === 'fetch');
      expect(row?.entryVersion).toBe('2026.7.10');
      expect(row?.recipeRevision.length).toBeGreaterThan(10);
    } finally {
      await close();
      process.env.PATH = previousPath;
    }
  });

  it('installs a docker entry via docker run and reports the image transport', async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'toolhome-docker-'));
    const dockerPath = join(fakeBin, 'docker');
    writeFileSync(
      dockerPath,
      '#!/bin/sh\ncase "$1 $2" in\n  "image inspect") echo "No such image" >&2; exit 1 ;;\n  "pull markitdown-mcp:latest") echo "Pulled" >&2; exit 0 ;;\nesac\necho "docker called: $*" >&2\nexit 0\n',
    );
    chmodSync(dockerPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath}`;
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const result = (await installEntry(runtime, controlKey, 'markitdown')) as {
        server: unknown;
      };
      const server = serverRecordSchema.parse(result.server);
      expect(server.slug).toBe('markitdown');
      expect(server.transport.type).toBe('stdio');
      if (server.transport.type === 'stdio') {
        expect(server.transport.command).toBe('docker');
        expect(server.transport.args).toEqual(['run', '--rm', '-i', 'markitdown-mcp:latest']);
      }
    } finally {
      await close();
      process.env.PATH = previousPath;
    }
  });

  it('builds a docker entry image from the inline Dockerfile when not pullable', async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'toolhome-docker-build-'));
    const dockerPath = join(fakeBin, 'docker');
    writeFileSync(
      dockerPath,
      '#!/bin/sh\ncase "$1" in\n  image) echo "No such image" >&2; exit 1 ;;\n  pull) echo "manifest unknown" >&2; exit 1 ;;\n  build) echo "Built image" >&2; exit 0 ;;\nesac\necho "docker called: $*" >&2\nexit 0\n',
    );
    chmodSync(dockerPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath}`;
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const result = (await installEntry(runtime, controlKey, 'markitdown')) as {
        server: unknown;
      };
      const server = serverRecordSchema.parse(result.server);
      expect(server.slug).toBe('markitdown');
      const dockerfile = readFileSync(
        join('/tmp/toolhome-test-market/dockerfiles/markitdown/Dockerfile'),
        'utf8',
      );
      expect(dockerfile).toContain('FROM python:3.13-slim');
      expect(dockerfile).toContain('markitdown-mcp==0.0.1a4');
    } finally {
      await close();
      process.env.PATH = previousPath;
    }
  });

  it('installs an npm home-stdio entry with an env credential (mosaic)', async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'toolhome-npm-'));
    const npmPath = join(fakeBin, 'npm');
    writeFileSync(npmPath, '#!/bin/sh\necho "npm $@" >&2\nexit 0\n');
    chmodSync(npmPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath}`;
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const result = (await installEntry(runtime, controlKey, 'mosaic', {
        MOSAIC_SERVER_URL: 'https://m.cyncyn.xyz',
        MOSAIC_USERNAME: 'crayon',
        MOSAIC_PASSWORD: 'crayoncrayon',
      })) as { server: unknown; credential: unknown };
      const server = serverRecordSchema.parse(result.server);
      const credential = credentialRecordSchema.parse(result.credential);
      expect(server.slug).toBe('mosaic');
      expect(server.transport.type).toBe('stdio');
      if (server.transport.type === 'stdio') {
        expect(server.transport.command).toContain('mosaic-mcp');
        expect(server.transport.args).toEqual([]);
      }
      expect(credential.type).toBe('env');
      const installations = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', '/api/v1/market/installations'),
      )) as { entryId: string; entryVersion: string; source: string }[];
      const row = installations.find((item) => item.entryId === 'mosaic');
      expect(row?.source).toBe('curated');
      expect(row?.entryVersion).toBe('0.2.0');
    } finally {
      await close();
      process.env.PATH = previousPath;
    }
  });

  it('updates an installed entry to the catalog pin, keeping the credential', async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'toolhome-uv-update-'));
    const uvPath = join(fakeBin, 'uv');
    const argsLog = join(fakeBin, 'uv-args.log');
    writeFileSync(uvPath, `#!/bin/sh\necho "$@" >> "${argsLog}"\nexit 0\n`);
    chmodSync(uvPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath}`;
    const { runtime, controlKey, close } = createTestRuntime();
    try {
      const result = (await installEntry(runtime, controlKey, 'fetch')) as {
        server: { id: string; credentialId: string | null };
      };
      const credentialId = result.server.credentialId;

      // No drift yet: up_to_date is idempotent.
      const noDrift = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'POST', '/api/v1/market/fetch/update', {}),
      )) as { status: string };
      expect(noDrift.status).toBe('up_to_date');

      // Simulate an older installed version.
      const installations = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', '/api/v1/market/installations'),
      )) as { id: string; entryId: string; entryVersion: string }[];
      const installation = installations.find((item) => item.entryId === 'fetch');
      runtime.store.updateInstallation(installation!.id, { entryVersion: '2025.1.1' });

      const updates = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', '/api/v1/market/updates'),
      )) as {
        entryId: string;
        installedVersion: string;
        catalogVersion: string;
        updateAvailable: boolean;
        latestUpstream: string | null;
      }[];
      const fetchUpdate = updates.find((item) => item.entryId === 'fetch');
      expect(fetchUpdate?.installedVersion).toBe('2025.1.1');
      expect(fetchUpdate?.catalogVersion).toBe('2026.7.10');
      expect(fetchUpdate?.updateAvailable).toBe(true);

      const list = (await marketList(runtime, controlKey)) as (MarketItem & {
        updateAvailable: boolean;
      })[];
      expect(list.find((item) => item.id === 'fetch')?.updateAvailable).toBe(true);

      // Run the update; the fake uv succeeds, the (real) uvx restart fails but
      // must not fail the job — the package and record are already updated.
      const started = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'POST', '/api/v1/market/fetch/update', {}),
      )) as { jobId: string; status: string };
      expect(started.status).toBe('updating');
      let job: { status: string; result?: { version?: string; restartError?: string } };
      for (;;) {
        job = (await jsonResponse(
          await controlRequest(
            runtime,
            controlKey,
            'GET',
            `/api/v1/market/install/${started.jobId}`,
          ),
        )) as typeof job;
        if (job.status !== 'updating') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(job.status).toBe('completed');
      expect(job.result?.version).toBe('2026.7.10');

      // The reinstall hit the catalog pin again.
      const log = readFileSync(argsLog, 'utf8');
      expect(log.match(/tool install mcp-server-fetch==2026\.7\.10/g)?.length).toBe(2);

      // Installation record bumped; server kept its credential.
      const after = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', '/api/v1/market/installations'),
      )) as { entryId: string; entryVersion: string }[];
      expect(after.find((item) => item.entryId === 'fetch')?.entryVersion).toBe('2026.7.10');
      const server = (await jsonResponse(
        await controlRequest(runtime, controlKey, 'GET', `/api/v1/servers/${result.server.id}`),
      )) as { credentialId: string | null };
      expect(server.credentialId).toBe(credentialId);

      const listAfter = (await marketList(runtime, controlKey)) as (MarketItem & {
        updateAvailable: boolean;
      })[];
      expect(listAfter.find((item) => item.id === 'fetch')?.updateAvailable).toBe(false);
    } finally {
      await close();
      process.env.PATH = previousPath;
    }
  });

  it('marks install jobs interrupted across a process restart instead of losing them', async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'toolhome-uv-slow-'));
    const uvPath = join(fakeBin, 'uv');
    writeFileSync(uvPath, '#!/bin/sh\nsleep 60\nexit 0\n');
    chmodSync(uvPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath}`;
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-restart-'));
    const first = createTestRuntime({ directory, persist: true });
    let jobId: string;
    try {
      const started = (await jsonResponse(
        await controlRequest(
          first.runtime,
          first.controlKey,
          'POST',
          '/api/v1/market/fetch/install',
          {},
        ),
      )) as { jobId: string; status: string };
      expect(started.status).toBe('installing');
      jobId = started.jobId;
    } finally {
      await first.close();
    }
    // A fresh runtime on the same data dir sees the interrupted job.
    const second = createTestRuntime({ directory });
    try {
      const job = (await jsonResponse(
        await controlRequest(
          second.runtime,
          second.controlKey,
          'GET',
          `/api/v1/market/install/${jobId}`,
        ),
      )) as { status: string };
      expect(job.status).toBe('interrupted');
    } finally {
      await second.close();
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
      process.env.PATH = previousPath;
    }
  });
});
