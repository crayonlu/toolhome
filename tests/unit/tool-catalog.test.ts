import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPACT_BUDGETS, resultByteLength } from '../../src/data-plane/compact-protocol.js';
import { compactContractFingerprint } from '../../src/data-plane/compact-state.js';
import { ToolProjectionService } from '../../src/data-plane/projection.js';
import {
  ToolCatalog,
  type ObservedToolLookup,
  type RankAlgorithm,
} from '../../src/data-plane/tool-catalog.js';
import { aggregateToolName } from '../../src/data-plane/virtualization.js';
import { SecretBox } from '../../src/security/secret-box.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import {
  discoveryRegressions,
  retrievalTasks,
  robustnessInputs,
  seedCompactCatalog,
  toolId,
} from '../fixtures/compact-retrieval.js';

const opened: { store: SqliteStore; directory: string }[] = [];

afterEach(() => {
  while (opened.length > 0) {
    const entry = opened.pop()!;
    entry.store.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

function setup(
  options: {
    scope?: 'host' | 'local';
    nodeId?: string;
    duplicateProvider?: boolean;
    rankAlgorithm?: RankAlgorithm;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'toolhome-compact-'));
  const store = new SqliteStore(
    join(directory, 'compact.sqlite'),
    new SecretBox('compact-test-master-key-0000000000000000000000001'),
  );
  opened.push({ store, directory });
  const fixture = seedCompactCatalog(store, { duplicateProvider: options.duplicateProvider });
  const projections = new ToolProjectionService(store);
  const catalog = new ToolCatalog(store, projections, {
    scope: options.scope ?? 'host',
    nodeId: options.nodeId,
    rankAlgorithm: options.rankAlgorithm,
  });
  const local = new ToolCatalog(store, projections, {
    scope: 'local',
    nodeId: 'laptop',
    rankAlgorithm: options.rankAlgorithm,
  });
  return { store, projections, catalog, local, fixture };
}

/** Node-hosted browser tools are only discoverable through the local entry. */
function entryFor(base: { catalog: ToolCatalog; local: ToolCatalog }, expected: string | null) {
  return expected !== null && expected.startsWith('browser_') ? base.local : base.catalog;
}

function data(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function matches(result: CallToolResult): Array<Record<string, unknown>> {
  return (data(result).matches as Array<Record<string, unknown>> | undefined) ?? [];
}

function expectError(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  return data(result);
}

describe('compact servers directory', () => {
  it('lists indexed and unindexed hosted servers, excluding disabled/hidden/foreign ones', () => {
    const { catalog } = setup();
    const result = catalog.search({ action: 'servers' });
    expect(result.isError).toBeUndefined();
    const payload = data(result);
    expect(payload.kind).toBe('servers');
    expect(payload.scope).toBe('host');
    const servers = payload.servers as Array<Record<string, unknown>>;
    expect(servers.map((server) => server.server)).toEqual([
      'context7',
      'deepwiki',
      'figma',
      'fixture-app',
      'github',
      'mosaic',
      'resend',
      'shadcn',
    ]);
    expect(payload.total).toBe(8);
    expect(servers.find((server) => server.server === 'figma')).toMatchObject({
      catalog: 'unindexed',
      visibleTools: null,
    });
    expect(servers.find((server) => server.server === 'github')).toMatchObject({
      catalog: 'indexed',
      visibleTools: 7,
      lastKnownStatus: 'unknown',
    });
    expect(resultByteLength(result)).toBeLessThanOrEqual(COMPACT_BUDGETS.serversBytes);
  });

  it('reports scope and node label for the local entry and only hosts that node', () => {
    const { catalog } = setup({ scope: 'local', nodeId: 'laptop' });
    const payload = data(catalog.search({ action: 'servers' }));
    expect(payload.scope).toBe('local');
    expect(payload.nodeLabel).toBe('laptop');
    const servers = payload.servers as Array<Record<string, unknown>>;
    expect(servers.map((server) => server.server)).toEqual(['browser']);

    const id = aggregateToolName('browser', 'take_screenshot');
    expect(matches(catalog.search({ action: 'find', query: 'take a screenshot' }))[0]!.tool).toBe(
      id,
    );
    expect(data(catalog.search({ action: 'describe', tool: id })).server).toBe('browser');
  });

  it('paginates with catalog cursors and rejects stale cursors', () => {
    const { catalog } = setup();
    const first = data(catalog.search({ action: 'servers', limit: 3 }));
    expect((first.servers as unknown[]).length).toBe(3);
    expect(typeof first.nextCursor).toBe('string');

    const second = data(
      catalog.search({ action: 'servers', limit: 3, cursor: first.nextCursor as string }),
    );
    const third = data(
      catalog.search({ action: 'servers', limit: 3, cursor: second.nextCursor as string }),
    );
    expect((third.servers as unknown[]).length).toBe(2);
    expect(third.nextCursor).toBeNull();

    const raw = JSON.parse(
      Buffer.from(first.nextCursor as string, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    raw.version = 'stale-version';
    const tampered = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url');
    const stale = catalog.search({ action: 'servers', cursor: tampered });
    expect(expectError(stale).code).toBe('invalid_cursor');
  });

  it('exposes the scope predicate', () => {
    const { catalog, fixture } = setup();
    expect(catalog.hosts(fixture.bySlug.github!)).toBe(true);
    expect(catalog.hosts(fixture.bySlug.sentry!)).toBe(false);
    expect(catalog.hosts(fixture.bySlug.browser!)).toBe(false);
  });
});

describe('compact find over labeled tasks', () => {
  it('ranks the first-use regression set first and recovers absent providers', () => {
    const base = setup();
    for (const regression of discoveryRegressions) {
      const catalog = regression.entry === 'local' ? base.local : base.catalog;
      const argumentsValue = {
        action: 'find',
        query: regression.query,
        ...(regression.server === undefined ? {} : { server: regression.server }),
      };
      const result = catalog.search(argumentsValue);
      const payload = data(result);

      if (regression.expected !== null) {
        expect(result.isError, regression.id).toBeUndefined();
        const ranked = matches(result);
        expect(ranked[0]?.tool, `${regression.id} first match`).toBe(regression.expected);
        continue;
      }

      if (regression.server !== undefined) {
        // A scoped absent provider is a deterministic error naming the choice.
        expect(result.isError, regression.id).toBe(true);
        expect(payload.code, regression.id).toBe('unknown_server');
        expect(String(payload.message), regression.id).toContain(regression.server);
        expect(payload.nextStep, regression.id).toMatchObject({
          action: 'retry_search',
          arguments: { action: 'servers' },
        });
        continue;
      }

      // An unscoped absent provider returns no unrelated tools plus recovery.
      expect(matches(result), regression.id).toEqual([]);
      expect(String(payload.guidance), regression.id).toContain(
        regression.scopedServer === undefined ? 'action=servers' : regression.scopedServer,
      );
      if (regression.scopedServer !== undefined) {
        expect(payload.scopedServer, regression.id).toBe(regression.scopedServer);
        expect(payload.unsupportedProvider, regression.id).toBeUndefined();
        continue;
      }
      if (regression.absentProvider === undefined) continue;
      expect(payload.unsupportedProvider, regression.id).toBe(regression.absentProvider);
      expect(payload.availableServers, regression.id).toContain('github');
    }
  });

  it('recovers a near-miss find in one corrected call', () => {
    const { catalog } = setup();

    const missingQuery = expectError(catalog.search({ action: 'find', limit: 5 }));
    expect(missingQuery.code).toBe('invalid_arguments');
    expect(String(missingQuery.message)).toContain('query is required');
    expect((missingQuery.nextStep as { action: string }).action).toBe('fix_arguments');

    const oversized = expectError(catalog.search({ action: 'find', query: 'bot', limit: 20 }));
    expect(String(oversized.message)).toContain('between 1 and 10');
    expect(oversized.details).toMatchObject({ maximum: 10 });

    const corrected = catalog.search({ action: 'find', query: 'list bots', limit: 10 });
    expect(matches(corrected)[0]?.tool).toBe(toolId('mosaic', 'bots_list'));
  });

  it('accepts a matching server on describe and rejects a mismatched one', () => {
    const { catalog } = setup();
    const realId = toolId('context7', 'get-library-docs');
    const withServer = data(
      catalog.search({ action: 'describe', tool: realId, server: 'context7' }),
    );
    expect(withServer.tool).toBe(realId);
    expect(withServer.server).toBe('context7');

    const mismatch = expectError(
      catalog.search({ action: 'describe', tool: realId, server: 'github' }),
    );
    expect(mismatch.code).toBe('unknown_tool');
    expect(String(mismatch.message)).toContain('belongs to server "context7"');
    expect(mismatch.nextStep).toMatchObject({
      action: 'describe',
      arguments: { action: 'describe', tool: realId },
    });
  });

  it('names available servers on an unknown server and accepts the corrected slug', () => {
    const { catalog } = setup();
    const unknown = expectError(
      catalog.search({ action: 'find', query: 'send email', server: 'cloudflare' }),
    );
    expect(unknown.code).toBe('unknown_server');
    expect(unknown.details).toMatchObject({ server: 'cloudflare' });
    const details = unknown.details as { availableServers?: string[] };
    expect(details.availableServers).toContain('resend');
    expect(String(unknown.message)).toContain('Call search with action=servers');

    const corrected = catalog.search({ action: 'find', query: 'send email', server: 'resend' });
    expect(matches(corrected)[0]?.tool).toBe(toolId('resend', 'send-email'));
  });

  it('ranks every English and rewritten task target in the top 5, top 1 for clear targets', () => {
    const base = setup();
    const targeted = retrievalTasks.filter(
      (task) => task.group === 'english' || task.group === 'chinese-rewritten',
    );
    expect(targeted.length).toBeGreaterThanOrEqual(20);

    for (const task of targeted) {
      const result = entryFor(base, task.expected).search({
        action: 'find',
        query: task.query,
      });
      expect(result.isError, task.id).toBeUndefined();
      const ranked = matches(result);
      const rank = ranked.findIndex((match) => match.tool === task.expected);
      expect(rank, `${task.id} should find its target in the top 5`).toBeGreaterThanOrEqual(0);
      expect(rank, `${task.id} should find its target in the top 5`).toBeLessThan(5);
      expect(ranked[0]!.tool, `${task.id} top-1`).toBe(task.expected);
    }
  });

  it('documents the pure-Chinese lexical limitation instead of pretending translation', () => {
    const { catalog } = setup();
    for (const task of retrievalTasks.filter((entry) => entry.group === 'chinese')) {
      expect(matches(catalog.search({ action: 'find', query: task.query })), task.id).toEqual([]);
    }
  });

  it('returns no candidates for no-answer tasks', () => {
    const { catalog } = setup();
    for (const task of retrievalTasks.filter((entry) => entry.group === 'no-answer')) {
      expect(matches(catalog.search({ action: 'find', query: task.query })), task.id).toEqual([]);
    }
  });

  it('matches robustness inputs deterministically', () => {
    const plain = setup();
    const duplicate = setup({ duplicateProvider: true });

    for (const input of robustnessInputs) {
      const base = input.requiresDuplicateProvider ? duplicate : plain;
      const result = entryFor(base, input.expected ?? null).search({
        action: 'find',
        query: input.query,
      });
      const ranked = matches(result);
      if (input.outcome === 'no-match') {
        expect(ranked, input.id).toEqual([]);
        continue;
      }
      const index = ranked.findIndex((match) => match.tool === input.expected);
      expect(index, `${input.id} expected match`).toBeGreaterThanOrEqual(0);
      expect(index, input.id).toBeLessThan(input.topK ?? 1);
    }

    const duplicateIds = matches(
      duplicate.catalog.search({ action: 'find', query: 'read wiki structure' }),
    ).map((match) => match.tool);
    expect(duplicateIds).toContain(toolId('deepwiki', 'read_wiki_structure'));
    expect(duplicateIds).toContain(toolId('deepwiki-eu', 'read_wiki_structure'));
    expect(new Set(duplicateIds).size).toBe(duplicateIds.length);
  });

  it('honours the exact identity channel for aggregate ids and original names', () => {
    const { catalog } = setup();
    const id = toolId('github', 'search_code');
    const byId = matches(catalog.search({ action: 'find', query: id }));
    expect(byId[0]!.tool).toBe(id);
    expect(byId[0]!.matchedOn).toEqual(['tool']);

    const byName = matches(catalog.search({ action: 'find', query: 'read_wiki_structure' }));
    expect(byName[0]!.tool).toBe(toolId('deepwiki', 'read_wiki_structure'));
    expect(byName[0]!.matchedOn).toEqual(['name']);
  });

  it('notes unindexed servers and rejects unknown server filters', () => {
    const { catalog } = setup();
    const unindexed = catalog.search({
      action: 'find',
      query: 'design components',
      server: 'figma',
    });
    expect(matches(unindexed)).toEqual([]);
    expect(data(unindexed).unindexedServers).toEqual(['figma']);

    const unknown = catalog.search({ action: 'find', query: 'anything', server: 'nope' });
    expect(expectError(unknown).code).toBe('unknown_server');
  });

  it('produces byte-stable, budgeted results without any network access', () => {
    const { catalog } = setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const summary = catalog.search({ action: 'find', query: 'search code across repositories' });
      const again = catalog.search({ action: 'find', query: 'search code across repositories' });
      expect(JSON.stringify(summary)).toBe(JSON.stringify(again));
      expect(data(summary).rankedBy).toBe('field-score');
      expect(resultByteLength(summary)).toBeLessThanOrEqual(COMPACT_BUDGETS.findSummaryBytes);

      const definitions = catalog.search({
        action: 'find',
        query: 'search code across repositories',
        detail: 'definition',
        limit: 3,
      });
      expect(resultByteLength(definitions)).toBeLessThanOrEqual(
        COMPACT_BUDGETS.findDefinitionBytes,
      );
      const first = matches(definitions)[0]!;
      expect(typeof first.definition).toBe('string');
      expect(first.inputSchema).toBeDefined();

      catalog.search({ action: 'servers' });
      catalog.search({ action: 'describe', tool: toolId('github', 'search_code') });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('compact describe and resolve', () => {
  it('returns a complete, fingerprinted contract with task metadata', () => {
    const { catalog } = setup();
    const id = toolId('github', 'create_issue');
    const payload = data(catalog.search({ action: 'describe', tool: id }));
    expect(payload).toMatchObject({
      kind: 'definition',
      scope: 'host',
      tool: id,
      server: 'github',
      name: 'create_issue',
      execution: 'exec',
    });
    expect(typeof payload.definition).toBe('string');
    expect((payload.inputSchema as { required: string[] }).required).toContain('title');
    expect((payload.annotations as { destructiveHint: boolean }).destructiveHint).toBe(true);
    expect(resultByteLength(catalog.search({ action: 'describe', tool: id }))).toBeLessThanOrEqual(
      COMPACT_BUDGETS.describeBytes,
    );

    const taskId = toolId('github', 'search_code');
    expect(data(catalog.search({ action: 'describe', tool: taskId })).taskSupport).toBe('optional');
    expect(
      data(catalog.search({ action: 'describe', tool: toolId('deepwiki', 'ask_question') }))
        .upstreamInstructions,
    ).toContain('DeepWiki');
  });

  it('keeps equivalent observed schemas byte-stable while preserving array order and changes', () => {
    const { catalog, fixture } = setup();
    const id = toolId('context7', 'get-library-docs');
    const schemas: Tool['inputSchema'][] = [
      {
        type: 'object',
        properties: { z: { type: 'string' }, a: { enum: ['z', 'a'], type: 'string' } },
        required: ['z', 'a'],
      },
      {
        required: ['z', 'a'],
        properties: { a: { type: 'string', enum: ['z', 'a'] }, z: { type: 'string' } },
        type: 'object',
      },
    ];
    const results = schemas.map((inputSchema) =>
      catalog.search({ action: 'describe', tool: id }, () => ({
        serverId: fixture.bySlug.context7!.id,
        tool: { name: 'get-library-docs', inputSchema },
      })),
    );
    expect(JSON.stringify(results[0])).toBe(JSON.stringify(results[1]));
    expect(data(results[1]!).inputSchema).toEqual(schemas[0]);
    const changed = catalog.search({ action: 'describe', tool: id }, () => ({
      serverId: fixture.bySlug.context7!.id,
      tool: { name: 'get-library-docs', inputSchema: { ...schemas[0]!, required: ['a', 'z'] } },
    }));
    expect(data(changed).definition).not.toBe(data(results[0]!).definition);
    expect(JSON.stringify(changed)).not.toBe(JSON.stringify(results[0]));
  });

  it('marks MCP App tools as individual-endpoint execution', () => {
    const { catalog } = setup();
    const payload = data(
      catalog.search({ action: 'describe', tool: toolId('fixture-app', 'open_dashboard') }),
    );
    expect(payload.execution).toBe('individualEndpoint');
    expect(payload.app).toEqual({ resourceUri: 'ui://fixture/dashboard' });
  });

  it('fails closed for unknown, hidden, disabled and foreign tools', () => {
    const { catalog } = setup();
    for (const tool of [
      'nope',
      toolId('github', 'delete_file'),
      toolId('memory', 'create_entities'),
      toolId('sentry', 'search_issues'),
      toolId('desktop-chrome', 'navigate_page'),
      toolId('browser', 'take_screenshot'),
    ]) {
      const payload = expectError(catalog.search({ action: 'describe', tool }));
      expect(payload.code, tool).toBe('unknown_tool');
      expect(payload.callEffect).toBe('not_started');
    }
  });

  it('prefers an exec-observed contract without touching the snapshot', () => {
    const { catalog, fixture } = setup();
    const id = toolId('context7', 'get-library-docs');
    const observedTool: Tool = {
      name: 'get-library-docs',
      description: 'OBSERVED contract from exec',
      inputSchema: { type: 'object', properties: {}, required: [] },
    };
    const observed: ObservedToolLookup = (tool) =>
      tool === id ? { serverId: fixture.bySlug.context7!.id, tool: observedTool } : undefined;

    expect(data(catalog.search({ action: 'describe', tool: id }, observed)).description).toBe(
      'OBSERVED contract from exec',
    );
    expect(catalog.resolve(id, observed).tool.description).toBe('OBSERVED contract from exec');
    expect(data(catalog.search({ action: 'describe', tool: id })).description).not.toBe(
      'OBSERVED contract from exec',
    );
  });

  it('reports definition_too_large instead of truncating a contract', () => {
    const { catalog, fixture } = setup();
    const id = toolId('github', 'create_issue');
    const huge: Tool = {
      name: 'create_issue',
      description: 'x'.repeat(20_000),
      inputSchema: { type: 'object', properties: {}, required: [] },
    };
    const observed: ObservedToolLookup = (tool) =>
      tool === id ? { serverId: fixture.bySlug.github!.id, tool: huge } : undefined;
    const payload = expectError(catalog.search({ action: 'describe', tool: id }, observed));
    expect(payload.code).toBe('definition_too_large');
    expect((payload.nextStep as { action: string }).action).toBe('use_full');
  });

  it('truncates oversized upstream instructions and marks them, keeping the contract', () => {
    const { catalog, fixture, store } = setup();
    const snapshot = store.getSnapshot(fixture.bySlug.deepwiki!.id)!;
    const oversized = 'Required upstream constraints. '.repeat(1000);
    store.saveSnapshot({ ...snapshot, instructions: oversized });
    const result = catalog.search({ action: 'describe', tool: toolId('deepwiki', 'ask_question') });
    // The argument contract is the part the caller cannot discover elsewhere, so
    // it stays complete; the instructions are cut with a marker instead of
    // failing the whole describe.
    expect(result.isError).toBeUndefined();
    const payload = data(result);
    expect(payload.kind).toBe('definition');
    expect(payload.upstreamInstructionsTruncated).toBe(true);
    expect(String(payload.upstreamInstructions).endsWith('…')).toBe(true);
    expect(String(payload.upstreamInstructions).length).toBeLessThan(oversized.length);
    expect(resultByteLength(result)).toBeLessThanOrEqual(COMPACT_BUDGETS.describeBytes);
    // The fingerprint covers the full contract, so exec's stale check is intact.
    expect(typeof payload.definition).toBe('string');
  });

  it('resolves exact encoded identities and throws for unknown ones', () => {
    const { catalog } = setup();
    const resolved = catalog.resolve(toolId('context7', 'resolve-library-id'));
    expect(resolved.entry.server.slug).toBe('context7');
    expect(resolved.tool.name).toBe('resolve-library-id');

    let thrown: unknown;
    try {
      catalog.resolve('context7_missing');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe('unknown_tool');
  });
});

describe('compact fingerprint, App boundary and BM25', () => {
  it('uses the shared compact contract fingerprint including upstream instructions', () => {
    const { catalog, fixture, store } = setup();
    const snapshot = store.getSnapshot(fixture.bySlug.deepwiki!.id)!;
    const tool = snapshot.tools.find((candidate) => candidate.name === 'ask_question')!;
    const id = toolId('deepwiki', 'ask_question');
    const expected = compactContractFingerprint(tool, snapshot.instructions ?? undefined);

    expect(data(catalog.search({ action: 'describe', tool: id })).definition).toBe(expected);
    // The upstream instructions and the complete contract both participate.
    expect(compactContractFingerprint(tool, 'different instructions')).not.toBe(expected);
    expect(
      compactContractFingerprint(
        { ...tool, description: 'changed' },
        snapshot.instructions ?? undefined,
      ),
    ).not.toBe(expected);

    const definitions = matches(
      catalog.search({
        action: 'find',
        query: 'ask a question about a repository',
        detail: 'definition',
        limit: 3,
      }),
    );
    const candidate = definitions.find((match) => match.tool === id)!;
    expect(candidate.definition).toBe(expected);
  });

  it('advertises App servers with server-wide individual-endpoint execution and guidance', () => {
    const { catalog } = setup();
    const dashboard = data(
      catalog.search({ action: 'describe', tool: toolId('fixture-app', 'open_dashboard') }),
    );
    expect(dashboard.execution).toBe('individualEndpoint');
    expect(dashboard.guidance).toBe('Use /mcp/fixture-app.');

    // A companion without its own UI metadata is still server-wide individual.
    const companion = data(
      catalog.search({ action: 'describe', tool: toolId('fixture-app', 'app_action') }),
    );
    expect(companion.execution).toBe('individualEndpoint');
    expect(companion.guidance).toBe('Use /mcp/fixture-app.');
    expect(companion.app).toBeUndefined();

    const found = matches(
      catalog.search({ action: 'find', query: 'perform an action exposed by the MCP App' }),
    ).find((match) => match.tool === toolId('fixture-app', 'app_action'))!;
    expect(found.execution).toBe('individualEndpoint');
    expect(found.guidance).toBe('Use /mcp/fixture-app.');

    const plain = data(
      catalog.search({ action: 'describe', tool: toolId('github', 'search_code') }),
    );
    expect(plain.execution).toBe('exec');
    expect(plain.guidance).toBeUndefined();
    // Exec-boundary tools carry an invocation hint so a client knows the
    // identifier is executed through the aggregate `exec` tool.
    expect(plain.via).toBe('exec');
    expect(String(plain.call)).toContain('name="exec"');

    const foundPlain = matches(
      catalog.search({ action: 'find', query: 'search code on github' }),
    ).find((match) => match.tool === toolId('github', 'search_code'))!;
    expect(foundPlain.via).toBe('exec');
    expect(foundPlain.execution).toBe('exec');
  });

  it('bounds catalog error results inside the error budget', () => {
    const { catalog } = setup();
    const unknown = catalog.search({ action: 'describe', tool: 'x'.repeat(20_000) });
    expect(expectError(unknown).code).toBe('unknown_tool');
    expect(resultByteLength(unknown)).toBeLessThanOrEqual(COMPACT_BUDGETS.errorBytes);

    const inflated = setup();
    const id = toolId('github', 'create_issue');
    const huge: Tool = {
      name: 'create_issue',
      description: 'x'.repeat(20_000),
      inputSchema: { type: 'object', properties: {}, required: [] },
    };
    const observed: ObservedToolLookup = (tool) =>
      tool === id ? { serverId: inflated.fixture.bySlug.github!.id, tool: huge } : undefined;
    const tooLarge = inflated.catalog.search({ action: 'describe', tool: id }, observed);
    expect(expectError(tooLarge).code).toBe('definition_too_large');
    expect(resultByteLength(tooLarge)).toBeLessThanOrEqual(COMPACT_BUDGETS.describeBytes);
    expect(resultByteLength(tooLarge)).toBeLessThanOrEqual(COMPACT_BUDGETS.errorBytes);
  });

  it('runs the same shipped search under BM25 and labels the choice', () => {
    const { catalog } = setup({ rankAlgorithm: 'bm25' });
    expect(catalog.rankAlgorithm).toBe('bm25');
    const result = catalog.search({ action: 'find', query: 'search code across repositories' });
    expect(data(result).rankedBy).toBe('bm25');
    expect(matches(result)[0]!.tool).toBe(toolId('github', 'search_code'));
    const again = catalog.search({ action: 'find', query: 'search code across repositories' });
    expect(JSON.stringify(result)).toBe(JSON.stringify(again));
  });

  it('keeps the coverage gate identical under BM25', () => {
    const { catalog } = setup({ rankAlgorithm: 'bm25' });
    for (const input of robustnessInputs.filter((entry) => entry.outcome === 'no-match')) {
      expect(matches(catalog.search({ action: 'find', query: input.query })), input.id).toEqual([]);
    }
    const exact = toolId('github', 'search_code');
    expect(matches(catalog.search({ action: 'find', query: exact }))[0]!.tool).toBe(exact);
  });

  it('finds at least 90% of labeled targets in the top 5 under BM25', () => {
    const base = setup({ rankAlgorithm: 'bm25' });
    const targeted = retrievalTasks.filter(
      (task) => task.group === 'english' || task.group === 'chinese-rewritten',
    );
    let hits = 0;
    for (const task of targeted) {
      const result = entryFor(base, task.expected).search({ action: 'find', query: task.query });
      const rank = matches(result).findIndex((match) => match.tool === task.expected);
      if (rank >= 0 && rank < 5) hits += 1;
    }
    expect(hits / targeted.length).toBeGreaterThanOrEqual(0.9);
  });
});

/** Mirrors the fixture's server settings; the fixture keeps its copy private. */
const settings = {
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  maxTotalTimeoutMs: 600_000,
  maxConcurrency: 1,
  restart: 'on-failure' as const,
};

describe('compact describe degradation and entry prefixes', () => {
  /** An upstream contract too large for the describe budget even bare. */
  const hugeSchema = (): Tool['inputSchema'] => ({
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `option${index}`,
        {
          type: 'object',
          description: `Tunable option block ${index}: controls a distinct behaviour of the search.`,
          properties: Object.fromEntries(
            Array.from({ length: 10 }, (_, inner) => [
              `field${inner}`,
              {
                type: 'string',
                description:
                  `Field ${inner} accepts a documented value; see the upstream reference for the full list of accepted forms and their interaction with other blocks. `.repeat(
                    2,
                  ),
              },
            ]),
          ),
        },
      ]),
    ),
    required: ['option0'],
  });

  function setupOversized(): ReturnType<typeof setup> {
    const context = setup();
    const server = context.store.createServer({
      slug: 'bigtool',
      name: 'Big Tool',
      kind: 'remote',
      nodeId: null,
      transport: {
        type: 'streamable-http',
        url: 'https://bigtool.example.test/mcp',
        protocolMode: 'modern',
        allowSseFallback: false,
        headers: {},
      },
      credentialId: null,
      enabled: true,
      settings,
    });
    const tools: Tool[] = [
      {
        name: 'mega_search',
        description:
          'Search across everything with dozens of tunable option blocks, each documented in depth upstream.',
        inputSchema: hugeSchema(),
      },
    ];
    context.store.saveSnapshot({
      serverId: server.id,
      version: 1,
      protocolVersion: '2026-07-28',
      protocolEra: 'modern',
      serverInfo: { name: 'bigtool', version: '1.0.0' },
      capabilities: { tools: { listChanged: false } },
      instructions: 'Upstream usage notes. '.repeat(60),
      tools,
      resources: [],
      resourceTemplates: [],
      prompts: [],
      listResults: {
        tools: { tools },
        resources: { resources: [] },
        resourceTemplates: { resourceTemplates: [] },
        prompts: { prompts: [] },
      },
      fingerprint: 'fixture-bigtool-v1',
      refreshedAt: '2026-10-02T10:00:00.000Z',
    });
    return context;
  }

  it('returns a shrunken definition instead of a dead end when the full one is oversized', () => {
    const { catalog } = setupOversized();
    const result = catalog.search({ action: 'describe', tool: 'bigtool_mega-5fsearch' });
    const payload = data(result);
    if (result.isError) console.log('DBG:', JSON.stringify(payload.details));

    // The complete payload was over budget: 40 blocks x 8 fields of prose.
    expect(resultByteLength(result)).toBeLessThanOrEqual(COMPACT_BUDGETS.describeBytes);
    expect(payload.kind).toBe('definition');
    expect((payload.inputSchema as Record<string, unknown>)['x-toolhome-schema']).toBe('truncated');
    // Every top-level argument survives the shrink, with its type and required list.
    const schema = payload.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toHaveLength(12);
    expect(schema.required).toEqual(['option0']);
    // The instructions are truncated with a marker, never silently dropped.
    expect(payload.upstreamInstructionsTruncated).toBe(true);
    expect(String(payload.upstreamInstructions).endsWith('…')).toBe(true);
    // The fingerprint still covers the full contract, so exec's stale check works.
    expect(typeof payload.definition).toBe('string');
  });

  it('still reports oversized when even the shrunken form cannot fit', () => {
    // A schema whose top level alone exceeds the budget: 200 required blocks.
    const { catalog, store } = setup();
    const server = store.createServer({
      slug: 'huge',
      name: 'Huge',
      kind: 'remote',
      nodeId: null,
      transport: {
        type: 'streamable-http',
        url: 'https://huge.example.test/mcp',
        protocolMode: 'modern',
        allowSseFallback: false,
        headers: {},
      },
      credentialId: null,
      enabled: true,
      settings,
    });
    const tools: Tool[] = [
      {
        name: 'everything',
        description: 'All of it.',
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 250 }, (_, index) => [
              `field${index}`,
              {
                type: 'object',
                description: `Block ${index}: `.padEnd(120, 'x'),
                properties: Object.fromEntries(
                  Array.from({ length: 10 }, (_, inner) => [
                    `f${inner}`,
                    { type: 'string', description: `Field ${inner} docs `.repeat(4) },
                  ]),
                ),
              },
            ]),
          ),
          required: Array.from({ length: 250 }, (_, index) => `field${index}`),
        },
      },
    ];
    store.saveSnapshot({
      serverId: server.id,
      version: 1,
      protocolVersion: '2026-07-28',
      protocolEra: 'modern',
      serverInfo: { name: 'huge', version: '1.0.0' },
      capabilities: { tools: { listChanged: false } },
      instructions: null,
      tools,
      resources: [],
      resourceTemplates: [],
      prompts: [],
      listResults: {
        tools: { tools },
        resources: { resources: [] },
        resourceTemplates: { resourceTemplates: [] },
        prompts: { prompts: [] },
      },
      fingerprint: 'fixture-huge-v1',
      refreshedAt: '2026-10-02T10:00:00.000Z',
    });
    const result = catalog.search({ action: 'describe', tool: 'huge_everything' });
    const payload = expectError(result);
    expect(payload.code).toBe('definition_too_large');
    expect((payload.nextStep as { action: string }).action).toBe('use_full');
  });

  it('accepts a name a multi-entry client prefixed with its own label', () => {
    const { catalog } = setupOversized();
    for (const name of [
      'bigtool_mega-5fsearch',
      'toolhome-local__bigtool_mega-5fsearch',
      'toolhome__bigtool_mega-5fsearch',
    ]) {
      const payload = data(catalog.search({ action: 'describe', tool: name }));
      expect(payload.name).toBe('mega_search');
      expect(payload.server).toBe('bigtool');
    }
    // A plain name is never mangled by the same tolerance.
    expect(
      data(catalog.search({ action: 'describe', tool: toolId('github', 'create_issue') })).server,
    ).toBe('github');
  });

  it('executes through the prefixed name', async () => {
    const { catalog } = setupOversized();
    // resolve is what tools/call uses; a prefixed id resolves to the same tool.
    const direct = catalog.resolve('bigtool_mega-5fsearch');
    const prefixed = catalog.resolve('toolhome-local__bigtool_mega-5fsearch');
    expect(prefixed.tool.name).toBe(direct.tool.name);
    expect(prefixed.entry.server.slug).toBe(direct.entry.server.slug);
  });
});
