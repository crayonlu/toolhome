import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Read and write the state of a hosted CLI's container volume.
 *
 * Login state lives in a Docker named volume on the host, not in ToolHome, so it
 * moves as an archive: a helper container mounts the volume and streams a tar.
 * The gateway already needs the host Docker socket for `executionMode: docker`,
 * so this adds no new privilege. Contents are secrets — every entry point that
 * calls this is admin-only and audited.
 */

/** Ceiling for one volume archive; state is small configuration and token files. */
export const stateArchiveMaxBytes = 64 * 1024 * 1024;

export interface StateTransferOptions {
  dockerBinary?: string;
  helperImage?: string;
  maxBytes?: number;
  spawnFn?: typeof spawn;
}

export class StateTransferError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StateTransferError';
    this.code = code;
  }
}

/** Archive one named volume; resolution is capped at `maxBytes`. */
export function exportVolumeArchive(
  volume: string,
  options: StateTransferOptions = {},
): Promise<Buffer> {
  const limit = options.maxBytes ?? stateArchiveMaxBytes;
  return new Promise((resolve, reject) => {
    const child = spawnVolumeHelper(volume, ['tar', '-cf', '-', '-C', '/data', '.'], options, {
      readOnly: true,
      interactive: false,
    });
    // Nothing is written to the helper; closing stdin lets it exit on its own.
    child.stdin.end();
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = '';
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) {
        failed = `volume "${volume}" exceeds the ${String(limit)} byte transfer limit`;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      failed ||= chunk.toString('utf8');
    });
    child.on('error', (error) => {
      reject(new StateTransferError('state_transfer_failed', error.message));
    });
    child.on('close', (code) => {
      if (code === 0 && failed === '') {
        resolve(Buffer.concat(chunks));
        return;
      }
      reject(
        new StateTransferError(
          'state_transfer_failed',
          failed.trim() !== ''
            ? failed.trim().split('\n').slice(-1)[0]!
            : `tar helper exited with ${String(code)}`,
        ),
      );
    });
  });
}

/** Replace the contents of one named volume with `archive`. */
export function importVolumeArchive(
  volume: string,
  archive: Buffer,
  options: StateTransferOptions = {},
): Promise<{ bytes: number }> {
  const limit = options.maxBytes ?? stateArchiveMaxBytes;
  if (archive.byteLength > limit) {
    return Promise.reject(
      new StateTransferError(
        'state_archive_too_large',
        `archive exceeds the ${String(limit)} byte transfer limit`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    // `-i` keeps stdin open for the archive; the volume starts empty on a fresh target.
    const child = spawnVolumeHelper(
      volume,
      ['sh', '-c', 'rm -rf /data/..?* /data/.[!.]* /data/* 2>/dev/null; tar -xf - -C /data'],
      options,
      { readOnly: false, interactive: true },
    );
    let failed = '';
    child.stderr.on('data', (chunk: Buffer) => {
      failed ||= chunk.toString('utf8');
    });
    child.on('error', (error) => {
      reject(new StateTransferError('state_transfer_failed', error.message));
    });
    child.on('close', (code) => {
      if (code === 0 && failed === '') {
        resolve({ bytes: archive.byteLength });
        return;
      }
      reject(
        new StateTransferError(
          'state_transfer_failed',
          failed.trim() !== ''
            ? failed.trim().split('\n').slice(-1)[0]!
            : `tar helper exited with ${String(code)}`,
        ),
      );
    });
    child.stdin.on('error', () => {
      // The helper exiting early closes stdin; the close handler reports why.
    });
    child.stdin.end(archive);
  });
}

function spawnVolumeHelper(
  volume: string,
  containerArgv: string[],
  options: StateTransferOptions,
  mode: { readOnly: boolean; interactive: boolean },
): ChildProcessWithoutNullStreams {
  const spawnFn = options.spawnFn ?? spawn;
  return spawnFn(
    options.dockerBinary ?? 'docker',
    [
      'run',
      '--rm',
      ...(mode.interactive ? ['--interactive'] : []),
      '--volume',
      `${volume}:/data${mode.readOnly ? ':ro' : ''}`,
      options.helperImage ?? 'alpine:3.20',
      ...containerArgv,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], shell: false },
  ) as ChildProcessWithoutNullStreams;
}
