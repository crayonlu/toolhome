import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { AppError } from '../domain/errors.js';

/**
 * Harness config files hold the same logical entry — `command`/`args`/`env` or
 * `url`/`headers` — under different file formats and top-level keys. This module
 * reads and writes those files generically: a location table says where a
 * harness keeps its servers, and a reader turns the file into the one
 * `mcpServers` shape the importer already understands. Nothing here is
 * harness-specific code, which keeps the product boundary ("no per-harness
 * adapters") intact: adding a harness is a row in the table.
 *
 * Reference for the table: yetone/magpie's `internal/library/targets.go`, which
 * maps each agent to one file plus a format.
 */

export type HarnessFileFormat = 'json' | 'toml';

export interface HarnessLocation {
  /** Stable id used by `--harness <id>`. */
  id: string;
  name: string;
  /**
   * Where the harness keeps its user-wide servers, in priority order. `~` is the
   * home directory and `$VAR` reads the environment; a candidate whose variable
   * is unset is skipped.
   */
  candidates: string[];
  format: HarnessFileFormat;
  /** Top-level object that holds the servers. */
  key: string;
}

export const HARNESS_LOCATIONS: readonly HarnessLocation[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    candidates: ['$CLAUDE_CONFIG_DIR/.claude.json', '~/.claude.json'],
    format: 'json',
    key: 'mcpServers',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    candidates: [
      '~/Library/Application Support/Claude/claude_desktop_config.json',
      '$XDG_CONFIG_HOME/Claude/claude_desktop_config.json',
      '~/.config/Claude/claude_desktop_config.json',
      '$APPDATA/Claude/claude_desktop_config.json',
    ],
    format: 'json',
    key: 'mcpServers',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    candidates: ['~/.cursor/mcp.json'],
    format: 'json',
    key: 'mcpServers',
  },
  {
    id: 'codex',
    name: 'Codex',
    candidates: ['$CODEX_HOME/config.toml', '~/.codex/config.toml'],
    format: 'toml',
    key: 'mcp_servers',
  },
  {
    id: 'grok',
    name: 'Grok Build',
    candidates: ['$GROK_HOME/config.toml', '~/.grok/config.toml'],
    format: 'toml',
    key: 'mcp_servers',
  },
  {
    id: 'pi',
    name: 'Pi',
    candidates: ['$PI_CODING_AGENT_DIR/mcp.json', '~/.pi/agent/mcp.json'],
    format: 'json',
    key: 'mcpServers',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    candidates: [
      '~/Library/Application Support/Code/User/mcp.json',
      '$XDG_CONFIG_HOME/Code/User/mcp.json',
      '~/.config/Code/User/mcp.json',
      '$APPDATA/Code/User/mcp.json',
    ],
    format: 'json',
    key: 'servers',
  },
];

export interface HarnessFile {
  path: string;
  format: HarnessFileFormat;
  key: string;
}

export interface HarnessFileContent extends HarnessFile {
  /** The entries under the file's key, in the shared `mcpServers` entry shape. */
  servers: Record<string, unknown>;
  text: string;
}

export function harnessById(id: string): HarnessLocation {
  const location = HARNESS_LOCATIONS.find((candidate) => candidate.id === id);
  if (location === undefined) {
    const known = HARNESS_LOCATIONS.map((candidate) => candidate.id).join(', ');
    throw new AppError('unknown_harness', `Unknown harness "${id}"; known: ${known}`, 400);
  }
  return location;
}

/** Expand `~` and `$VAR`; null when the candidate names an unset variable. */
export function expandCandidate(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  if (candidate.startsWith('~')) return resolve(home, candidate.slice(1).replace(/^\//, ''));
  const expanded = candidate.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => {
    const value = env[name];
    return value === undefined ? match : value;
  });
  if (/\$[A-Za-z_][A-Za-z0-9_]*/.test(expanded)) return null;
  return isAbsolute(expanded) ? expanded : null;
}

/** The first candidate that exists on this machine, or null. */
export function locateHarness(
  location: HarnessLocation,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): HarnessFile | null {
  for (const candidate of location.candidates) {
    const path = expandCandidate(candidate, env, home);
    if (path !== null && exists(path)) return { path, format: location.format, key: location.key };
  }
  return null;
}

/** Every known harness that has a config file on this machine. */
export function detectHarnesses(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): HarnessFile[] {
  const found: HarnessFile[] = [];
  for (const location of HARNESS_LOCATIONS) {
    const file = locateHarness(location, env, home, exists);
    if (file !== null) found.push(file);
  }
  return found;
}

/** A path given on the command line: the extension picks the format, the content the key. */
export function describePath(path: string, text: string): HarnessFile {
  if (path.endsWith('.toml')) return { path, format: 'toml', key: 'mcp_servers' };
  if (path.endsWith('.json')) {
    return { path, format: 'json', key: jsonKey(text) };
  }
  // No useful extension: sniff the first non-space character.
  return text.trimStart().startsWith('{')
    ? { path, format: 'json', key: jsonKey(text) }
    : { path, format: 'toml', key: 'mcp_servers' };
}

function jsonKey(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'mcpServers';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'mcpServers';
  for (const key of ['mcpServers', 'servers', 'mcp_servers']) {
    if (typeof Reflect.get(parsed, key) === 'object' && Reflect.get(parsed, key) !== null)
      return key;
  }
  return 'mcpServers';
}

export function readHarnessFile(
  path: string,
  text: string,
  described: HarnessFile = describePath(path, text),
): HarnessFileContent {
  const servers =
    described.format === 'toml'
      ? parseTomlServers(text, described.key)
      : parseJsonServers(text, described.key, path);
  return { ...described, servers, text };
}

function parseJsonServers(text: string, key: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AppError(
      'invalid_input',
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
      400,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AppError('invalid_input', `${path}: the file is not a JSON object`, 400);
  }
  const value = Reflect.get(parsed, key);
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('invalid_input', `${path}: "${key}" is not an object`, 400);
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TOML
//
// Only the subset a harness config uses is understood: tables, string / boolean
// / number / array / inline-table values, and comments. Anything else is left
// out rather than guessed at, and the importer reports entries it cannot read.
// ---------------------------------------------------------------------------

interface TomlTable {
  path: string[];
  /** The header as written, so a rewrite keeps the user's own spelling. */
  header: string;
  body: string[];
}

export function splitToml(text: string): { preamble: string[]; tables: TomlTable[] } {
  const lines = text.split(/\r?\n/);
  const preamble: string[] = [];
  const tables: TomlTable[] = [];
  let current: TomlTable | null = null;
  let depth = 0;
  let quote: string | null = null;
  for (const line of lines) {
    if (depth === 0 && quote === null) {
      const header = matchTableHeader(line);
      if (header !== null) {
        current = { path: header, header: line, body: [] };
        tables.push(current);
        continue;
      }
    }
    (current === null ? preamble : current.body).push(line);
    const state = advance(line, depth, quote);
    depth = state.depth;
    quote = state.quote;
  }
  return { preamble, tables };
}

function matchTableHeader(line: string): string[] | null {
  const match = /^\s*\[\[?([^\]]+?)\]\]?\s*(?:#.*)?$/.exec(line);
  if (match === null) return null;
  const path = match[1] ?? '';
  return path
    .split('.')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter((part) => part !== '');
}

/** Track bracket depth and multi-line string state so a `[` inside a value is not a table. */
function advance(
  line: string,
  depth: number,
  quote: string | null,
): { depth: number; quote: string | null } {
  let index = 0;
  let currentQuote = quote;
  let currentDepth = depth;
  while (index < line.length) {
    if (currentQuote === '"""' || currentQuote === "'''") {
      const end = line.indexOf(currentQuote, index);
      if (end === -1) return { depth: currentDepth, quote: currentQuote };
      index = end + 3;
      currentQuote = null;
      continue;
    }
    const char = line[index] ?? '';
    if (char === '#') break;
    if (char === '"' || char === "'") {
      if (line.startsWith(char.repeat(3), index)) {
        currentQuote = char.repeat(3);
        index += 3;
        continue;
      }
      let cursor = index + 1;
      while (cursor < line.length) {
        if (char === '"' && line[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (line[cursor] === char) break;
        cursor++;
      }
      index = cursor + 1;
      continue;
    }
    if (char === '[' || char === '{') currentDepth++;
    else if (char === ']' || char === '}') currentDepth = Math.max(0, currentDepth - 1);
    index++;
  }
  return { depth: currentDepth, quote: currentQuote };
}

export function parseTomlServers(text: string, key = 'mcp_servers'): Record<string, unknown> {
  const { tables } = splitToml(text);
  const servers: Record<string, Record<string, unknown>> = {};
  for (const table of tables) {
    if (table.path[0] !== key) continue;
    const name = table.path[1];
    if (name === undefined) continue;
    const entry = (servers[name] ??= {});
    if (table.path.length === 2) {
      Object.assign(entry, parseKeyValues(table.body));
    } else if (
      table.path.length === 3 &&
      (table.path[2] === 'headers' || table.path[2] === 'env')
    ) {
      const nested = (entry[table.path[2]] as Record<string, string> | undefined) ?? {};
      for (const [field, value] of Object.entries(parseKeyValues(table.body))) {
        if (typeof value === 'string') nested[field] = value;
      }
      entry[table.path[2]] = nested;
    }
  }
  return servers;
}

function parseKeyValues(lines: string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (/^\s*(?:#|$)/.test(line)) continue;
    const match = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const rawKey = match[1] ?? '';
    let raw = match[2] ?? '';
    let cursor = index;
    while (!valueComplete(raw) && cursor + 1 < lines.length) {
      cursor++;
      raw += `\n${lines[cursor] ?? ''}`;
    }
    index = cursor;
    try {
      values[rawKey.replace(/^["']|["']$/g, '')] = parseTomlValue(raw);
    } catch {
      // A value this reader does not understand is left out; the importer
      // reports the entry as unusable instead of importing half of it.
    }
  }
  return values;
}

function valueComplete(raw: string): boolean {
  const { depth, quote } = advance(raw, 0, null);
  return depth === 0 && quote === null;
}

export function parseTomlValue(raw: string): unknown {
  const parser = new TomlValueParser(raw);
  const value = parser.value();
  parser.skipSpace();
  if (!parser.done()) throw new Error('trailing content');
  return value;
}

class TomlValueParser {
  readonly #text: string;
  #index = 0;

  constructor(text: string) {
    this.#text = text;
  }

  done(): boolean {
    return this.#index >= this.#text.length;
  }

  skipSpace(): void {
    for (;;) {
      while (!this.done() && /\s/.test(this.#text[this.#index] ?? '')) this.#index++;
      if (this.#text[this.#index] === '#') {
        const newline = this.#text.indexOf('\n', this.#index);
        this.#index = newline === -1 ? this.#text.length : newline + 1;
        continue;
      }
      return;
    }
  }

  value(): unknown {
    this.skipSpace();
    const char = this.#text[this.#index] ?? '';
    if (char === '"' || char === "'") return this.string();
    if (char === '[') return this.array();
    if (char === '{') return this.inlineTable();
    return this.scalar();
  }

  #peek(offset = 0): string {
    return this.#text[this.#index + offset] ?? '';
  }

  string(): string {
    const quote = this.#peek();
    if (this.#text.startsWith(quote.repeat(3), this.#index)) {
      this.#index += 3;
      const end = this.#text.indexOf(quote.repeat(3), this.#index);
      const body = end === -1 ? this.#text.slice(this.#index) : this.#text.slice(this.#index, end);
      this.#index = end === -1 ? this.#text.length : end + 3;
      return quote === '"' ? unescape(body) : body;
    }
    this.#index++;
    let out = '';
    while (!this.done()) {
      const char = this.#peek();
      if (char === quote) {
        this.#index++;
        return quote === '"' ? unescape(out) : out;
      }
      if (quote === '"' && char === '\\') {
        out += char + this.#peek(1);
        this.#index += 2;
        continue;
      }
      out += char;
      this.#index++;
    }
    throw new Error('unterminated string');
  }

  array(): unknown[] {
    this.#index++;
    const items: unknown[] = [];
    for (;;) {
      this.skipSpace();
      if (this.done()) throw new Error('unterminated array');
      if (this.#peek() === ']') {
        this.#index++;
        return items;
      }
      items.push(this.value());
      this.skipSpace();
      if (this.#peek() === ',') this.#index++;
    }
  }

  inlineTable(): Record<string, unknown> {
    this.#index++;
    const table: Record<string, unknown> = {};
    for (;;) {
      this.skipSpace();
      if (this.done()) throw new Error('unterminated inline table');
      if (this.#peek() === '}') {
        this.#index++;
        return table;
      }
      const key = this.#key();
      this.skipSpace();
      if (this.#peek() !== '=') throw new Error('expected =');
      this.#index++;
      table[key] = this.value();
      this.skipSpace();
      if (this.#peek() === ',') this.#index++;
    }
  }

  #key(): string {
    this.skipSpace();
    if (this.#peek() === '"' || this.#peek() === "'") return this.string();
    const start = this.#index;
    while (!this.done() && /[A-Za-z0-9_.-]/.test(this.#peek())) this.#index++;
    return this.#text.slice(start, this.#index);
  }

  scalar(): unknown {
    const start = this.#index;
    while (!this.done() && !/[,\]}#]/.test(this.#peek())) this.#index++;
    const raw = this.#text.slice(start, this.#index).trim();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?\d+$/.test(raw)) return Number.parseInt(raw, 10);
    if (/^[+-]?\d*\.\d+(?:[eE][+-]?\d+)?$/.test(raw)) return Number.parseFloat(raw);
    return raw;
  }
}

function unescape(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (match, code: string) => {
    switch (code[0]) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'u':
      case 'U':
        return String.fromCodePoint(Number.parseInt(code.slice(1), 16));
      default:
        return match;
    }
  });
}

/** Render the servers back into the file, keeping everything the harness owns. */
export function renderHarnessFile(
  content: HarnessFileContent,
  servers: Record<string, unknown>,
): string {
  return content.format === 'toml' ? renderToml(content, servers) : renderJson(content, servers);
}

function renderJson(content: HarnessFileContent, servers: Record<string, unknown>): string {
  const doc = JSON.parse(content.text) as Record<string, unknown>;
  doc[content.key] = servers;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function renderToml(content: HarnessFileContent, servers: Record<string, unknown>): string {
  const { preamble, tables } = splitToml(content.text);
  const kept = tables.filter((table) => table.path[0] !== content.key);
  const parts: string[] = [];
  if (preamble.join('').trim() !== '') parts.push(preamble.join('\n').replace(/\s+$/, ''));
  for (const table of kept) {
    parts.push([table.header, ...table.body].join('\n').replace(/\s+$/, ''));
  }
  for (const [name, entry] of Object.entries(servers)) {
    parts.push(renderTomlEntry(content.key, name, entry));
  }
  return `${parts.filter((part) => part !== '').join('\n\n')}\n`;
}

function renderTomlEntry(key: string, name: string, value: unknown): string {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const header = `[${key}.${tomlKey(name)}]`;
  const lines: string[] = [header];
  const command = typeof entry.command === 'string' ? entry.command : null;
  const url = typeof entry.url === 'string' ? entry.url : null;
  if (command !== null) {
    lines.push(`command = ${tomlString(command)}`);
    const args = Array.isArray(entry.args) ? entry.args : [];
    if (args.length > 0) {
      lines.push(`args = [${args.map((arg) => tomlString(String(arg))).join(', ')}]`);
    }
    if (typeof entry.cwd === 'string') lines.push(`cwd = ${tomlString(entry.cwd)}`);
    const env = asStringRecord(entry.env);
    if (env !== null) lines.push(`env = ${tomlInline(env)}`);
  } else if (url !== null) {
    lines.push(`url = ${tomlString(url)}`);
    const headers = asStringRecord(entry.headers);
    if (headers !== null) lines.push(`headers = ${tomlInline(headers)}`);
  }
  if (entry.enabled === false) lines.push('enabled = false');
  return lines.join('\n');
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null) return null;
  const out: Record<string, string> = {};
  for (const [field, item] of Object.entries(value)) {
    if (typeof item === 'string') out[field] = item;
  }
  return Object.keys(out).length === 0 ? null : out;
}

function tomlInline(values: Record<string, string>): string {
  const fields = Object.entries(values).map(
    ([field, value]) => `${tomlKey(field)} = ${tomlString(value)}`,
  );
  return `{ ${fields.join(', ')} }`;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/** Read a file from disk (kept separate so tests can pass text directly). */
export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}
