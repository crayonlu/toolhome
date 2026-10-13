import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { exportVolumeArchive, importVolumeArchive } from '../../src/cli-plane/state.js';

interface FakeChildOptions {
  stdout?: Buffer;
  stderr?: string;
  code?: number | null;
  onStdin?: (data: Buffer) => void;
  captureArgv?: (argv: string[]) => void;
}

function fakeSpawn(options: FakeChildOptions): typeof spawn {
  const spawnLike = (command: string, argv: string[]): ChildProcessWithoutNullStreams => {
    options.captureArgv?.([command, ...argv]);
    const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (chunk: Buffer) => options.onStdin?.(chunk));
    child.kill = (() => {
      setImmediate(() => child.emit('close', 137));
      return true;
    }) as typeof child.kill;
    const originalEnd = child.stdin.end.bind(child.stdin);
    child.stdin.end = ((chunk?: never) => {
      originalEnd(chunk);
      setImmediate(() => {
        if (options.stdout !== undefined) child.stdout.write(options.stdout);
        if (options.stderr !== undefined) child.stderr.write(options.stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', options.code ?? 0);
      });
      return child.stdin;
    }) as typeof child.stdin.end;
    return child;
  };
  return spawnLike as unknown as typeof spawn;
}

describe('hosted CLI state transfer', () => {
  it('archives a volume through a helper container that mounts it read-only', async () => {
    let argv: string[] = [];
    const archive = Buffer.from('tar-bytes');
    const result = await exportVolumeArchive('toolhome-gh-cli-state', {
      spawnFn: fakeSpawn({ stdout: archive, captureArgv: (captured) => (argv = captured) }),
    });
    expect(result).toEqual(archive);
    expect(argv).toEqual([
      'docker',
      'run',
      '--rm',
      '--volume',
      'toolhome-gh-cli-state:/data:ro',
      'alpine:3.20',
      'tar',
      '-cf',
      '-',
      '-C',
      '/data',
      '.',
    ]);
  });

  it('refuses an archive past the transfer ceiling', async () => {
    await expect(
      exportVolumeArchive('vol', {
        maxBytes: 4,
        spawnFn: fakeSpawn({ stdout: Buffer.from('too many bytes') }),
      }),
    ).rejects.toThrow(/transfer limit/);
  });

  it('surfaces the helper failure instead of an empty archive', async () => {
    await expect(
      exportVolumeArchive('vol', {
        spawnFn: fakeSpawn({ stderr: 'docker: command not found', code: 127, stdout: Buffer.alloc(0) }),
      }),
    ).rejects.toThrow(/docker: command not found/);
  });

  it('feeds an archive into the mounted volume', async () => {
    const archive = Buffer.from('restored-bytes');
    const chunks: Buffer[] = [];
    let argv: string[] = [];
    const restored = await importVolumeArchive('vol', archive, {
      spawnFn: fakeSpawn({
        captureArgv: (captured) => (argv = captured),
        onStdin: (chunk) => chunks.push(chunk),
      }),
    });
    expect(restored).toEqual({ bytes: archive.byteLength });
    expect(Buffer.concat(chunks)).toEqual(archive);
    // The volume is mounted writable for a restore and cleared before extracting.
    expect(argv.slice(0, 6)).toEqual([
      'docker',
      'run',
      '--rm',
      '--interactive',
      '--volume',
      'vol:/data',
    ]);
    expect(argv.at(-1)).toContain('tar -xf - -C /data');
  });

  it('rejects an oversized restore before spawning anything', async () => {
    let spawned = false;
    await expect(
      importVolumeArchive('vol', Buffer.from('0123456789'), {
        maxBytes: 4,
        spawnFn: (() => {
          spawned = true;
          return fakeSpawn({});
        }) as never,
      }),
    ).rejects.toThrow(/transfer limit/);
    expect(spawned).toBe(false);
  });
});
