import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateAllowList } from '../../src/cli-plane/allow-list.js';
import { encodeFrame, parseFrames, type CliExecFrame } from '../../src/cli-plane/frames.js';
import { execCli } from '../../src/cli-plane/runner.js';
import { parseProbeOutput } from '../../src/cli-plane/status.js';

const fixturePath = fileURLToPath(new URL('../fixtures/cli-fixture.mjs', import.meta.url));

describe('evaluateAllowList', () => {
  it('allows argv when both lists are empty (explicitly trusted entry)', () => {
    expect(evaluateAllowList(['vm', 'list'], { allow: [], deny: [] })).toEqual({
      verdict: 'allow',
    });
  });

  it('denies when a deny rule matches, even if an allow rule also matches', () => {
    const rules = { allow: [['login']], deny: [['login']] };
    expect(evaluateAllowList(['login'], rules)).toMatchObject({ verdict: 'deny' });
  });

  it('matches allow rules as argv prefixes with * as a single-token wildcard', () => {
    const rules = { allow: [['vm', '*']], deny: [] };
    expect(evaluateAllowList(['vm', 'list', '-o', 'table'], rules)).toEqual({ verdict: 'allow' });
    expect(evaluateAllowList(['vm', 'list'], rules)).toEqual({ verdict: 'allow' });
    expect(evaluateAllowList(['account', 'show'], rules)).toMatchObject({ verdict: 'deny' });
  });

  it('denies when no allow rule matches a non-empty allow list', () => {
    const rules = { allow: [['account', 'show']], deny: [] };
    const verdict = evaluateAllowList(['account', 'list'], rules);
    expect(verdict.verdict).toBe('deny');
    if (verdict.verdict === 'deny') expect(verdict.reason).toContain('allow rule');
  });

  it('does not match a rule longer than argv', () => {
    const rules = { allow: [['webapp', 'log', 'tail', '*']], deny: [] };
    expect(evaluateAllowList(['webapp', 'log'], rules)).toMatchObject({ verdict: 'deny' });
  });
});

describe('Docker CLI execution', () => {
  it('does not implicitly forward host environment variables into a container', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-docker-env-empty-'));
    const argsFile = join(directory, 'args.txt');
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
    try {
      await execCli(
        {
          command: 'example/cli:latest',
          argv: ['status'],
          env: { ...process.env, HOST_ONLY: 'not-forwarded' },
          stdin: null,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
          executionMode: 'docker',
        },
        () => undefined,
      );
      const args = readFileSync(argsFile, 'utf8').split('\\n').filter(Boolean);
      expect(args).not.toContain('--env');
      expect(args).not.toContain('HOST_ONLY');
    } finally {
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('forwards the execution environment into the container command', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-docker-env-'));
    const argsFile = join(directory, 'args.txt');
    const dockerPath = join(directory, 'docker');
    writeFileSync(
      dockerPath,
      `#!/bin/sh
printf '%s\n' "$@" > "${argsFile}"
exit 0
`,
    );
    chmodSync(dockerPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ''}`;
    try {
      await execCli(
        {
          command: 'example/cli:latest',
          argv: ['status'],
          env: { ...process.env, GH_TOKEN: 'secret-token', CI: 'true' },
          stdin: null,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
          executionMode: 'docker',
          containerEnvKeys: ['GH_TOKEN', 'CI'],
          entrypoint: 'gh',
        },
        () => undefined,
      );
      const args = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
      expect(args).toEqual([
        'run',
        '--rm',
        '-i',
        '--entrypoint',
        'gh',
        '--env',
        'GH_TOKEN',
        '--env',
        'CI',
        'example/cli:latest',
        'status',
      ]);
    } finally {
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('host CLI execution', () => {
  it('passes stdin to the child process and closes the input stream', async () => {
    const frames: CliExecFrame[] = [];
    await execCli(
      {
        command: fixturePath,
        argv: ['stdin'],
        env: process.env as Record<string, string>,
        stdin: 'ToolHome input',
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
        executionMode: 'host',
      },
      (frame) => frames.push(frame),
    );
    expect(frames).toContainEqual({ type: 'stdout', data: 'ToolHome input\n' });
    expect(frames.find((frame) => (frame as { type: string }).type === 'exit')).toMatchObject({
      type: 'exit',
      code: 0,
      result: 'ok',
    });
  });
});

describe('probe output parsing', () => {
  it('extracts version and loggedIn from key=value lines', () => {
    expect(parseProbeOutput('version=azure-cli 2.61.0\nloggedIn=true\n')).toEqual({
      version: 'azure-cli 2.61.0',
      loggedIn: true,
    });
  });

  it('accepts logged_in and false values', () => {
    expect(parseProbeOutput('logged_in=false\n')).toEqual({ version: null, loggedIn: false });
  });

  it('defaults when keys are absent', () => {
    expect(parseProbeOutput('some noise\n')).toEqual({ version: null, loggedIn: false });
  });
});

describe('NDJSON frames', () => {
  it('round-trips frames through encode + parse', () => {
    const frames = [
      { type: 'stdout' as const, data: 'a\nb' },
      { type: 'stderr' as const, data: 'err' },
      { type: 'exit' as const, code: 0, durationMs: 123, result: 'ok' as const },
    ];
    const body = frames.map(encodeFrame).join('');
    expect(parseFrames(body)).toEqual(frames);
  });

  it('serializes the timeout exit frame with a null code', () => {
    const body = encodeFrame({ type: 'exit', code: null, durationMs: 99, result: 'timeout' });
    expect(parseFrames(body)).toEqual([
      { type: 'exit', code: null, durationMs: 99, result: 'timeout' },
    ]);
  });
});
