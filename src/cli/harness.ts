import {
  describePath,
  detectHarnesses,
  HARNESS_LOCATIONS,
  locateHarness,
  readHarnessFile,
  renderHarnessFile,
  type HarnessFile,
  type HarnessFileContent,
} from '../config/harness-formats.js';
import { AppError } from '../domain/errors.js';
import { marketCatalog } from '../market/catalog.js';
import { toSlug } from '../config/harness-import.js';

/**
 * One command that moves the MCP servers of local harness configs onto a hosted
 * instance: read every file, preview, apply, verify, issue the Access Key and —
 * with `--write-back` — leave each harness with a single `/mcp` entry.
 *
 * The flow is a pure function of its dependencies so the CLI wrapper stays thin
 * and the whole path is testable without a browser or a live server.
 */

export interface HarnessImportClient {
  request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface HarnessImportDeps {
  client: HarnessImportClient;
  /** The instance being imported into, e.g. `https://tool.cyncyn.xyz`. */
  baseUrl: string;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  backup(path: string): string;
  env: NodeJS.ProcessEnv;
  home: string;
  log(line: string): void;
}

export interface HarnessImportOptions {
  /** Explicit files; `-` is not supported (a harness config is a real file). */
  files: string[];
  /** Known harness ids to read when no file is named. */
  harnesses: string[];
  nodeId?: string | null;
  preview: boolean;
  writeBack: boolean;
  issueAccessKey?: string | null;
  mode: 'create' | 'upsert';
  includeGateways?: boolean;
}

interface PreviewEntry {
  name: string;
  slug: string;
  kind: 'remote' | 'home' | 'node';
  nodeId: string | null;
  transportSummary: string;
  status: string;
  changes: string[];
  warnings: string[];
  credential: { type: string } | null;
}

interface GatewayEntry {
  name: string;
  slug: string;
  via: 'stdio' | 'launch' | 'remote';
  target: string | null;
  message: string;
}

interface ImportResponse {
  preview: boolean;
  nodeId: string | null;
  gateways: GatewayEntry[];
  entries: PreviewEntry[];
}

export interface HarnessImportReport {
  target: string;
  applied: boolean;
  files: { path: string; format: string; key: string; entries: number }[];
  entries: PreviewEntry[];
  gateways: GatewayEntry[];
  /** Remote entries with no stored credential: these need `credential authorize`. */
  authorization: { name: string; slug: string; hint: string }[];
  accessKey: { name: string; snippet: string; snippetToml: string } | null;
  verification: { ok: boolean | null; failing: string[] };
  writtenBack: { path: string; backup: string; remaining: number }[];
  warnings: string[];
}

const JSON_SNIPPET = (url: string, key: string): string =>
  JSON.stringify(
    { mcpServers: { toolhome: { url, headers: { Authorization: `Bearer ${key}` } } } },
    null,
    2,
  );

const TOML_SNIPPET = (url: string, key: string): string =>
  [
    '[mcp_servers.toolhome]',
    `url = "${url}"`,
    '',
    '[mcp_servers.toolhome.headers]',
    `Authorization = "Bearer ${key}"`,
  ].join('\n');

export function resolveHarnessFiles(
  options: Pick<HarnessImportOptions, 'files' | 'harnesses'>,
  env: NodeJS.ProcessEnv,
  home: string,
): HarnessFile[] {
  const targets: HarnessFile[] = [];
  for (const path of options.files) {
    targets.push(describePath(path, ''));
  }
  for (const id of options.harnesses) {
    const location = HARNESS_LOCATIONS.find((candidate) => candidate.id === id);
    if (location === undefined) {
      const known = HARNESS_LOCATIONS.map((candidate) => candidate.id).join(', ');
      throw new AppError('unknown_harness', `Unknown harness "${id}"; known: ${known}`, 400);
    }
    const found = locateHarness(location, env, home);
    if (found === null) {
      throw new AppError(
        'harness_not_found',
        `No ${location.name} config found (looked at ${location.candidates.join(', ')})`,
        404,
      );
    }
    targets.push(found);
  }
  if (targets.length === 0) {
    targets.push(...detectHarnesses(env, home));
  }
  if (targets.length === 0) {
    const known = HARNESS_LOCATIONS.map((candidate) => candidate.id).join(', ');
    throw new AppError(
      'harness_not_found',
      `No harness config found on this machine; pass a file or --harness <${known}>`,
      404,
    );
  }
  const unique = new Map<string, HarnessFile>();
  for (const target of targets) unique.set(target.path, target);
  return [...unique.values()];
}

/** Read every target and merge their servers, first definition winning. */
export function collectHarnessServers(
  targets: HarnessFile[],
  deps: Pick<HarnessImportDeps, 'readFile'>,
): { contents: HarnessFileContent[]; servers: Record<string, unknown>; warnings: string[] } {
  const contents: HarnessFileContent[] = [];
  const servers: Record<string, unknown> = {};
  const origins = new Map<string, string>();
  const warnings: string[] = [];
  for (const target of targets) {
    const text = deps.readFile(target.path);
    const content = readHarnessFile(target.path, text, describePath(target.path, text));
    contents.push(content);
    for (const [name, entry] of Object.entries(content.servers)) {
      const previous = origins.get(name);
      if (previous !== undefined) {
        if (JSON.stringify(servers[name]) !== JSON.stringify(entry)) {
          warnings.push(
            `"${name}" is defined differently in ${previous} and ${content.path}; the first definition is used`,
          );
        }
        continue;
      }
      origins.set(name, content.path);
      servers[name] = entry;
    }
  }
  return { contents, servers, warnings };
}

export async function runHarnessImport(
  deps: HarnessImportDeps,
  options: HarnessImportOptions,
): Promise<HarnessImportReport> {
  const targets = resolveHarnessFiles(options, deps.env, deps.home);
  const { contents, servers, warnings } = collectHarnessServers(targets, deps);
  if (Object.keys(servers).length === 0) {
    throw new AppError(
      'invalid_input',
      `No MCP servers found in ${targets.map((target) => target.path).join(', ')}`,
      400,
    );
  }

  deps.log(
    `reading ${targets.length} harness file${targets.length === 1 ? '' : 's'}: ${Object.keys(servers).length} server${Object.keys(servers).length === 1 ? '' : 's'}`,
  );
  const body = {
    config: { mcpServers: servers },
    ...(options.nodeId === null || options.nodeId === undefined ? {} : { node: options.nodeId }),
    ...(options.mode === 'upsert' ? { mode: 'upsert' } : {}),
    ...(options.includeGateways === true ? { includeGateways: true } : {}),
  };
  const preview = (await deps.client.request('POST', '/api/v1/config/import-harness', {
    ...body,
    preview: true,
  })) as ImportResponse;

  let applied: ImportResponse = preview;
  if (!options.preview) {
    deps.log('applying the import');
    applied = (await deps.client.request(
      'POST',
      '/api/v1/config/import-harness',
      body,
    )) as ImportResponse;
  }

  const importedSlugs = new Set(applied.entries.map((entry) => entry.slug));
  const gatewaySlugs = new Set(applied.gateways.map((entry) => entry.slug));

  const authorization = applied.entries
    .filter((entry) => entry.kind === 'remote' && entry.credential === null)
    .map((entry) => {
      const catalog = marketCatalog.find(
        (candidate) =>
          candidate.kind === 'remote' &&
          candidate.credential.type === 'oauth' &&
          typeof candidate.url === 'string' &&
          entry.transportSummary.startsWith(candidate.url),
      );
      return {
        name: entry.name,
        slug: entry.slug,
        hint:
          catalog === undefined
            ? `If "${entry.name}" needs OAuth, create a credential and run: toolhome credential authorize <credential>`
            : `toolhome credential authorize ${catalog.id} — OAuth is registered per origin; a moved credential must be authorized here`,
      };
    });

  let accessKey: HarnessImportReport['accessKey'] = null;
  let accessKeySecret: string | null = null;
  if (!options.preview && options.issueAccessKey) {
    const issued = (await deps.client.request('POST', '/api/v1/access-keys', {
      name: options.issueAccessKey,
    })) as { key?: unknown; secret?: unknown };
    const secret =
      typeof issued.secret === 'string'
        ? issued.secret
        : typeof issued.key === 'string'
          ? issued.key
          : null;
    if (secret === null) {
      throw new AppError(
        'access_key_unavailable',
        'The target did not return an Access Key secret; create one with `toolhome access-key create <name>`',
        502,
      );
    }
    const url = new URL('/mcp', deps.baseUrl).toString();
    accessKeySecret = secret;
    accessKey = {
      name: options.issueAccessKey,
      snippet: JSON_SNIPPET(url, secret),
      snippetToml: TOML_SNIPPET(url, secret),
    };
  }

  let verificationOk: boolean | null = null;
  let failing: string[] = [];
  if (!options.preview) {
    try {
      const diagnostics = (await deps.client.request('GET', '/api/v1/diagnostics')) as {
        ok?: unknown;
        servers?: { slug?: unknown; enabled?: unknown; status?: unknown }[];
      };
      verificationOk = diagnostics.ok === true;
      failing = (diagnostics.servers ?? [])
        .filter(
          (server) =>
            server.enabled === true &&
            server.status !== 'ready' &&
            // A node server is not this host's to connect; it reports its own state.
            server.status !== 'unknown',
        )
        .map((server) => String(server.slug));
    } catch {
      verificationOk = null;
    }
  }

  const writtenBack: HarnessImportReport['writtenBack'] = [];
  if (!options.preview && options.writeBack) {
    if (accessKey === null) {
      throw new AppError(
        'access_key_required',
        '--write-back needs an Access Key for the harness entry; pass --issue-access-key <name>',
        400,
      );
    }
    const url = new URL('/mcp', deps.baseUrl).toString();
    const secret = accessKeySecret ?? '';
    for (const content of contents) {
      const remaining: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(content.servers)) {
        const slug = toSlug(name);
        if (importedSlugs.has(slug) || gatewaySlugs.has(slug)) continue;
        remaining[name] = entry;
      }
      remaining.toolhome = { url, headers: { Authorization: `Bearer ${secret}` } };
      const backup = deps.backup(content.path);
      deps.writeFile(content.path, renderHarnessFile(content, remaining));
      writtenBack.push({ path: content.path, backup, remaining: Object.keys(remaining).length });
      deps.log(`wrote ${content.path} (backup ${backup})`);
    }
  }

  return {
    target: deps.baseUrl,
    applied: !options.preview,
    files: contents.map((content) => ({
      path: content.path,
      format: content.format,
      key: content.key,
      entries: Object.keys(content.servers).length,
    })),
    entries: applied.entries,
    gateways: applied.gateways,
    authorization,
    accessKey,
    verification: { ok: verificationOk, failing },
    writtenBack,
    warnings,
  };
}

/** `toolhome harness list`: every known harness and whether its file is here. */
export function listHarnesses(
  env: NodeJS.ProcessEnv,
  home: string,
): { id: string; name: string; path: string | null; format: string }[] {
  return HARNESS_LOCATIONS.map((location) => {
    const found = locateHarness(location, env, home);
    return {
      id: location.id,
      name: location.name,
      path: found?.path ?? null,
      format: location.format,
    };
  });
}
