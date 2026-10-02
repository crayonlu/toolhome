import { spawn } from 'node:child_process';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

/** ToolHome's own secrets must not reach a spawned third-party server. */
const RESERVED_ENV_PREFIX = 'TOOLHOME_';

export interface ServerLaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Environment for a locally spawned stdio server. The machine's own environment
 * comes first (a local server needs PATH, HOME and friends), then the server's
 * configured variables, then the values materialized from its credential — the
 * same precedence the server-side adapter uses for home-hosted servers.
 *
 * `TOOLHOME_*` variables are dropped so a server process cannot read the control
 * key that launched it.
 */
export function launchEnvironment(
  configured: Record<string, string>,
  credentialEnv: Record<string, string>,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined || key.startsWith(RESERVED_ENV_PREFIX)) continue;
    inherited[key] = value;
  }
  return {
    ...getDefaultEnvironment(),
    ...inherited,
    ...configured,
    ...credentialEnv,
  };
}

/**
 * Spawn the server with this process's stdio and resolve with its exit code.
 *
 * The pipes are inherited rather than proxied, so the MCP client talks to the
 * child directly and ToolHome stays out of the data path. Nothing may be written
 * to stdout here: it carries the protocol.
 */
export function spawnStdioServer(
  spec: ServerLaunchSpec,
  signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'],
): Promise<number> {
  const child = spawn(spec.command, spec.args, {
    stdio: 'inherit',
    env: spec.env,
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
  });
  for (const signal of signals) {
    process.on(signal, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    });
  }
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal === null ? 0 : 1));
    });
  });
}
