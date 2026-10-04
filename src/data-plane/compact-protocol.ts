import type { CallToolResult, Tool } from '@modelcontextprotocol/server';

/**
 * Wire contract for the compact discovery surface: the two fixed tools
 * (`search`/`exec`), argument validation, budgets and the shared machine
 * readable error shape. Everything here is deterministic and makes no network
 * or subprocess calls.
 */
export const COMPACT_PROTOCOL_VERSION = '1';

/** Scorer choice for benchmark comparisons; scoring itself lives in tool-catalog.ts. */
export type RankAlgorithm = 'field-score' | 'bm25';
export const DEFAULT_RANK_ALGORITHM: RankAlgorithm = 'field-score';
export const RANK_ALGORITHM: RankAlgorithm = DEFAULT_RANK_ALGORITHM;

/** Output budgets, measured on the complete MCP result package. */
export const COMPACT_BUDGETS = {
  /** Fixed search+exec description and schema, estimated tokens. */
  fixedSchemaTokens: 2_000,
  serversBytes: 8 * 1_024,
  findSummaryBytes: 8 * 1_024,
  findDefinitionBytes: 16 * 1_024,
  describeBytes: 16 * 1_024,
  /** Error results fit the smallest discovery budget even with oversized input. */
  errorBytes: 8 * 1_024,
} as const;

export type CompactBudgetName = keyof typeof COMPACT_BUDGETS;

// ── Compact errors ────────────────────────────────────────────────────────

export type CompactErrorCode =
  | 'invalid_arguments'
  | 'unknown_server'
  | 'unknown_tool'
  | 'invalid_cursor'
  | 'catalog_unavailable'
  | 'definition_changed'
  | 'definition_too_large'
  | 'individual_endpoint_required'
  | 'upstream_failure'
  | 'continuation_rejected';

export type CompactNextStepAction =
  | 'retry_search'
  | 'describe'
  | 'refresh_catalog'
  | 'use_full'
  | 'use_individual'
  | 'check_status'
  | 'request_approval'
  | 'fix_arguments';

export type CompactCallEffect = 'not_started' | 'may_have_run';

export interface CompactNextStep {
  action: CompactNextStepAction;
  arguments?: Record<string, unknown>;
  guidance?: string;
}

export interface CompactErrorData {
  kind: 'error';
  code: CompactErrorCode;
  message: string;
  source: 'gateway' | 'upstream';
  callEffect: CompactCallEffect;
  nextStep: CompactNextStep;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface CompactErrorOptions {
  source?: 'gateway' | 'upstream';
  callEffect?: CompactCallEffect;
  nextStep?: CompactNextStep;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

function defaultCallEffect(code: CompactErrorCode): CompactCallEffect {
  // Discovery-side failures reject before any upstream invocation is submitted.
  // Continuation/upstream failures cannot prove the original call did not run.
  return code === 'continuation_rejected' || code === 'upstream_failure'
    ? 'may_have_run'
    : 'not_started';
}

function defaultNextStep(code: CompactErrorCode): CompactNextStep {
  switch (code) {
    case 'invalid_arguments':
      return { action: 'fix_arguments', guidance: 'Correct the arguments and retry.' };
    case 'unknown_server':
      return { action: 'retry_search', arguments: { action: 'servers' } };
    case 'unknown_tool':
      return { action: 'retry_search', arguments: { action: 'find' } };
    case 'invalid_cursor':
      return { action: 'retry_search', arguments: { action: 'servers' } };
    case 'catalog_unavailable':
      return { action: 'refresh_catalog' };
    case 'definition_changed':
      return { action: 'describe', guidance: 'Re-fetch the current definition before executing.' };
    case 'definition_too_large':
      return {
        action: 'use_full',
        guidance: 'Use the original full or individual endpoint for this tool.',
      };
    case 'individual_endpoint_required':
      return {
        action: 'use_individual',
        guidance: 'Use the individual /mcp/{server} endpoint for exact upstream semantics.',
      };
    case 'upstream_failure':
      return { action: 'check_status', guidance: 'Check the call status before retrying.' };
    case 'continuation_rejected':
      return { action: 'check_status' };
  }
}

function compactData(
  code: CompactErrorCode,
  message: string,
  options: CompactErrorOptions,
): CompactErrorData {
  const data: CompactErrorData = {
    kind: 'error',
    code,
    message,
    source: options.source ?? 'gateway',
    callEffect: options.callEffect ?? defaultCallEffect(code),
    nextStep: options.nextStep ?? defaultNextStep(code),
  };
  if (options.retryable !== undefined) data.retryable = options.retryable;
  if (options.details !== undefined) data.details = options.details;
  return data;
}

export class CompactError extends Error {
  readonly code: CompactErrorCode;

  constructor(
    code: CompactErrorCode,
    message: string,
    readonly options: CompactErrorOptions = {},
  ) {
    super(message);
    this.name = 'CompactError';
    this.code = code;
  }

  get source(): 'gateway' | 'upstream' {
    return this.options.source ?? 'gateway';
  }

  get callEffect(): CompactCallEffect {
    return this.options.callEffect ?? defaultCallEffect(this.code);
  }

  get nextStep(): CompactNextStep {
    return this.options.nextStep ?? defaultNextStep(this.code);
  }

  toData(): CompactErrorData {
    return compactData(this.code, this.message, this.options);
  }

  static isInstance(value: unknown): value is CompactError {
    return value instanceof CompactError;
  }
}

export function invalidArguments(message: string, details?: Record<string, unknown>): CompactError {
  return new CompactError('invalid_arguments', message, { details });
}

export function unknownServerError(server: string): CompactError {
  return new CompactError('unknown_server', `Unknown server: ${server}`, {
    details: { server },
  });
}

export function unknownToolError(tool: string): CompactError {
  // Never leak whether a hidden/disabled/foreign tool exists.
  return new CompactError('unknown_tool', `Unknown tool: ${tool}`, { details: { tool } });
}

export function invalidCursorError(): CompactError {
  return new CompactError('invalid_cursor', 'The catalog cursor is invalid or stale');
}

export function definitionTooLargeError(details: Record<string, unknown>): CompactError {
  return new CompactError('definition_too_large', 'Tool definition exceeds the response budget', {
    details,
  });
}

// ── Results ───────────────────────────────────────────────────────────────

export function jsonToolResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function errorResult(data: CompactErrorData): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: true,
  };
}

function clampText(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit).join('');
}

function leanNextStep(step: CompactNextStep): CompactNextStep {
  return {
    action: step.action,
    ...(step.guidance === undefined ? {} : { guidance: clampText(step.guidance, 200) }),
  };
}

/**
 * Errors share the discovery budgets: oversized tool ids, messages or details
 * are dropped/clamped so the complete package stays inside `errorBytes`.
 */
export function compactErrorResult(error: CompactError): CallToolResult {
  const data = error.toData();
  const full = errorResult(data);
  if (resultByteLength(full) <= COMPACT_BUDGETS.errorBytes) return full;

  const lean: CompactErrorData = {
    kind: 'error',
    code: data.code,
    message: clampText(data.message, 300),
    source: data.source,
    callEffect: data.callEffect,
    nextStep: leanNextStep(data.nextStep),
    ...(data.retryable === undefined ? {} : { retryable: data.retryable }),
  };
  const leanResult = errorResult(lean);
  if (resultByteLength(leanResult) <= COMPACT_BUDGETS.errorBytes) return leanResult;

  return errorResult({
    kind: 'error',
    code: data.code,
    message: clampText(data.message, 120),
    source: data.source,
    callEffect: data.callEffect,
    nextStep: { action: data.nextStep.action },
  });
}

/** Byte length of the complete MCP result package (text + structuredContent). */
export function resultByteLength(result: CallToolResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

/** Deterministic token estimate used for the fixed-schema budget gate. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4);
}

// ── Tool schemas ──────────────────────────────────────────────────────────

export const SEARCH_TOOL_NAME = 'search';
export const EXEC_TOOL_NAME = 'exec';

export const SEARCH_ACTIONS = ['servers', 'find', 'describe'] as const;
export type SearchAction = (typeof SEARCH_ACTIONS)[number];

export const SEARCH_DETAILS = ['summary', 'definition'] as const;
export type SearchDetail = (typeof SEARCH_DETAILS)[number];

const parameterSchema = { type: 'object' as const, additionalProperties: true };

/**
 * Fixed `search` schema. `additionalProperties: false` keeps per-action
 * combinations strict; the handler validates which fields each action accepts.
 */
export const searchInputSchema: Tool['inputSchema'] = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...SEARCH_ACTIONS],
      description:
        'servers: inspect this gateway; find: rank tools for a task; describe: full contract.',
    },
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 512,
      description: 'find: task description. English action/object keywords improve matching.',
    },
    server: {
      type: 'string',
      description: 'find: exact server slug returned by action=servers.',
    },
    tool: {
      type: 'string',
      description: 'describe: exact tool identifier returned by find.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'servers default 20/max 50; find default 5/max 10 (definition max 3).',
    },
    cursor: {
      type: 'string',
      description: 'servers: pagination cursor from a previous directory response.',
    },
    detail: {
      type: 'string',
      enum: [...SEARCH_DETAILS],
      description: 'find: summary (default) or definition for up to 3 complete contracts.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

export const execInputSchema: Tool['inputSchema'] = {
  type: 'object',
  properties: {
    tool: {
      type: 'string',
      description: 'Exact tool identifier returned by find/describe.',
    },
    arguments: {
      ...parameterSchema,
      description: 'Arguments matching the describe-returned inputSchema.',
    },
    definition: {
      type: 'string',
      description: 'Optional describe-returned definition fingerprint.',
    },
  },
  required: ['tool', 'arguments'],
  additionalProperties: false,
};

export const searchTool: Tool = {
  name: SEARCH_TOOL_NAME,
  title: 'Search tools',
  description:
    'Find upstream MCP tools by task without knowing server names. Use action=servers to inspect this gateway, action=find for ranked summaries (optionally detail=definition), and action=describe for a selected tool\u2019s complete arguments schema. For Chinese tasks, include English action/object keywords. Execute the exact returned identifier with exec. Cached entries do not guarantee live availability.',
  inputSchema: searchInputSchema,
  annotations: { readOnlyHint: true },
};

export const execTool: Tool = {
  name: EXEC_TOOL_NAME,
  title: 'Execute tool',
  description:
    'Execute one discovered MCP tool with arguments matching its complete inputSchema. Use the definition fingerprint to detect changes. This tool may perform reads or writes depending on its target; upstream annotations appear in discovery results.',
  inputSchema: execInputSchema,
  annotations: { openWorldHint: true },
};

/** The two fixed compact tools; the list is constant even with an empty catalog. */
export function compactTools(): Tool[] {
  return [searchTool, execTool];
}

export function estimateCompactToolsTokens(): number {
  return estimateTokens(compactTools());
}

// ── Apps execution boundary ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** MCP App tools are launched through the individual endpoint, not a generic exec. */
export function appResourceUri(tool: Tool): string | null {
  const meta = tool._meta;
  if (!isRecord(meta)) return null;
  if (typeof meta['ui/resourceUri'] === 'string') return meta['ui/resourceUri'];
  const ui = meta.ui;
  if (isRecord(ui) && typeof ui.resourceUri === 'string') return ui.resourceUri;
  return null;
}

export function executionBoundaryForTool(tool: Tool): 'exec' | 'individualEndpoint' {
  return appResourceUri(tool) === null ? 'exec' : 'individualEndpoint';
}

// ── Argument validation ───────────────────────────────────────────────────

export interface SearchArgs {
  action: SearchAction;
  query?: string;
  server?: string;
  tool?: string;
  limit: number;
  cursor?: string;
  detail: SearchDetail;
}

export interface ExecArgs {
  tool: string;
  arguments: Record<string, unknown>;
  definition?: string;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

const allowedKeysByAction: Record<SearchAction, ReadonlySet<string>> = {
  servers: new Set(['action', 'limit', 'cursor']),
  find: new Set(['action', 'query', 'server', 'limit', 'detail']),
  describe: new Set(['action', 'tool']),
};

function assertNoUnknownKeys(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  action: SearchAction,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw invalidArguments(`Argument "${key}" is not valid for action "${action}"`);
    }
  }
}

export function parseSearchArgs(input: unknown): SearchArgs {
  if (!isRecord(input)) {
    throw invalidArguments('search arguments must be an object');
  }
  const actionValue = input.action;
  const action = readString(actionValue);
  if (action === null || !(SEARCH_ACTIONS as readonly string[]).includes(action)) {
    throw invalidArguments(`action must be one of ${SEARCH_ACTIONS.join(', ')}`, {
      action: actionValue,
    });
  }
  const typedAction = action as SearchAction;
  assertNoUnknownKeys(input, allowedKeysByAction[typedAction], typedAction);

  if (typedAction === 'servers') {
    const limit = parseLimit(input.limit, 20, 50);
    const cursorValue = input.cursor;
    if (cursorValue !== undefined) {
      const cursor = readString(cursorValue);
      if (cursor === null || cursor.length === 0) {
        throw invalidArguments('cursor must be a non-empty string');
      }
    }
    return {
      action: 'servers',
      limit,
      ...(cursorValue === undefined ? {} : { cursor: cursorValue as string }),
      detail: 'summary',
    };
  }

  if (typedAction === 'find') {
    const query = readString(input.query);
    if (query === null || query.trim().length === 0) {
      throw invalidArguments('query is required for action=find');
    }
    if (query.length > 512) {
      throw invalidArguments('query must be at most 512 characters', { length: query.length });
    }
    const serverValue = input.server;
    if (serverValue !== undefined) {
      const server = readString(serverValue);
      if (server === null || server.length === 0) {
        throw invalidArguments('server must be a non-empty string');
      }
    }
    const detailValue = input.detail;
    let detail: SearchDetail = 'summary';
    if (detailValue !== undefined) {
      const parsedDetail = readString(detailValue);
      if (parsedDetail === null || !(SEARCH_DETAILS as readonly string[]).includes(parsedDetail)) {
        throw invalidArguments(`detail must be one of ${SEARCH_DETAILS.join(', ')}`);
      }
      detail = parsedDetail as SearchDetail;
    }
    const maxLimit = detail === 'definition' ? 3 : 10;
    const defaultLimit = detail === 'definition' ? 3 : 5;
    const limit = parseLimit(input.limit, defaultLimit, maxLimit);
    return {
      action: 'find',
      query,
      limit,
      detail,
      ...(serverValue === undefined ? {} : { server: serverValue as string }),
    };
  }

  const tool = readString(input.tool);
  if (tool === null || tool.length === 0) {
    throw invalidArguments('tool is required for action=describe');
  }
  return { action: 'describe', tool, limit: 1, detail: 'summary' };
}

function parseLimit(value: unknown, defaultValue: number, max: number): number {
  if (value === undefined) return defaultValue;
  const limit = readInteger(value);
  if (limit === null || limit < 1 || limit > max) {
    throw invalidArguments(`limit must be an integer between 1 and ${max}`, { limit: value });
  }
  return limit;
}

export function parseExecArgs(input: unknown): ExecArgs {
  if (!isRecord(input)) {
    throw invalidArguments('exec arguments must be an object');
  }
  for (const key of Object.keys(input)) {
    if (key !== 'tool' && key !== 'arguments' && key !== 'definition') {
      throw invalidArguments(`Argument "${key}" is not valid for exec`);
    }
  }
  const tool = readString(input.tool);
  if (tool === null || tool.length === 0) {
    throw invalidArguments('tool is required for exec');
  }
  // The schema marks arguments as required; a missing field must not silently
  // become `{}` and pass an unintended no-op invocation.
  if (input.arguments === undefined || !isRecord(input.arguments)) {
    throw invalidArguments('arguments object is required for exec');
  }
  const args: Record<string, unknown> = input.arguments;
  let definition: string | undefined;
  if (input.definition !== undefined) {
    const parsed = readString(input.definition);
    if (parsed === null || parsed.length === 0) {
      throw invalidArguments('definition must be a non-empty string');
    }
    definition = parsed;
  }
  return { tool, arguments: args, ...(definition === undefined ? {} : { definition }) };
}
