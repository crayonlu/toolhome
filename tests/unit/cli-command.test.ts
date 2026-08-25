import { describe, expect, it } from 'vitest';
import { parseArgs } from 'node:util';

/**
 * Keep the command-line contract explicit in a small parser-level test. The
 * production command uses Commander, but these cases document the argv rule:
 * tokens after `--` belong to the hosted CLI, not ToolHome.
 */
describe('hosted CLI command contract', () => {
  it('preserves CLI flags after the separator as argv tokens', () => {
    const parsed = parseArgs({
      args: ['cli', 'exec', 'az', '--', 'account', 'show', '--subscription', 'sub-1'],
      options: {},
      allowPositionals: true,
      strict: false,
    });
    expect(parsed.positionals).toEqual([
      'cli',
      'exec',
      'az',
      'account',
      'show',
      '--subscription',
      'sub-1',
    ]);
  });

  it('does not turn a shell string into a hosted argv value', () => {
    const parsed = parseArgs({
      args: ['cli', 'exec', 'host-shell', '--', '-c', 'echo $HOME'],
      options: {},
      allowPositionals: true,
      strict: false,
    });
    expect(parsed.positionals.slice(3)).toEqual(['-c', 'echo $HOME']);
    expect(parsed.positionals.slice(3)).not.toEqual(['-c echo $HOME']);
  });
});
