import type { Tool } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  COMPACT_BUDGETS,
  CompactError,
  DEFAULT_RANK_ALGORITHM,
  RANK_ALGORITHM,
  SEARCH_ACTIONS,
  appResourceUri,
  compactErrorResult,
  compactTools,
  definitionTooLargeError,
  estimateCompactToolsTokens,
  estimateTokens,
  executionBoundaryForTool,
  invalidArguments,
  jsonToolResult,
  parseExecArgs,
  parseSearchArgs,
  resultByteLength,
  unknownToolError,
} from '../../src/data-plane/compact-protocol.js';

function expectInvalid(fn: () => unknown): CompactError {
  try {
    fn();
  } catch (error) {
    expect(CompactError.isInstance(error)).toBe(true);
    const compact = error as CompactError;
    expect(compact.code).toBe('invalid_arguments');
    expect(compact.nextStep.action).toBe('fix_arguments');
    expect(compact.callEffect).toBe('not_started');
    return compact;
  }
  throw new Error('expected a CompactError');
}

describe('compact protocol schemas', () => {
  it('exposes exactly the two fixed tools with stable annotations', () => {
    const tools = compactTools();
    expect(tools.map((tool) => tool.name)).toEqual(['search', 'exec']);
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
    expect(tools[1]!.annotations?.openWorldHint).toBe(true);
    expect(tools[0]!.inputSchema.required).toEqual(['action']);
    expect(tools[1]!.inputSchema.required).toEqual(['tool', 'arguments']);
  });

  it('keeps the fixed schema inside the 2k token budget', () => {
    expect(estimateCompactToolsTokens()).toBeLessThanOrEqual(COMPACT_BUDGETS.fixedSchemaTokens);
    expect(COMPACT_BUDGETS.fixedSchemaTokens).toBe(2_000);
  });

  it('labels the ranking algorithm for benchmark comparisons', () => {
    expect(RANK_ALGORITHM).toBe('field-score');
    expect(DEFAULT_RANK_ALGORITHM).toBe('field-score');
  });
});

describe('compact argument validation', () => {
  it('applies per-action defaults', () => {
    expect(parseSearchArgs({ action: 'servers' })).toEqual({
      action: 'servers',
      limit: 20,
      detail: 'summary',
    });
    expect(parseSearchArgs({ action: 'find', query: 'read repo docs' })).toEqual({
      action: 'find',
      query: 'read repo docs',
      limit: 5,
      detail: 'summary',
    });
    expect(
      parseSearchArgs({ action: 'find', query: 'read repo docs', detail: 'definition' }),
    ).toEqual({
      action: 'find',
      query: 'read repo docs',
      limit: 3,
      detail: 'definition',
    });
  });

  it('rejects unknown actions and malformed shapes', () => {
    expectInvalid(() => parseSearchArgs({ action: 'browse' }));
    expectInvalid(() => parseSearchArgs({}));
    expectInvalid(() => parseSearchArgs(null));
    expect(SEARCH_ACTIONS).toEqual(['servers', 'find', 'describe']);
  });

  it('enforces per-action argument combinations', () => {
    expectInvalid(() => parseSearchArgs({ action: 'find' }));
    expectInvalid(() => parseSearchArgs({ action: 'find', query: 'x'.repeat(513) }));
    expectInvalid(() => parseSearchArgs({ action: 'find', query: 'ok', tool: 'nope' }));
    expectInvalid(() => parseSearchArgs({ action: 'find', query: 'ok', limit: 11 }));
    expectInvalid(() =>
      parseSearchArgs({ action: 'find', query: 'ok', detail: 'definition', limit: 4 }),
    );
    expectInvalid(() => parseSearchArgs({ action: 'servers', limit: 51 }));
    expectInvalid(() => parseSearchArgs({ action: 'servers', query: 'nope' }));
    expectInvalid(() => parseSearchArgs({ action: 'describe', query: 'nope' }));
    expectInvalid(() => parseSearchArgs({ action: 'describe' }));
  });

  it('validates exec arguments and requires the arguments object', () => {
    expect(parseExecArgs({ tool: 'github_search-5fcode', arguments: {} })).toEqual({
      tool: 'github_search-5fcode',
      arguments: {},
    });
    expect(parseExecArgs({ tool: 'x', arguments: { a: 1 }, definition: 'abc' })).toEqual({
      tool: 'x',
      arguments: { a: 1 },
      definition: 'abc',
    });
    expectInvalid(() => parseExecArgs({}));
    // The schema marks arguments required; a missing field must not become `{}`.
    expectInvalid(() => parseExecArgs({ tool: 'x' }));
    expectInvalid(() => parseExecArgs({ tool: 'x', arguments: [] }));
    expectInvalid(() => parseExecArgs({ tool: 'x', arguments: null }));
    expectInvalid(() => parseExecArgs({ tool: 'x', guessed: true }));
    expectInvalid(() => parseExecArgs({ tool: 'x', arguments: {}, definition: '' }));
  });
});

describe('CompactError', () => {
  it('carries a machine-readable nextStep and callEffect', () => {
    const error = unknownToolError('deepwiki_missing');
    const data = error.toData();
    expect(data).toMatchObject({
      kind: 'error',
      code: 'unknown_tool',
      source: 'gateway',
      callEffect: 'not_started',
      nextStep: { action: 'retry_search' },
    });
    expect(data.details).toEqual({ tool: 'deepwiki_missing' });
  });

  it('classifies submitted/continuation failures as may_have_run', () => {
    const error = new CompactError('continuation_rejected', 'stale signature');
    expect(error.callEffect).toBe('may_have_run');
    expect(error.nextStep.action).toBe('check_status');

    const mismatch = new CompactError('definition_changed', 'headers mismatch');
    expect(mismatch.callEffect).toBe('not_started');
    expect(mismatch.nextStep.action).toBe('describe');
  });

  it('points oversized definitions at the original entry', () => {
    const error = definitionTooLargeError({ bytes: 20_000, budget: 16_384 });
    expect(error.nextStep.action).toBe('use_full');
    expect(error.toData().details).toMatchObject({ bytes: 20_000 });
  });

  it('renders a machine-readable isError result', () => {
    const result = compactErrorResult(invalidArguments('bad action'));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      kind: 'error',
      code: 'invalid_arguments',
      nextStep: { action: 'fix_arguments' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });

  it('bounds oversized error results inside the error budget', () => {
    const huge = 'x'.repeat(20_000);
    const result = compactErrorResult(unknownToolError(`Unknown tool: ${huge}`));
    expect(resultByteLength(result)).toBeLessThanOrEqual(COMPACT_BUDGETS.errorBytes);
    expect(result.structuredContent).toMatchObject({ kind: 'error', code: 'unknown_tool' });

    const withDetails = compactErrorResult(
      new CompactError('catalog_unavailable', 'boom', { details: { reason: huge } }),
    );
    expect(resultByteLength(withDetails)).toBeLessThanOrEqual(COMPACT_BUDGETS.errorBytes);
  });
});

describe('apps execution boundary', () => {
  const base: Tool = {
    name: 'plain',
    description: 'A plain tool',
    inputSchema: { type: 'object' },
  };

  it('routes MCP App tools to the individual endpoint', () => {
    const app: Tool = {
      ...base,
      name: 'open_dashboard',
      _meta: { ui: { resourceUri: 'ui://fixture/dashboard' } },
    };
    expect(appResourceUri(app)).toBe('ui://fixture/dashboard');
    expect(executionBoundaryForTool(app)).toBe('individualEndpoint');
    expect(executionBoundaryForTool(base)).toBe('exec');
    expect(appResourceUri(base)).toBeNull();
  });
});

describe('result measurement', () => {
  it('counts the complete MCP package and estimates tokens deterministically', () => {
    const payload = { kind: 'servers', servers: [] };
    const result = jsonToolResult(payload);
    expect(result.structuredContent).toEqual(payload);
    expect(resultByteLength(result)).toBe(Buffer.byteLength(JSON.stringify(result), 'utf8'));
    expect(estimateTokens(payload)).toBe(
      Math.ceil(Buffer.byteLength(JSON.stringify(payload), 'utf8') / 4),
    );
  });
});
