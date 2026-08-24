import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { CredentialPayload, TransportConfig } from '../domain/models.js';
import { marketCatalog } from '../market/catalog.js';

/**
 * Translates a harness MCP config (Claude Desktop / Cursor `mcpServers` JSON)
 * into ToolHome servers + credentials.
 *
 * Parsing rules:
 * - `url` (+ `headers`)      -> remote streamable-http; `Authorization: Bearer X`
 *   becomes a bearer credential, other headers become a headers credential.
 * - `command` + `args` + `env` -> home stdio server; env keys whose names look
 *   secret (password/token/secret/key/authorization) go into an encrypted env
 *   credential, everything else into `transport.env`.
 * - npx/uvx/bunx stdio entries that match a curated Market package are flagged
 *   with a suggestion to install via the Market instead.
 */

const harnessServerSchema = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
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
  kind: 'remote' | 'home';
  transport: TransportConfig;
  credential: HarnessImportedCredential | null;
  warnings: string[];
}

export interface HarnessImportPreview {
  name: string;
  slug: string;
  kind: 'remote' | 'home';
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

export function parseHarnessConfig(value: unknown): HarnessImportedEntry[] {
  const config = harnessConfigSchema.parse(value);
  return Object.entries(config.mcpServers).map(([name, spec]) => {
    const slug = toSlug(name);
    const url = spec.url;
    if (url !== undefined) {
      return parseRemote(name, slug, { url, headers: spec.headers });
    }
    const command = spec.command;
    if (command === undefined) {
      throw new AppError(
        'invalid_input',
        `MCP entry "${name}" must have a "url" (remote) or a "command" (stdio)`,
        400,
      );
    }
    return parseStdio(name, slug, { command, args: spec.args, env: spec.env });
  });
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
  spec: { command: string; args?: string[]; env?: Record<string, string> },
): HarnessImportedEntry {
  const command = spec.command;
  const args = spec.args ?? [];
  const env = spec.env ?? {};
  const secretEnv: Record<string, string> = {};
  const plainEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_KEY_RE.test(key)) secretEnv[key] = value;
    else plainEnv[key] = value;
  }
  const warnings: string[] = [];
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
    kind: 'home',
    transport: { type: 'stdio', command, args, env: plainEnv, protocolMode: 'auto' },
    credential:
      secretNames.length === 0
        ? null
        : { name, payload: { type: 'env', variables: secretEnv } },
    warnings,
  };
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
    transportSummary,
    credential,
    warnings: entry.warnings,
  };
}
