import { z } from 'zod';

/**
 * Hand a locally authenticated platform CLI over to a ToolHome instance.
 *
 * A hosted CLI's login state belongs to the product, not to ToolHome: `gh` keeps
 * its token in the macOS keychain, `az` in a token cache, others in a container
 * volume on the target. Each catalog entry therefore declares how its state
 * moves, and this walks that declaration once per entry. The extracted secret is
 * written to the target's stdin and never printed, logged or returned.
 */

export interface ControlApi {
  request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown>;
  execStream(
    slug: string,
    input: { argv: string[]; stdin?: string | null; timeoutMs?: number },
    onFrame: (frame: { type: string; data?: string }) => void,
    signal?: AbortSignal,
  ): Promise<{ code: number | null; result: string }>;
}

export interface LocalCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type LocalRunner = (command: string, args: string[]) => Promise<LocalCommandResult>;

export interface AdoptOutcome {
  slug: string;
  status: 'adopted' | 'already-authenticated' | 'credential-only' | 'manual' | 'undeclared' | 'failed';
  detail?: string;
}

export interface AdoptOptions {
  slugs?: string[];
  dryRun?: boolean;
  force?: boolean;
  runLocal?: LocalRunner;
  log?: (line: string) => void;
}

const localStateSchema = z
  .object({
    extract: z.object({ command: z.string(), args: z.array(z.string()) }).optional(),
    import: z.object({ args: z.array(z.string()) }).optional(),
    verify: z.object({ args: z.array(z.string()), expect: z.string() }).optional(),
    target: z.string().optional(),
    credentialOnly: z.boolean().optional(),
    manual: z.string().optional(),
  })
  .passthrough();

const entrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    plane: z.enum(['mcp', 'cli']),
    installed: z.boolean().default(false),
    localState: localStateSchema.optional(),
  })
  .passthrough();

const statusSchema = z.object({ loggedIn: z.boolean() }).passthrough();

export async function adoptCliCredentials(
  target: ControlApi,
  options: AdoptOptions = {},
): Promise<AdoptOutcome[]> {
  const runLocal = options.runLocal ?? defaultRunner;
  const log = options.log ?? ((): void => {});
  const catalog = z
    .array(entrySchema)
    .parse(await target.request('GET', '/api/v1/market'))
    .filter((entry) => entry.plane === 'cli' && entry.installed);
  const wanted =
    options.slugs === undefined ? catalog : catalog.filter((entry) => options.slugs!.includes(entry.id));
  const outcomes: AdoptOutcome[] = [];

  for (const entry of wanted) {
    const state = entry.localState;
    if (state === undefined) {
      outcomes.push({
        slug: entry.id,
        status: 'undeclared',
        detail: 'this catalog entry declares no local-state policy',
      });
      continue;
    }
    if (state.manual !== undefined) {
      outcomes.push({ slug: entry.id, status: 'manual', detail: state.manual });
      continue;
    }
    if (state.credentialOnly === true || state.extract === undefined || state.import === undefined) {
      outcomes.push({
        slug: entry.id,
        status: 'credential-only',
        detail: 'authenticates from credential values, which already travel with the configuration',
      });
      continue;
    }

    if (!options.force && (await authenticationState(target, entry.id, state.verify)) === 'yes') {
      outcomes.push({ slug: entry.id, status: 'already-authenticated' });
      continue;
    }
    if (options.dryRun === true) {
      outcomes.push({
        slug: entry.id,
        status: 'adopted',
        detail: `would run \`${state.extract.command} ${state.extract.args.join(' ')}\` and send the result to ${state.target ?? entry.id}`,
      });
      continue;
    }

    let secret: string;
    try {
      const extracted = await runLocal(state.extract.command, state.extract.args);
      if (extracted.code !== 0 || extracted.stdout.trim() === '') {
        outcomes.push({
          slug: entry.id,
          status: 'failed',
          detail:
            extracted.stderr.trim() !== ''
              ? `local extraction failed: ${extracted.stderr.trim().split('\n')[0]}`
              : `local extraction returned nothing (exit ${String(extracted.code)})`,
        });
        continue;
      }
      secret = extracted.stdout.trim();
    } catch (error) {
      outcomes.push({
        slug: entry.id,
        status: 'failed',
        detail: `local extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    let stderr = '';
    try {
      await target.execStream(
        entry.id,
        { argv: state.import.args, stdin: `${secret}\n` },
        (frame) => {
          if (frame.type === 'stderr' && frame.data !== undefined) stderr += frame.data;
        },
      );
    } catch (error) {
      outcomes.push({
        slug: entry.id,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const confirmed = await authenticationState(target, entry.id, state.verify);
    if (confirmed === 'no') {
      outcomes.push({
        slug: entry.id,
        status: 'failed',
        detail:
          stderr.trim() !== ''
            ? `the target rejected the credential: ${stderr.trim().split('\n')[0]}`
            : 'the target still reports no login state',
      });
      continue;
    }
    log(`${entry.id}: credential accepted`);
    outcomes.push({
      slug: entry.id,
      status: 'adopted',
      detail:
        confirmed === 'unknown'
          ? 'handed over, but this entry reports no login state to confirm it'
          : state.verify === undefined
            ? 'reported by the status probe'
            : `verified with \`${state.verify.args.join(' ')}\``,
    });
  }
  return outcomes;
}

/**
 * Ask the target whether the credential works: yes, no, or it cannot say.
 *
 * A `status` probe answers `loggedIn` only when the product prints that marker,
 * and most platform CLIs do not (`gh --version` says nothing about login), so an
 * entry can declare a `verify` command instead. A probe that reports no markers
 * is inconclusive — never evidence of failure, and never a reason to skip an
 * upload that is still needed.
 */
async function authenticationState(
  target: ControlApi,
  slug: string,
  verify: { args: string[]; expect: string } | undefined,
): Promise<'yes' | 'no' | 'unknown'> {
  if (verify !== undefined) {
    let stdout = '';
    await target.execStream(
      slug,
      { argv: verify.args },
      (frame) => {
        if (frame.type === 'stdout' && frame.data !== undefined) stdout += frame.data;
      },
    );
    return stdout.includes(verify.expect) ? 'yes' : 'no';
  }
  const status = statusSchema.parse(await target.request('GET', `/cli/${slug}/status`));
  if (status.loggedIn) return 'yes';
  return status.installed === true && status.version === null ? 'unknown' : 'no';
}

const defaultRunner: LocalRunner = async (command, args) => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
};
