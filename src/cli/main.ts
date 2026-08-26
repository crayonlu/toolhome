#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ControlClient } from '../control/client.js';

function packageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      return (
        JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as { version: string }
      ).version;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return '0.0.0';
      directory = parent;
    }
  }
}

const localConfigSchema = z.object({
  url: z.url().superRefine((value, context) => {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      context.addIssue({
        code: 'custom',
        message: 'ToolHome URL must be an HTTP(S) origin',
      });
    }
  }),
  controlKey: z.string().min(1),
});

interface GlobalOptions {
  url?: string;
  key?: string;
  output: 'human' | 'json';
}

const program = new Command()
  .name('toolhome')
  .description('Complete CLI for the ToolHome Control API')
  .version(packageVersion())
  .option('--url <url>', 'ToolHome base URL')
  .option('--key <key>', 'Control API key')
  .option('--output <format>', 'human or json', parseOutput, 'human');

const server = program.command('server').description('Manage MCP servers');
server.command('list').action(run((client) => client.request('GET', '/api/v1/servers')));
server
  .command('get <id>')
  .action(run((client, id: string) => client.request('GET', `/api/v1/servers/${id}`)));
server
  .command('add <file>')
  .description('Create from a JSON file or - for stdin')
  .action(run((client, file: string) => client.request('POST', '/api/v1/servers', readJson(file))));
server
  .command('update <id> <file>')
  .action(
    run((client, id: string, file: string) =>
      client.request('PATCH', `/api/v1/servers/${id}`, readJson(file)),
    ),
  );
server
  .command('delete <id>')
  .action(run((client, id: string) => client.request('DELETE', `/api/v1/servers/${id}`)));
for (const action of ['test', 'enable', 'disable', 'refresh', 'restart']) {
  server
    .command(`${action} <id>`)
    .action(run((client, id: string) => client.request('POST', `/api/v1/servers/${id}/${action}`)));
}
for (const view of ['capabilities', 'status', 'logs', 'endpoint']) {
  server
    .command(`${view} <id>`)
    .action(run((client, id: string) => client.request('GET', `/api/v1/servers/${id}/${view}`)));
}

const cli = program.command('cli').description('Manage and run CLIs hosted on the ToolHome server');
cli
  .command('list')
  .description('List registered hosted CLIs')
  .action(run((client) => client.request('GET', '/api/v1/clis')));
cli
  .command('get <id>')
  .description('Show a hosted CLI record')
  .action(run((client, id: string) => client.request('GET', `/api/v1/clis/${id}`)));
cli
  .command('add <file>')
  .description('Register a hosted CLI from a JSON file or - for stdin')
  .action(run((client, file: string) => client.request('POST', '/api/v1/clis', readJson(file))));
cli
  .command('update <id> <file>')
  .description('Update a hosted CLI from a JSON file or - for stdin')
  .action(
    run((client, id: string, file: string) =>
      client.request('PATCH', `/api/v1/clis/${id}`, readJson(file)),
    ),
  );
cli
  .command('delete <id>')
  .description('Delete a hosted CLI record')
  .action(run((client, id: string) => client.request('DELETE', `/api/v1/clis/${id}`)));
cli
  .command('enable <id>')
  .description('Enable a hosted CLI')
  .action(
    run((client, id: string) => client.request('PATCH', `/api/v1/clis/${id}`, { enabled: true })),
  );
cli
  .command('disable <id>')
  .description('Disable a hosted CLI')
  .action(
    run((client, id: string) => client.request('PATCH', `/api/v1/clis/${id}`, { enabled: false })),
  );
cli
  .command('status <slug>')
  .description('Probe a hosted CLI (installed/version/loggedIn)')
  .action(run((client, slug: string) => client.request('GET', `/cli/${slug}/status`)));
cli
  .command('exec <slug> [args...]')
  .description('Run a hosted CLI; args are passed verbatim as argv (never through a shell)')
  .option('--stdin <text>', 'feed text to the remote process stdin')
  .option('--stdin-file <path>', 'feed a file (or - for this terminal) to remote stdin')
  .option(
    '--timeout <ms>',
    'kill the remote process after this many milliseconds',
    parsePositiveInt,
  )
  .option('--max-output-bytes <bytes>', 'cap output for this invocation', parsePositiveInt)
  .action(
    run(
      async (
        client,
        slug: string,
        args: string[],
        options: {
          stdin?: string;
          stdinFile?: string;
          timeout?: number;
          maxOutputBytes?: number;
        },
      ) => {
        if (args.length === 0) throw new Error('At least one argv token is required');
        if (options.stdin !== undefined && options.stdinFile !== undefined) {
          throw new Error('--stdin and --stdin-file are mutually exclusive');
        }
        let stdin: string | null | undefined;
        if (options.stdin !== undefined) {
          stdin = options.stdin;
        } else if (options.stdinFile === '-') {
          stdin = readFileSync(0, 'utf8');
        } else if (options.stdinFile !== undefined) {
          stdin = readFileSync(resolve(options.stdinFile), 'utf8');
        }

        const output = program.opts<GlobalOptions>().output;
        const abort = new AbortController();
        const onSignal = (): void => abort.abort();
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
        let outcome;
        try {
          outcome = await client.execStream(
            slug,
            {
              argv: args,
              stdin,
              ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
              ...(options.maxOutputBytes === undefined
                ? {}
                : { maxOutputBytes: options.maxOutputBytes }),
            },
            (frame) => {
              if (output === 'json') {
                print(frame, 'json');
              } else if (frame.type === 'stdout') {
                process.stdout.write(frame.data);
              } else if (frame.type === 'stderr') {
                process.stderr.write(frame.data);
              }
            },
            abort.signal,
          );
        } finally {
          process.removeListener('SIGINT', onSignal);
          process.removeListener('SIGTERM', onSignal);
        }
        if (output === 'json') {
          print(outcome, 'json');
        } else {
          if (outcome.result === 'timeout') {
            process.stderr.write(`\ntimed out after ${outcome.durationMs}ms\n`);
          }
          if (outcome.truncated) {
            process.stderr.write('\noutput truncated by the configured limit\n');
          }
        }
        process.exitCode = outcome.result === 'ok' ? 0 : 1;
      },
    ),
  );

const credential = program
  .command('credential')
  .description('Manage encrypted upstream credentials');
credential.command('list').action(run((client) => client.request('GET', '/api/v1/credentials')));
credential
  .command('get <id>')
  .action(run((client, id: string) => client.request('GET', `/api/v1/credentials/${id}`)));
credential
  .command('add <file>')
  .action(
    run((client, file: string) => client.request('POST', '/api/v1/credentials', readJson(file))),
  );
credential
  .command('update <id> <file>')
  .action(
    run((client, id: string, file: string) =>
      client.request('PATCH', `/api/v1/credentials/${id}`, readJson(file)),
    ),
  );
credential
  .command('delete <id>')
  .action(run((client, id: string) => client.request('DELETE', `/api/v1/credentials/${id}`)));
for (const action of ['test', 'revoke']) {
  credential
    .command(`${action} <id>`)
    .action(
      run((client, id: string) => client.request('POST', `/api/v1/credentials/${id}/${action}`)),
    );
}
credential
  .command('authorize <name>')
  .description('Authorize an OAuth credential by name, open the browser, and wait for the result')
  .option('--server <name>', 'associated remote MCP server (slug or name)')
  .option('--force', 'force a new authorization grant')
  .option('--no-open', 'do not open the browser automatically')
  .option('--no-wait', 'print the authorization URL and exit without waiting')
  .option('--timeout <seconds>', 'how long to wait for authorization', parsePositiveInt, 600)
  .action(
    run(async (client, name: string, options: AuthorizeOptions) => {
      const credentials = (await client.request(
        'GET',
        '/api/v1/credentials',
      )) as CredentialSummary[];
      const credential = resolveCredential(credentials, name);
      const servers = (await client.request('GET', '/api/v1/servers')) as ServerSummary[];
      const bound = servers.filter((server) => server.credentialId === credential.id);
      let serverId: string | undefined;
      if (options.server) {
        const server = resolveServer(servers, options.server);
        if (server.credentialId !== credential.id) {
          throw new Error(`Server "${options.server}" is not attached to credential "${name}"`);
        }
        serverId = server.id;
      } else if (bound.length === 1 && bound[0] !== undefined) {
        serverId = bound[0].id;
      } else if (bound.length === 0) {
        throw new Error(`Credential "${name}" is not attached to any server; pass --server`);
      } else {
        throw new Error(
          `Credential "${name}" is attached to ${bound.length} servers; pass --server to disambiguate`,
        );
      }

      const result = (await client.request(
        'POST',
        `/api/v1/credentials/${credential.id}/authorize`,
        {
          serverId,
          force: options.force ?? false,
        },
      )) as { status: string; authorizationUrl?: string };

      if (program.opts<GlobalOptions>().output === 'json') {
        print(result, program.opts<GlobalOptions>().output);
      }

      if (result.status === 'authorized') {
        process.stdout.write(`✓ "${credential.name}" is already authorized.\n`);
        return;
      }

      const authorizationUrl = result.authorizationUrl;
      if (!authorizationUrl) {
        throw new Error(`Authorization did not return a URL (status "${result.status}")`);
      }

      if (options.open) {
        process.stdout.write(`Opening browser for "${credential.name}"...\n`);
        openUrl(authorizationUrl);
        process.stdout.write(`If the browser did not open, visit:\n  ${authorizationUrl}\n`);
      } else {
        process.stdout.write(
          `Visit this URL to authorize "${credential.name}":\n  ${authorizationUrl}\n`,
        );
      }

      if (!options.wait) return;

      const timeoutSeconds = options.timeout ?? 600;
      process.stdout.write(
        `Waiting for authorization to complete (up to ${timeoutSeconds}s). Press Ctrl+C to cancel...\n`,
      );
      const deadline = Date.now() + timeoutSeconds * 1_000;
      for (;;) {
        await sleep(2_000);
        if (Date.now() > deadline) {
          process.stdout.write(
            `✗ Timed out after ${timeoutSeconds}s with no authorization.\n` +
              `If you haven't finished yet, open the URL above or re-run this command.\n`,
          );
          process.exitCode = 1;
          return;
        }
        const current = (await client.request(
          'GET',
          `/api/v1/credentials/${credential.id}`,
        )) as CredentialSummary;
        if (current.status !== 'pending') {
          if (current.status === 'ready') {
            process.stdout.write(`✓ "${credential.name}" authorized successfully.\n`);
          } else {
            process.stdout.write(`✗ Authorization ended with status "${current.status}".\n`);
            process.exitCode = 1;
          }
          return;
        }
      }
    }),
  );

mountKeyCommands(program, 'control-key', 'control-keys');
mountKeyCommands(program, 'access-key', 'access-keys');

program
  .command('capability <server-id>')
  .description('Show a server capability snapshot')
  .action(run((client, id: string) => client.request('GET', `/api/v1/servers/${id}/capabilities`)));

const config = program.command('config').description('Import and export configuration');
config
  .command('export [file]')
  .option('--include-secrets', 'include plaintext credential secrets for a restorable backup')
  .action(
    run(async (client, file: string | undefined, command: Command) => {
      const includeSecrets = command.opts<{ includeSecrets?: boolean }>().includeSecrets ?? false;
      if (includeSecrets && !file) {
        throw new Error('--include-secrets requires a destination file');
      }
      const value = await client.request(
        'GET',
        `/api/v1/config/export?includeSecrets=${includeSecrets ? 'true' : 'false'}`,
      );
      if (file) {
        const destination = resolve(file);
        writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        chmodSync(destination, 0o600);
        return { written: destination, secretsIncluded: includeSecrets };
      }
      return value;
    }),
  );
config
  .command('import <file>')
  .action(
    run((client, file: string) => client.request('POST', '/api/v1/config/import', readJson(file))),
  );
config
  .command('import-harness <file>')
  .description(
    'Import a harness mcpServers config (Claude Desktop / Cursor JSON); secrets become encrypted credentials',
  )
  .option('--preview', 'show what would be imported without writing anything')
  .option('--upsert', 'update existing servers (transport/env) instead of reporting conflicts')
  .action(
    run((client, file: string, command: Command) => {
      const options = command.opts<{ preview?: boolean; upsert?: boolean }>();
      return client.request('POST', '/api/v1/config/import-harness', {
        config: readJson(file),
        preview: options.preview ?? false,
        ...(options.upsert ? { mode: 'upsert' } : {}),
      });
    }),
  );

const endpoint = program.command('endpoint').description('Print standard MCP endpoints');
endpoint
  .command('aggregate')
  .action(run((client) => client.request('GET', '/api/v1/endpoints/aggregate')));
endpoint
  .command('server <id>')
  .action(run((client, id: string) => client.request('GET', `/api/v1/servers/${id}/endpoint`)));

const market = program
  .command('market')
  .description('Browse and install MCP servers from the catalog');
market
  .command('list')
  .description('List catalog entries with install status')
  .action(run((client) => client.request('GET', '/api/v1/market')));
market
  .command('install <id>')
  .description('Install a catalog entry (fill required values with --set KEY=value)')
  .option('--set <value>', 'set a value as KEY=value (repeatable)', collectValues, {})
  .action(
    run(async (client, id: string, options: { set: Record<string, string> }) => {
      const started = (await client.request('POST', `/api/v1/market/${id}/install`, {
        values: options.set,
      })) as { jobId: string; status: string; actionUrl?: string };
      if (started.status === 'awaiting_secret' && started.actionUrl) {
        process.stdout.write(
          `This entry needs a secret. Open this one-time URL in your browser to continue:\n${started.actionUrl}\n`,
        );
      }
      for (;;) {
        const job = (await client.request('GET', `/api/v1/market/install/${started.jobId}`)) as {
          status: string;
          step: string;
          result?: unknown;
          error?: string;
        };
        if (job.status !== 'installing') {
          if (job.status === 'failed') throw new Error(job.error ?? 'Install failed');
          if (job.status === 'awaiting_secret') {
            process.stdout.write('\rwaiting for secret in browser…   ');
          } else {
            return job.result;
          }
        }
        process.stdout.write(`\rinstalling: ${job.step}…   `);
        await sleep(1500);
      }
    }),
  );
market
  .command('uninstall <id>')
  .description('Remove an installed catalog entry (server + credential)')
  .action(run((client, id: string) => client.request('POST', `/api/v1/market/${id}/uninstall`)));
market
  .command('updates')
  .description('Compare installed versions against catalog pins and upstream')
  .action(run((client) => client.request('GET', '/api/v1/market/updates')));
market
  .command('update <id>')
  .description('Update an installed entry to the catalog pin (keeps credential, restarts server)')
  .action(
    run(async (client, id: string) => {
      const started = (await client.request('POST', `/api/v1/market/${id}/update`)) as {
        jobId: string | null;
        status: string;
      };
      if (started.status === 'up_to_date' || started.jobId === null) return started;
      for (;;) {
        const job = (await client.request('GET', `/api/v1/market/install/${started.jobId}`)) as {
          status: string;
          step: string;
          result?: unknown;
          error?: string;
        };
        if (job.status !== 'updating') {
          if (job.status === 'failed') throw new Error(job.error ?? 'Update failed');
          return job.result ?? job;
        }
        process.stdout.write(`\rupdating: ${job.step}…   `);
        await sleep(1500);
      }
    }),
  );

program.command('status').action(run((client) => client.request('GET', '/api/v1/overview')));
program.command('doctor').action(run((client) => client.request('GET', '/api/v1/diagnostics')));
program
  .command('events')
  .option('--limit <count>', 'maximum records', '100')
  .action(
    run((client, command: Command) =>
      client.request('GET', `/api/v1/events?limit=${encodeURIComponent(command.opts().limit)}`),
    ),
  );

const calls = program.command('calls').description('Inspect tool call records (metadata only)');
calls
  .command('list')
  .description('List recent tool calls')
  .option('--limit <count>', 'maximum records', '50')
  .option('--server <id>', 'filter by server id')
  .option('--tool <name>', 'filter by upstream tool name')
  .option('--endpoint <type>', 'filter by endpoint (aggregate|individual)')
  .option('--status <status>', 'filter by status')
  .action(
    run((client, command: Command) => {
      const query = new URLSearchParams();
      const options = command.opts();
      query.set('limit', String(options.limit));
      if (options.server) query.set('server_id', options.server);
      if (options.tool) query.set('tool', options.tool);
      if (options.endpoint) query.set('endpoint_type', options.endpoint);
      if (options.status) query.set('status', options.status);
      return client.request('GET', `/api/v1/calls?${query}`);
    }),
  );
calls
  .command('stats')
  .description('Show aggregate tool call statistics')
  .option('--server <id>', 'filter by server id')
  .option('--tool <name>', 'filter by upstream tool name')
  .option('--from <iso>', 'start time (ISO-8601)')
  .option('--to <iso>', 'end time (ISO-8601)')
  .action(
    run((client, command: Command) => {
      const query = new URLSearchParams();
      const options = command.opts();
      if (options.server) query.set('server_id', options.server);
      if (options.tool) query.set('tool', options.tool);
      if (options.from) query.set('from', options.from);
      if (options.to) query.set('to', options.to);
      return client.request('GET', `/api/v1/calls/stats?${query}`);
    }),
  );

program
  .command('api <method> <path>')
  .description('Call any Control API operation')
  .option('--body <file>', 'JSON body file or - for stdin')
  .action(
    run((client, method: string, path: string, command: Command) =>
      client.request(
        method.toUpperCase(),
        path,
        command.opts().body ? readJson(command.opts().body) : undefined,
      ),
    ),
  );

const auth = program.command('auth').description('Manage local CLI connection settings');
auth
  .command('login')
  .requiredOption('--url <url>')
  .requiredOption('--control-key <key>')
  .action((options: { url: string; controlKey: string }) => {
    const value = localConfigSchema.parse({ url: options.url, controlKey: options.controlKey });
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    process.stdout.write(`Saved ${path}\n`);
  });
auth.command('logout').action(() => {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, '{}\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  process.stdout.write(`Cleared ${path}\n`);
});

await program.parseAsync(process.argv);

function mountKeyCommands(root: Command, name: string, path: string): void {
  const command = root.command(name);
  command.command('list').action(run((client) => client.request('GET', `/api/v1/${path}`)));
  command
    .command('create <name>')
    .action(
      run((client, keyName: string) =>
        client.request('POST', `/api/v1/${path}`, { name: keyName }),
      ),
    );
  command
    .command('revoke <id>')
    .action(run((client, id: string) => client.request('DELETE', `/api/v1/${path}/${id}`)));
}

function run<TArgs extends unknown[]>(
  action: (client: ControlClient, ...args: TArgs) => unknown | Promise<unknown>,
) {
  return async (...args: TArgs): Promise<void> => {
    try {
      const options = program.opts<GlobalOptions>();
      const connection = resolveConnection(options);
      const value = await action(
        new ControlClient(new URL(connection.url), connection.controlKey),
        ...args,
      );
      if (value !== undefined) print(value, options.output);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  };
}

function resolveConnection(options: GlobalOptions): z.infer<typeof localConfigSchema> {
  const stored = loadLocalConfig();
  return localConfigSchema.parse({
    url: options.url ?? process.env.TOOLHOME_URL ?? stored?.url,
    controlKey: options.key ?? process.env.TOOLHOME_CONTROL_KEY ?? stored?.controlKey,
  });
}

function loadLocalConfig(): z.infer<typeof localConfigSchema> | null {
  try {
    return localConfigSchema.parse(JSON.parse(readFileSync(configPath(), 'utf8')));
  } catch {
    // 0.4.0 moved the default location from ~/.config/mcp-home to ~/.config/toolhome;
    // read a pre-existing legacy config so saved logins survive the rename.
    if (process.env.TOOLHOME_CONFIG) return null;
    try {
      return localConfigSchema.parse(
        JSON.parse(readFileSync(resolve(homedir(), '.config', 'mcp-home', 'config.json'), 'utf8')),
      );
    } catch {
      return null;
    }
  }
}

function configPath(): string {
  return process.env.TOOLHOME_CONFIG ?? resolve(homedir(), '.config', 'toolhome', 'config.json');
}

function readJson(path: string): unknown {
  const text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(path), 'utf8');
  return JSON.parse(text);
}

function print(value: unknown, output: 'human' | 'json'): void {
  process.stdout.write(`${JSON.stringify(value, null, output === 'json' ? 0 : 2)}\n`);
}

function parseOutput(value: string): 'human' | 'json' {
  return z.enum(['human', 'json']).parse(value);
}

interface AuthorizeOptions {
  server?: string;
  force?: boolean;
  open?: boolean;
  wait?: boolean;
  timeout?: number;
}

interface CredentialSummary {
  id: string;
  name: string;
  type: string;
  status: string;
}

interface ServerSummary {
  id: string;
  slug: string;
  name: string;
  credentialId: string | null;
}

function resolveCredential(credentials: CredentialSummary[], value: string): CredentialSummary {
  const byId = credentials.find((credential) => credential.id === value);
  if (byId) return byId;
  const exact = credentials.filter((credential) => credential.name === value);
  if (exact.length === 1 && exact[0] !== undefined) return exact[0];
  const loose = credentials.filter(
    (credential) => credential.name.toLowerCase() === value.toLowerCase(),
  );
  if (loose.length === 1 && loose[0] !== undefined) return loose[0];
  if (exact.length > 1) {
    throw new Error(
      `Multiple credentials named "${value}"; use a unique name or the credential id`,
    );
  }
  const names = credentials.map((credential) => credential.name).join(', ');
  throw new Error(`Credential "${value}" not found. Available credentials: ${names || '(none)'}`);
}

function resolveServer(servers: ServerSummary[], value: string): ServerSummary {
  const bySlug = servers.find((server) => server.slug === value);
  if (bySlug) return bySlug;
  const byId = servers.find((server) => server.id === value);
  if (byId) return byId;
  const byName = servers.filter((server) => server.name === value);
  if (byName.length === 1 && byName[0] !== undefined) return byName[0];
  if (byName.length > 1) {
    throw new Error(`Multiple servers named "${value}"; use a unique slug or the server id`);
  }
  const names = servers.map((server) => `${server.slug} (${server.name})`).join(', ');
  throw new Error(`Server "${value}" not found. Available servers: ${names || '(none)'}`);
}

function openUrl(url: string): void {
  const { platform } = process;
  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    process.stdout.write(`Could not open the browser automatically. Visit:\n  ${url}\n`);
  });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got "${value}"`);
  }
  return parsed;
}

function collectValues(value: string, previous: Record<string, string>): Record<string, string> {
  const index = value.indexOf('=');
  if (index <= 0) {
    throw new Error(`Expected KEY=value, got "${value}"`);
  }
  return { ...previous, [value.slice(0, index)]: value.slice(index + 1) };
}
