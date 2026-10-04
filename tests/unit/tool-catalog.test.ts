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
      'shadcn',
    ]);
    expect(payload.total).toBe(6);
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
    const first = data(catalog.search({ action: 'servers', limit: 2 }));
    expect((first.servers as unknown[]).length).toBe(2);
    expect(typeof first.nextCursor).toBe('string');

    const second = data(
      catalog.search({ action: 'servers', limit: 2, cursor: first.nextCursor as string }),
    );
    const third = data(
      catalog.search({ action: 'servers', limit: 2, cursor: second.nextCursor as string }),
    );
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

  it('provides oversized guidance when required upstream instructions exceed the budget', () => {
    const { catalog, fixture, store } = setup();
    const snapshot = store.getSnapshot(fixture.bySlug.deepwiki!.id)!;
    store.saveSnapshot({
      ...snapshot,
      instructions: 'Required upstream constraints. '.repeat(1000),
    });
    const result = catalog.search({ action: 'describe', tool: toolId('deepwiki', 'ask_question') });
    const payload = expectError(result);
    expect(payload.code).toBe('definition_too_large');
    expect((payload.nextStep as { action: string }).action).toBe('use_full');
    expect(resultByteLength(result)).toBeLessThanOrEqual(COMPACT_BUDGETS.errorBytes);
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
