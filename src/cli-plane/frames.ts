/**
 * NDJSON frames for the CLI exec stream (docs/cli-hosting-research.md §2.2).
 *
 * The stream is newline-delimited JSON: one `stdout`/`stderr` frame per chunk,
 * terminated by a single `exit` frame carrying the real exit code, duration,
 * and an explicit `timeout`/`error` result when the process did not exit
 * normally.
 */
export type CliExecFrame =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | {
      type: 'exit';
      code: number | null;
      durationMs: number;
      result: 'ok' | 'error' | 'timeout';
      truncated?: boolean;
    };

export const cliNdjsonContentType = 'application/x-ndjson';

export function encodeFrame(frame: CliExecFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Parse a full NDJSON body into frames; throws on malformed input. */
export function parseFrames(body: string): CliExecFrame[] {
  return body
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CliExecFrame);
}
