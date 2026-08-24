import { AppError } from '../domain/errors.js';
import type { Store } from '../storage/store.js';
import { evaluateAllowList } from './allow-list.js';
import type { CliExecFrame } from './frames.js';
import {
  cliExecInputSchema,
  createCliInputSchema,
  updateCliInputSchema,
  type CliExecInput,
  type CliRecord,
} from './models.js';
import { execCli, type ExecOutcome } from './runner.js';
import { parseProbeOutput } from './status.js';

/**
 * Non-interactive enforcement variables injected into every CLI execution
 * (docs/cli-hosting-research.md §2.5): CLIs otherwise page, prompt, and
 * colorize unpredictably in a headless context.
 */
export const cliEnforcementEnv: Record<string, string> = {
  CI: 'true',
  NO_COLOR: '1',
  PAGER: 'cat',
  TERM: 'dumb',
};

export interface CliStatus {
  installed: boolean | null;
  version: string | null;
  loggedIn: boolean;
  lastCheckedAt: string;
}

export class CliService {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  list(): CliRecord[] {
    return this.#store.listClis();
  }

  get(id: string): CliRecord {
    const record = this.#store.getCli(id);
    if (!record) throw new AppError('cli_not_found', 'CLI not found', 404);
    return record;
  }

  getBySlug(slug: string): CliRecord {
    const record = this.#store.getCliBySlug(slug);
    if (!record) throw new AppError('cli_not_found', `CLI "${slug}" not found`, 404);
    return record;
  }

  create(value: unknown): CliRecord {
    const input = createCliInputSchema.parse(value);
    this.#assertCredential(input.credentialId);
    const record = this.#store.createCli(input);
    this.#store.appendEvent({
      level: 'info',
      type: 'cli.created',
      serverId: null,
      message: `Created CLI ${record.slug}`,
      detail: { slug: record.slug, executionMode: record.executionMode },
    });
    return record;
  }

  update(id: string, value: unknown): CliRecord {
    const current = this.get(id);
    const input = updateCliInputSchema.parse(value);
    const nextCredentialId =
      input.credentialId === undefined ? current.credentialId : input.credentialId;
    this.#assertCredential(nextCredentialId);
    const record = this.#store.updateCli(id, input);
    this.#store.appendEvent({
      level: 'info',
      type: 'cli.updated',
      serverId: null,
      message: `Updated CLI ${record.slug}`,
      detail: { slug: record.slug },
    });
    return record;
  }

  delete(id: string): void {
    const current = this.get(id);
    this.#store.deleteCli(id);
    this.#store.appendEvent({
      level: 'info',
      type: 'cli.deleted',
      serverId: null,
      message: `Deleted CLI ${current.slug}`,
      detail: { slug: current.slug },
    });
  }

  /**
   * Validate an exec request before any process is spawned: record lookup,
   * enabled check, argv shape (array only — never a shell string), and the
   * allow-list verdict. Throws a structured AppError for 404/400/403 cases.
   */
  prepareExec(slug: string, body: unknown): { record: CliRecord; input: CliExecInput } {
    const record = this.getBySlug(slug);
    if (!record.enabled) {
      throw new AppError('cli_disabled', `CLI "${slug}" is disabled`, 403);
    }
    const input = cliExecInputSchema.parse(body);
    const verdict = evaluateAllowList(input.argv, record.allowList);
    if (verdict.verdict === 'deny') {
      throw new AppError('cli_denied', `argv denied by allow-list: ${verdict.reason}`, 403);
    }
    return { record, input };
  }

  /** Run a prepared exec, streaming NDJSON frames, and audit it as an event. */
  async runExec(
    record: CliRecord,
    input: CliExecInput,
    emit: (frame: CliExecFrame) => void,
    signal?: AbortSignal,
  ): Promise<ExecOutcome> {
    const outcome = await execCli(
      {
        command: record.command,
        argv: input.argv,
        env: this.#buildEnv(record),
        stdin: input.stdin ?? null,
        timeoutMs: input.timeoutMs ?? record.timeoutMs,
        maxOutputBytes: input.maxOutputBytes ?? record.maxOutputBytes,
        executionMode: record.executionMode,
      },
      emit,
      signal,
    );
    this.#store.appendEvent({
      level: 'info',
      type: 'cli.exec',
      serverId: null,
      message: `${record.slug} ${input.argv.join(' ')}`,
      detail: {
        slug: record.slug,
        argv: input.argv,
        exitCode: outcome.code,
        durationMs: outcome.durationMs,
        result: outcome.result,
        truncated: outcome.truncated,
      },
    });
    return outcome;
  }

  /** Run the CLI's declared probe in the same isolated context and parse it. */
  async status(slug: string): Promise<CliStatus> {
    const record = this.getBySlug(slug);
    const lastCheckedAt = new Date().toISOString();
    if (record.probe === null) {
      return { installed: null, version: null, loggedIn: false, lastCheckedAt };
    }
    let stdout = '';
    const outcome = await execCli(
      {
        command: record.probe.command,
        argv: record.probe.args,
        env: this.#buildEnv(record),
        stdin: null,
        timeoutMs: Math.min(record.timeoutMs, 30_000),
        maxOutputBytes: 64 * 1024,
        executionMode: record.executionMode,
      },
      (frame) => {
        if (frame.type === 'stdout') stdout += frame.data;
      },
    );
    const parsed = parseProbeOutput(stdout);
    return {
      installed: outcome.code === 0,
      version: parsed.version,
      loggedIn: parsed.loggedIn,
      lastCheckedAt,
    };
  }

  #buildEnv(record: CliRecord): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) env[name] = value;
    }
    if (!record.interactive) {
      // interactive records opt out of the non-interactive enforcement vars
      Object.assign(env, cliEnforcementEnv);
    }
    if (record.credentialId !== null) {
      const payload = this.#store.getCredentialPayload(record.credentialId);
      if (payload === null) throw new AppError('credential_not_found', 'Credential not found', 400);
      if (payload.type !== 'env') {
        throw new AppError(
          'cli_credential_kind_mismatch',
          'CLIs only accept environment credentials',
          400,
        );
      }
      Object.assign(env, payload.variables);
    }
    return env;
  }

  #assertCredential(credentialId: string | null): void {
    if (credentialId === null) return;
    const payload = this.#store.getCredentialPayload(credentialId);
    if (!payload) throw new AppError('credential_not_found', 'Credential not found', 400);
    if (payload.type !== 'env') {
      throw new AppError(
        'cli_credential_kind_mismatch',
        'CLIs only accept environment credentials',
        400,
      );
    }
  }
}
