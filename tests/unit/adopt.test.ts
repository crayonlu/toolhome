import { describe, expect, it } from 'vitest';
import { adoptCliCredentials, type ControlApi } from '../../src/cli/adopt.js';
import { marketCatalog } from '../../src/market/catalog.js';

interface ExecCall {
  slug: string;
  argv: string[];
  stdin: string | null;
}

function stubApi(options: {
  entries: unknown[];
  loggedIn?: boolean;
  exec?: (call: ExecCall) => { code: number | null; stderr?: string };
}): ControlApi & { execCalls: ExecCall[] } {
  const execCalls: ExecCall[] = [];
  let loggedIn = options.loggedIn ?? false;
  return {
    execCalls,
    async request(_method: string, path: string): Promise<unknown> {
      if (path === '/api/v1/market') return options.entries;
      if (path.endsWith('/status')) return { loggedIn };
      throw new Error(`unexpected call ${path}`);
    },
    async execStream(slug, input, onFrame): Promise<{ code: number | null; result: string }> {
      const call = { slug, argv: input.argv, stdin: input.stdin ?? null };
      execCalls.push(call);
      const outcome = options.exec?.(call) ?? { code: 0 };
      if (outcome.stderr !== undefined) onFrame({ type: 'stderr', data: outcome.stderr });
      if (outcome.code === 0) loggedIn = true;
      return { code: outcome.code, result: outcome.code === 0 ? 'ok' : 'error' };
    },
  };
}

const ghEntry = {
  id: 'gh-cli',
  name: 'GitHub CLI (gh)',
  plane: 'cli',
  installed: true,
  localState: {
    extract: { command: 'gh', args: ['auth', 'token'] },
    import: { args: ['auth', 'login', '--with-token'] },
    target: 'toolhome-gh-cli-state:/root/.config/gh',
  },
};

describe('adopting local CLI logins', () => {
  it('feeds the extracted token to the target and never returns it', async () => {
    const api = stubApi({
      entries: [
        ghEntry,
        {
          id: 'azure-cli',
          name: 'Azure CLI (az)',
          plane: 'cli',
          installed: true,
          localState: { credentialOnly: true },
        },
        {
          id: 'lark-cli',
          name: 'Lark CLI',
          plane: 'cli',
          installed: true,
          localState: { manual: 'run `toolhome cli exec lark-cli -- auth login` on the target' },
        },
      ],
    });
    const outcomes = await adoptCliCredentials(api, {
      runLocal: async (command, args) => ({
        code: 0,
        stdout: `${command} ${args.join(' ')}-value\n`,
        stderr: '',
      }),
    });

    expect(api.execCalls).toEqual([
      { slug: 'gh-cli', argv: ['auth', 'login', '--with-token'], stdin: 'gh auth token-value\n' },
    ]);
    expect(outcomes).toEqual([
      { slug: 'gh-cli', status: 'adopted', detail: 'state kept in toolhome-gh-cli-state:/root/.config/gh' },
      {
        slug: 'azure-cli',
        status: 'credential-only',
        detail: 'authenticates from credential values, which already travel with the configuration',
      },
      {
        slug: 'lark-cli',
        status: 'manual',
        detail: 'run `toolhome cli exec lark-cli -- auth login` on the target',
      },
    ]);
    // The secret travels, but it is not reported back to the caller.
    expect(JSON.stringify(outcomes)).not.toContain('auth token-value');
  });

  it('skips a CLI the instance already has a login for unless forced', async () => {
    const api = stubApi({ entries: [ghEntry], loggedIn: true });
    expect(await adoptCliCredentials(api, { runLocal: async () => ({ code: 0, stdout: 'x', stderr: '' }) })).toEqual([
      { slug: 'gh-cli', status: 'already-authenticated' },
    ]);
    expect(api.execCalls).toHaveLength(0);

    const forced = stubApi({ entries: [ghEntry], loggedIn: true });
    const outcomes = await adoptCliCredentials(forced, {
      force: true,
      runLocal: async () => ({ code: 0, stdout: 'token\n', stderr: '' }),
    });
    expect(outcomes[0]?.status).toBe('adopted');
  });

  it('reports a missing local login and a rejected credential instead of guessing', async () => {
    const missing = stubApi({ entries: [ghEntry] });
    expect(
      await adoptCliCredentials(missing, {
        runLocal: async () => ({ code: 1, stdout: '', stderr: 'gh: not logged in' }),
      }),
    ).toEqual([
      {
        slug: 'gh-cli',
        status: 'failed',
        detail: 'local extraction failed: gh: not logged in',
      },
    ]);

    const rejected = stubApi({
      entries: [ghEntry],
      exec: () => ({ code: 1, stderr: 'error: invalid token' }),
    });
    expect(
      await adoptCliCredentials(rejected, {
        runLocal: async () => ({ code: 0, stdout: 'stale-token\n', stderr: '' }),
      }),
    ).toEqual([
      {
        slug: 'gh-cli',
        status: 'failed',
        detail: 'the target rejected the credential: error: invalid token',
      },
    ]);
  });

  it('walks only what was asked for', async () => {
    const api = stubApi({
      entries: [
        ghEntry,
        { id: 'vercel-cli', name: 'Vercel', plane: 'cli', installed: true, localState: { credentialOnly: true } },
      ],
    });
    const outcomes = await adoptCliCredentials(api, {
      slugs: ['vercel-cli'],
      runLocal: async () => ({ code: 0, stdout: 'x\n', stderr: '' }),
    });
    expect(outcomes.map((outcome) => outcome.slug)).toEqual(['vercel-cli']);
  });

  it('plans without handing anything over on a dry run', async () => {
    const api = stubApi({ entries: [ghEntry] });
    const outcomes = await adoptCliCredentials(api, { dryRun: true });
    expect(outcomes[0]).toMatchObject({ slug: 'gh-cli', status: 'adopted' });
    expect(outcomes[0]?.detail).toContain('would run');
    expect(api.execCalls).toHaveLength(0);
  });
});

describe('catalog local-state policy', () => {
  it('declares how every hosted CLI moves its login state', () => {
    const cliEntries = marketCatalog.filter((entry) => entry.plane === 'cli');
    expect(cliEntries.length).toBeGreaterThan(0);
    for (const entry of cliEntries) {
      expect(entry.localState, `${entry.id} declares no localState`).toBeDefined();
      const state = entry.localState!;
      const declared =
        state.credentialOnly === true ||
        state.manual !== undefined ||
        (state.extract !== undefined && state.import !== undefined);
      expect(declared, `${entry.id} declares an unusable localState`).toBe(true);
    }
  });

  it('gives gh a hand-off whose import argv passes its own allow list', () => {
    const gh = marketCatalog.find((entry) => entry.id === 'gh-cli');
    expect(gh?.localState?.import?.args).toEqual(['auth', 'login', '--with-token']);
    const allow = gh?.allowList?.allow ?? [];
    const argv = gh!.localState!.import!.args;
    expect(
      allow.some((rule) => rule.length <= argv.length && rule.every((token, index) => token === '*' || token === argv[index])),
    ).toBe(true);
  });
});
