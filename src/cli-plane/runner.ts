import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CliExecFrame } from './frames.js';

export interface ExecRequest {
  /** Host: binary path/name. Docker: container image reference. */
  command: string;
  /** argv passed verbatim to the binary — never through a shell. */
  argv: string[];
  /** Full environment for the child (base env + enforcement vars + credential vars). */
  env: Record<string, string>;
  stdin?: string | null;
  timeoutMs: number;
  maxOutputBytes: number;
  executionMode: 'host' | 'docker';
}

export interface ExecOutcome {
  code: number | null;
  durationMs: number;
  result: 'ok' | 'error' | 'timeout';
  truncated: boolean;
}

const killGraceMs = 1_000;

/**
 * Run a CLI process and stream its output as NDJSON frames.
 *
 * The process is spawned directly (no shell); stdout and stderr are forwarded
 * as separate frames. A still-running child is SIGTERM'd at `timeoutMs` and
 * SIGKILL'd after a grace period. Output is memory-bounded: once
 * `maxOutputBytes` have been forwarded, further chunks are dropped and the
 * final exit frame carries `truncated: true`.
 */
export function execCli(
  request: ExecRequest,
  emit: (frame: CliExecFrame) => void,
  signal?: AbortSignal,
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const isDocker = request.executionMode === 'docker';
    const spawnCommand = isDocker ? 'docker' : request.command;
    const spawnArgs = isDocker ? ['run', '--rm', '-i', request.command, ...request.argv] : request.argv;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        env: request.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (error) {
      emit({ type: 'stderr', data: error instanceof Error ? error.message : String(error) });
      emit({ type: 'exit', code: null, durationMs: 0, result: 'error' });
      resolve({ code: null, durationMs: 0, result: 'error', truncated: false });
      return;
    }

    const started = Date.now();
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    let forwardedBytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let escalateTimer: NodeJS.Timeout | undefined;

    const forward = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled || timedOut || aborted) return;
      const remaining = request.maxOutputBytes - forwardedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > remaining) {
        truncated = true;
        forwardedBytes += remaining;
        emit({ type: stream, data: chunk.subarray(0, remaining).toString('utf8') });
        return;
      }
      forwardedBytes += chunk.length;
      emit({ type: stream, data: chunk.toString('utf8') });
    };

    child.stdout.on('data', (chunk: Buffer) => forward('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => forward('stderr', chunk));

    const terminate = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // child already gone
      }
      if (escalateTimer === undefined) {
        escalateTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // child already gone
          }
        }, killGraceMs);
        escalateTimer.unref();
      }
    };

    killTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    killTimer.unref();

    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (escalateTimer !== undefined) clearTimeout(escalateTimer);
      signal?.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - started;
      const result = aborted ? 'error' : timedOut ? 'timeout' : code === 0 ? 'ok' : 'error';
      emit({
        type: 'exit',
        code: timedOut || aborted ? null : code,
        durationMs,
        result,
        ...(truncated ? { truncated: true } : {}),
      });
      resolve({ code: timedOut || aborted ? null : code, durationMs, result, truncated });
    };

    child.on('error', (error) => {
      if (!settled) {
        emit({ type: 'stderr', data: error instanceof Error ? error.message : String(error) });
      }
    });
    child.on('close', (code) => finish(code));
  });
}
