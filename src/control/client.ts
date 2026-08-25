import { AppError } from '../domain/errors.js';
import { cliNdjsonContentType, type CliExecFrame } from '../cli-plane/frames.js';

export interface ExecOutcomeSummary {
  code: number | null;
  durationMs: number;
  result: 'ok' | 'error' | 'timeout';
  truncated?: boolean;
}

export class ControlClient {
  readonly #baseUrl: URL;
  readonly #apiKey: string;

  constructor(baseUrl: URL, apiKey: string) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
  }

  /**
   * Run a hosted CLI and stream its NDJSON frames to `onFrame`. Resolves with
   * the final exit frame; rejects if the server errors or the stream ends
   * without one. Aborting `signal` cancels the remote process.
   */
  async execStream(
    slug: string,
    input: {
      argv: string[];
      stdin?: string | null;
      timeoutMs?: number;
      maxOutputBytes?: number;
    },
    onFrame: (frame: CliExecFrame) => void,
    signal?: AbortSignal,
  ): Promise<ExecOutcomeSummary> {
    const target = new URL(`/cli/${encodeURIComponent(slug)}/exec`, this.#baseUrl);
    if (target.origin !== this.#baseUrl.origin) {
      throw new AppError(
        'invalid_control_path',
        'CLI exec path must stay on the server origin',
        400,
      );
    }
    const response = await fetch(target, {
      method: 'POST',
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(3_600_000),
      headers: {
        accept: cliNdjsonContentType,
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!response.ok || response.body === null) {
      const value: unknown = await response.json().catch(() => null);
      const message =
        value !== null && typeof value === 'object' && Reflect.get(value, 'error') !== undefined
          ? (errorMessage(value) ?? `CLI exec returned ${response.status}`)
          : `CLI exec returned ${response.status}`;
      throw new AppError('control_api_error', message, response.status, { response: value });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let outcome: ExecOutcomeSummary | null = null;
    const consume = async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line !== '') {
            const frame = JSON.parse(line) as CliExecFrame;
            onFrame(frame);
            if (frame.type === 'exit') {
              outcome = {
                code: frame.code,
                durationMs: frame.durationMs,
                result: frame.result,
                ...(frame.truncated ? { truncated: true } : {}),
              };
            }
          }
          newline = buffer.indexOf('\n');
        }
      }
    };

    try {
      await consume();
    } finally {
      reader.releaseLock();
    }
    if (outcome === null) {
      throw new AppError('cli_exec_no_exit', 'CLI exec stream ended without an exit frame', 502);
    }
    return outcome;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const target = new URL(path, this.#baseUrl);
    if (
      target.origin !== this.#baseUrl.origin ||
      !(target.pathname.startsWith('/api/v1/') || target.pathname.startsWith('/cli/'))
    ) {
      throw new AppError(
        'invalid_control_path',
        'Control API path must stay under /api/v1/ or /cli/',
        400,
      );
    }
    const response = await fetch(target, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.#apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = await response
      .json()
      .catch(() => ({ error: { message: response.statusText } }));
    if (!response.ok) {
      const message = errorMessage(value) ?? `Control API returned ${response.status}`;
      throw new AppError('control_api_error', message, response.status, { response: value });
    }
    return value;
  }
}

function errorMessage(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const error = Reflect.get(value, 'error');
  if (error === null || typeof error !== 'object') return null;
  const message = Reflect.get(error, 'message');
  return typeof message === 'string' ? message : null;
}
