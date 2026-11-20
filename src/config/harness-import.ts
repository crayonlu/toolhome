import { basename } from 'node:path';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { nodeIdSchema, type CredentialPayload, type TransportConfig } from '../domain/models.js';
import { marketCatalog } from '../market/catalog.js';

/**
 * Translates a harness MCP config (Claude Desktop / Cursor `mcpServers` JSON,
 * Grok / Codex `[mcp_servers.*]` TOML) into ToolHome servers + credentials.
 *
 * Parsing rules:
 * - `url` (+ `headers`)      -> remote streamable-http; `Authorization: Bearer X`
 *   becomes a bearer credential, other headers become a headers credential.
 * - `command` + `args` + `env` -> stdio server, placed on `home` or on a `node`
 *   when the caller names one; env keys whose names look secret
 *   (password/token/secret/key/authorization) go into an encrypted env
 *   credential, everything else into `transport.env`.
 * - npx/uvx/bunx stdio entries that match a curated Market package are flagged
 *   with a suggestion to install via the Market instead.
 * - Entries that already reach ToolHome (a `toolhome mcp stdio` launcher, an
 *   `mcp launch` launcher, or a remote URL carrying a ToolHome Access Key) are
 *   not servers to import: importing them would wrap the gateway in itself.
 *   They come back as `gateways` so the caller can rewrite them instead.
 */

const harnessServerSchema = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  // Harnesses write these too; the importer reads `enabled` to warn, and
  // ignores the rest rather than rejecting a file it half understands.
  enabled: z.boolean().optional(),
  type: z.string().optional(),
  transport: z.string().optional(),
});

export const harnessConfigSchema = z.object({
  mcpServers: z.record(z.string(), harnessServerSchema),
});
export type HarnessConfig = z.infer<typeof harnessConfigSchema>;

const SECRET_KEY_RE = /password|token|secret|key|authorization/i;
const PACKAGE_RUNNERS = new Set(['npx', 'npm', 'bunx', 'uvx', 'pnpm', 'yarn']);

export interface HarnessImportedCredential {
  name: string;
  payload: CredentialPayload;
}

export interface HarnessImportedEntry {
  name: string;
  slug: string;
  kind: 'remote' | 'home' | 'node';
  nodeId: string | null;
  transport: TransportConfig;
  credential: HarnessImportedCredential | null;
  warnings: string[];
}

/** An entry that already reaches ToolHome: import it and the gateway wraps itself. */
export interface HarnessGatewayEntry {
  name: string;
  slug: string;
  /** `stdio` = `toolhome mcp stdio`, `launch` = `toolhome mcp launch <slug>`, `remote` = an HTTP endpoint. */
  via: 'stdio' | 'launch' | 'remote';
  /** For `launch`, the server slug it runs; for `remote`, the URL. */
  target: string | null;
  /** The entry points at the instance being imported into; never importable. */
  self: boolean;
  message: string;
}

export interface HarnessParseResult {
  entries: HarnessImportedEntry[];
  gateways: HarnessGatewayEntry[];
}

export interface HarnessImportOptions {
  /** Place every stdio entry on this node label instead of the ToolHome host. */
  nodeId?: string | null;
  /** The instance being imported into; a remote entry pointing at it is the gateway itself. */
  targetUrl?: string | null;
  /**
   * Import another ToolHome instance's endpoint as a server (a deliberate
   * proxy). Stdio launchers and this instance's own endpoint are never imported.
   */
  includeGateways?: boolean;
}

export interface HarnessImportPreview {
  name: string;
  slug: string;
  kind: 'remote' | 'home' | 'node';
  nodeId: string | null;
  transportSummary: string;
  credential: { name: string; type: string; fields: { name: string; masked: boolean }[] } | null;
  warnings: string[];
}

export function toSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'mcp';
}

export function parseHarnessConfig(
  value: unknown,
  options: HarnessImportOptions = {},
): HarnessImportedEntry[] {
  return parseHarnessConfigDetailed(value, options).entries;
}

/**
 * Parse with the gateway entries kept aside, so a caller can report "this entry
 * already is ToolHome" instead of creating a server that calls back into the
 * instance.
 */
export function parseHarnessConfigDetailed(
  value: unknown,
  options: HarnessImportOptions = {},
): HarnessParseResult {
  const config = harnessConfigSchema.parse(value);
  const nodeId = options.nodeId ?? null;
  if (nodeId !== null) nodeIdSchema.parse(nodeId);
  const entries: HarnessImportedEntry[] = [];
  const gateways: HarnessGatewayEntry[] = [];
  for (const [name, spec] of Object.entries(config.mcpServers)) {
    const slug = toSlug(name);
    const url = spec.url;
    if (url !== undefined) {
      const gateway = remoteGateway(name, slug, url, spec.headers, options.targetUrl ?? null);
      if (gateway !== null && (gateway.self || options.includeGateways !== true)) {
        gateways.push(gateway);
        continue;
      }
      entries.push(parseRemote(name, slug, { url, headers: spec.headers }));
      continue;
    }
    const command = spec.command;
    if (command === undefined) {
      throw new AppError(
        'invalid_input',
        `MCP entry "${name}" must have a "url" (remote) or a "command" (stdio)`,
        400,
      );
    }
    const gateway = stdioGateway(name, slug, command, spec.args ?? []);
    if (gateway !== null) {
      gateways.push(gateway);
      continue;
    }
    entries.push(
      parseStdio(name, slug, {
        command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        enabled: spec.enabled,
        nodeId,
      }),
    );
  }
  return { entries, gateways };
}

/**
 * Recognize an entry that is already a ToolHome client: the CLI gateway, or a
 * remote endpoint that authenticates with a ToolHome Access Key.
 */
function stdioGateway(
  name: string,
  slug: string,
  command: string,
  args: string[],
): HarnessGatewayEntry | null {
  const executable = basename(command).replace(/\.(?:cmd|exe|bat)$/i, '');
  const isRunner = PACKAGE_RUNNERS.has(executable);
  const head = isRunner ? stripRunnerFlags(args) : args;
  const cli = isRunner ? head[0] : executable;
  if (cli !== 'toolhome' && cli !== 'mcp-home') return null;
  const rest = isRunner ? head.slice(1) : head;
  if (rest[0] !== 'mcp') return null;
  if (rest[1] === 'stdio') {
    return {
      name,
      slug,
      via: 'stdio',
      target: null,
      self: false,
      message:
        'This entry runs `toolhome mcp stdio`, the local gateway itself. Importing it would wrap ToolHome inside ToolHome; the harness is re-pointed at the hosted /mcp endpoint instead.',
    };
  }
  if (rest[1] === 'launch' && rest[2] !== undefined) {
    return {
      name,
      slug,
      via: 'launch',
      target: rest[2],
      self: false,
      message: `This entry runs the node server "${rest[2]}" through \`toolhome mcp launch\`. That server belongs on its node, so the harness is re-pointed at the hosted /mcp endpoint instead of importing the launcher.`,
    };
  }
  return null;
}

function stripRunnerFlags(args: string[]): string[] {
  const rest = [...args];
  while (rest.length > 0 && rest[0]?.startsWith('-')) rest.shift();
  return rest;
}

function remoteGateway(
  name: string,
  slug: string,
  url: string,
  headers: Record<string, string> | undefined,
  targetUrl: string | null,
): HarnessGatewayEntry | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (targetUrl !== null) {
    try {
      if (parsed.origin === new URL(targetUrl).origin) {
        return {
          name,
          slug,
          via: 'remote',
          target: url,
          self: true,
          message:
            'This entry already points at the instance being imported into. Importing it would make the gateway list itself; it is left out and the harness keeps one /mcp entry.',
        };
      }
    } catch {
      // A malformed --to is reported by the caller that owns it.
    }
  }
  const authorization = headers?.Authorization ?? headers?.authorization ?? '';
  const token = /^Bearer\s+(.+)/i.exec(authorization)?.[1]?.trim() ?? '';
  if (token.startsWith('tch_mcp_')) {
    return {
      name,
      slug,
      via: 'remote',
      target: url,
      self: false,
      message:
        'This entry is an MCP endpoint that authenticates with a ToolHome Access Key, i.e. another ToolHome instance. It is left out; pass --include-gateways to proxy that instance deliberately.',
    };
  }
  return null;
}

function parseRemote(
  name: string,
  slug: string,
  spec: { url: string; headers?: Record<string, string> },
): HarnessImportedEntry {
  const headers = spec.headers ?? {};
  const warnings: string[] = [];
  const authorization = headers.Authorization ?? headers.authorization;
  let credential: HarnessImportedCredential | null = null;
  // Credential-bound headers must NOT also sit in the plaintext transport
  // config — strip them so the token only lives in the encrypted credential.
  const transportHeaders = { ...headers };
  if (typeof authorization === 'string' && /^Bearer\s+(.+)/i.test(authorization)) {
    const token = authorization.replace(/^Bearer\s+/i, '').trim();
    credential = {
      name,
      payload: { type: 'bearer', token },
    };
    delete transportHeaders.Authorization;
    delete transportHeaders.authorization;
    warnings.push('Bearer token detected — stored as an encrypted bearer credential');
  } else if (Object.keys(headers).length > 0) {
    credential = {
      name,
      payload: { type: 'headers', headers },
    };
    for (const key of Object.keys(transportHeaders)) delete transportHeaders[key];
    warnings.push('Request headers stored as an encrypted headers credential');
  }
  return {
    name,
    slug,
    kind: 'remote',
    nodeId: null,
    transport: {
      type: 'streamable-http',
      url: spec.url,
      protocolMode: 'auto',
      allowSseFallback: true,
      headers: transportHeaders,
    },
    credential,
    warnings,
  };
}

function parseStdio(
  name: string,
  slug: string,
  spec: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    enabled?: boolean;
    nodeId?: string | null;
  },
): HarnessImportedEntry {
  const command = spec.command;
  const args = spec.args ?? [];
  const env = spec.env ?? {};
  const nodeId = spec.nodeId ?? null;
  const secretEnv: Record<string, string> = {};
  const plainEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_KEY_RE.test(key)) secretEnv[key] = value;
    else plainEnv[key] = value;
  }
  const warnings: string[] = [];
  if (nodeId !== null) {
    warnings.push(`Placed on node "${nodeId}" — it runs on that machine, not on the ToolHome host`);
  } else if (looksMachineSpecific(command, args)) {
    warnings.push(
      'The command or an argument is a path on this machine; unless the gateway container can run it, re-run with --node <label> to place it on your machine',
    );
  }
  if (spec.enabled === false) {
    warnings.push('The entry is disabled in the harness; it is imported enabled');
  }
  const packageName = resolvePackageName(args);
  if (packageName !== null && PACKAGE_RUNNERS.has(command)) {
    const known = marketCatalog.find((entry) => entry.package === packageName);
    if (known !== undefined) {
      warnings.push(
        `Matches the curated Market entry "${known.id}" — installing via Market is more reliable (version-pinned, tracked).`,
      );
    } else {
      warnings.push(
        `"${command} ${packageName}" must be resolvable inside the gateway container; the first call may be slow while it downloads.`,
      );
    }
  }
  const secretNames = Object.keys(secretEnv);
  return {
    name,
    slug,
    kind: nodeId === null ? 'home' : 'node',
    nodeId,
    transport: {
      type: 'stdio',
      command,
      args,
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: plainEnv,
      protocolMode: 'auto',
    },
    credential:
      secretNames.length === 0
        ? null
        : { name, payload: { type: 'env', variables: secretEnv } },
    warnings,
  };
}

/** A command that names something only this machine has (an absolute path, a home path). */
function looksMachineSpecific(command: string, args: string[]): boolean {
  const paths = [command, ...args];
  return paths.some(
    (value) =>
      value.startsWith('/') ||
      value.startsWith('~/') ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      value.includes('/node_modules/'),
  );
}

function resolvePackageName(args: string[]): string | null {
  const first = args[0] ?? '';
  if (first === '' || first.startsWith('http')) return null;
  // `npx -y package`, `npx package`, `npm exec package`, `uvx package`
  const candidate = first.startsWith('-') ? args.find((arg) => !arg.startsWith('-')) : first;
  if (candidate === undefined || candidate === '') return null;
  return candidate.split('@')[0] ?? null;
}

/** Masked view for previews — never contains secret values. */
export function toPreview(entry: HarnessImportedEntry): HarnessImportPreview {
  const transportSummary =
    entry.transport.type === 'stdio'
      ? `${entry.transport.command} ${entry.transport.args.join(' ')}`.trim()
      : entry.transport.url;
  let credential: HarnessImportPreview['credential'] = null;
  if (entry.credential !== null) {
    const payload = entry.credential.payload;
    const type = payload.type;
    const fields =
      type === 'bearer'
        ? [{ name: 'token', masked: true }]
        : type === 'headers'
          ? Object.keys(payload.headers).map((name) => ({ name, masked: true }))
          : payload.type === 'env'
            ? Object.keys(payload.variables).map((name) => ({ name, masked: true }))
            : [];
    credential = { name: entry.credential.name, type, fields };
  }
  return {
    name: entry.name,
    slug: entry.slug,
    kind: entry.kind,
    nodeId: entry.nodeId,
    transportSummary,
    credential,
    warnings: entry.warnings,
  };
}
