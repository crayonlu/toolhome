import { mkdtempSync } from 'node:fs';
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
  allowList: { allow: string[][]; deny: string[][] };
  interactive: boolean;
  credentialId: string | null;
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
    allowList: { allow: [], deny: [] },
    interactive: false,
    credentialId: null,
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
  const response = await controlRequest(runtime.runtime, runtime.controlKey, 'POST', `/cli/${slug}/exec`, body);
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
        await controlRequest(second.runtime, second.controlKey, 'DELETE', `/api/v1/clis/${persisted?.id}`),
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

  it('rejects a duplicate slug with 409', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/clis', cliBody()),
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
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/clis', cliBody()),
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
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/clis', cliBody()),
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
        .filter((frame): frame is { type: 'stdout' | 'stderr'; data: string } =>
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
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/clis', cliBody()),
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

  it('injects attached Env Credential variables into the child environment', async () => {
    const runtime = createTestRuntime();
    try {
      const credential = (await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/credentials', {
          name: 'azure-sp',
          payload: { type: 'env', variables: { AZURE_CLIENT_ID: 'sp-123', TOOLHOME_TOKEN: 's3cret' } },
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

  it('records every exec in the events stream with slug, argv, code and duration', async () => {
    const runtime = createTestRuntime();
    try {
      await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/clis', cliBody()),
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
