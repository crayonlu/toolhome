import type { Tool } from '@modelcontextprotocol/server';
import { aggregateToolName } from '../../src/data-plane/virtualization.js';
import type { CapabilitySnapshot, ServerRecord } from '../../src/domain/models.js';
import type { Store } from '../../src/storage/store.js';

/**
 * Deterministic compact-retrieval corpus.
 *
 * Server slugs, names and tool contracts mirror real public upstreams already
 * present in the market catalog (github, context7, deepwiki) or referenced by
 * existing fixtures/docs (shadcn registries, chrome-devtools browser). No
 * upstream is contacted: everything is stored as capability snapshots so tests
 * exercise the shipped snapshot-only catalog. The task labels describe which
 * exact tool a human would pick; a pure-Chinese label is deliberately `null`
 * because the v1 lexical ranker does not translate Chinese (see the plan).
 */

const settings = {
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  maxTotalTimeoutMs: 600_000,
  maxConcurrency: 1,
  restart: 'on-failure' as const,
};

interface FixtureServerSpec {
  slug: string;
  name: string;
  kind: 'remote' | 'home' | 'node';
  nodeId: string | null;
  enabled: boolean;
  indexed: boolean;
  instructions: string | null;
  defaultVisibility?: 'visible' | 'hidden';
  hiddenTools?: string[];
  tools: Tool[];
}

const toolId = (slug: string, name: string): string => aggregateToolName(slug, name);

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Tool['inputSchema'] {
  return {
    type: 'object',
    properties: properties as Tool['inputSchema']['properties'],
    required,
    additionalProperties: false,
  };
}

function tool(
  name: string,
  description: string,
  inputSchema: Tool['inputSchema'],
  extra: Partial<Pick<Tool, 'annotations' | 'execution' | '_meta' | 'title'>> = {},
): Tool {
  return { name, description, inputSchema, ...extra };
}

const deepwikiTools: Tool[] = [
  tool(
    'read_wiki_structure',
    'Get the documentation structure for a GitHub repository, listing its main topics and pages.',
    objectSchema({ repoName: { type: 'string', description: 'Repository in owner/name form' } }, [
      'repoName',
    ]),
  ),
  tool(
    'read_wiki_contents',
    'View documentation contents for a GitHub repository.',
    objectSchema({ repoName: { type: 'string' } }, ['repoName']),
  ),
  tool(
    'ask_question',
    'Ask a question about a GitHub repository and get an AI-powered, context-grounded answer.',
    objectSchema({ repoName: { type: 'string' }, question: { type: 'string' } }, [
      'repoName',
      'question',
    ]),
  ),
];

const githubTools: Tool[] = [
  tool(
    'search_repositories',
    'Search GitHub repositories by keyword or qualifier.',
    objectSchema(
      { query: { type: 'string' }, page: { type: 'integer' }, perPage: { type: 'integer' } },
      ['query'],
    ),
  ),
  tool(
    'get_file_contents',
    'Get the contents of a file from a GitHub repository.',
    objectSchema(
      {
        owner: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string' },
        branch: { type: 'string' },
      },
      ['owner', 'repo', 'path'],
    ),
  ),
  tool(
    'search_code',
    'Search code across GitHub repositories.',
    objectSchema(
      { query: { type: 'string' }, page: { type: 'integer' }, perPage: { type: 'integer' } },
      ['query'],
    ),
    { execution: { taskSupport: 'optional' } },
  ),
  tool(
    'list_issues',
    'List issues in a GitHub repository, optionally filtered by state or labels.',
    objectSchema(
      {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
        labels: { type: 'array' },
        perPage: { type: 'integer' },
      },
      ['owner', 'repo'],
    ),
  ),
  tool(
    'create_issue',
    'Create a new issue in a GitHub repository.',
    objectSchema(
      {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array' },
        assignees: { type: 'array' },
      },
      ['owner', 'repo', 'title'],
    ),
    { annotations: { destructiveHint: true } },
  ),
  tool(
    'create_pull_request',
    'Open a new pull request in a GitHub repository.',
    objectSchema(
      {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
    { annotations: { destructiveHint: false, idempotentHint: false } },
  ),
  tool(
    'list_branches',
    'List branches in a GitHub repository.',
    objectSchema(
      { owner: { type: 'string' }, repo: { type: 'string' }, page: { type: 'integer' } },
      ['owner', 'repo'],
    ),
  ),
  tool(
    'delete_file',
    'Delete a file from a GitHub repository.',
    objectSchema(
      {
        owner: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string' },
        message: { type: 'string' },
        branch: { type: 'string' },
        sha: { type: 'string' },
      },
      ['owner', 'repo', 'path', 'message', 'sha'],
    ),
    { annotations: { destructiveHint: true } },
  ),
];

const shadcnTools: Tool[] = [
  tool(
    'get_project_registries',
    'Get the registries configured for the current shadcn project.',
    objectSchema({}),
  ),
  tool(
    'list_items_in_registries',
    'List items available in the given shadcn registries.',
    objectSchema({ registries: { type: 'array' }, limit: { type: 'integer' } }, ['registries']),
  ),
  tool(
    'search_items_in_registries',
    'Search items in shadcn registries by query.',
    objectSchema(
      { registries: { type: 'array' }, query: { type: 'string' }, limit: { type: 'integer' } },
      ['registries', 'query'],
    ),
  ),
  tool(
    'view_items_in_registries',
    'View detailed information for specific registry items.',
    objectSchema({ items: { type: 'array' } }, ['items']),
  ),
  tool(
    'get_item_examples_from_registries',
    'Find usage examples for registry items.',
    objectSchema({ registries: { type: 'array' }, query: { type: 'string' } }, [
      'registries',
      'query',
    ]),
  ),
  tool(
    'get_add_command_for_items',
    'Get the add command for registry items so they can be installed.',
    objectSchema({ items: { type: 'array' } }, ['items']),
  ),
  tool(
    'get_audit_checklist',
    'Return a checklist for auditing a shadcn project.',
    objectSchema({}),
  ),
];

const context7Tools: Tool[] = [
  tool(
    'resolve-library-id',
    'Resolve a library name to a Context7-compatible library id.',
    objectSchema({ libraryName: { type: 'string' }, query: { type: 'string' } }, ['libraryName']),
  ),
  tool(
    'get-library-docs',
    'Retrieves up-to-date documentation for a library by its Context7 id.',
    objectSchema(
      {
        context7CompatibleLibraryID: { type: 'string' },
        topic: { type: 'string' },
        tokens: { type: 'integer' },
      },
      ['context7CompatibleLibraryID'],
    ),
  ),
];

const browserTools: Tool[] = [
  tool(
    'navigate_page',
    'Navigate the page to a URL.',
    objectSchema(
      { url: { type: 'string' }, type: { type: 'string' }, timeout: { type: 'integer' } },
      ['url'],
    ),
  ),
  tool('take_snapshot', 'Take an accessibility snapshot of the page.', objectSchema({})),
  tool(
    'take_screenshot',
    'Take a screenshot of the page.',
    objectSchema({ format: { type: 'string' }, fullPage: { type: 'boolean' } }),
  ),
  tool(
    'evaluate_script',
    'Evaluate a custom JavaScript function in the page.',
    objectSchema({ function: { type: 'string' } }, ['function']),
  ),
  tool('list_pages', 'List open pages in the browser.', objectSchema({})),
  tool('list_console_messages', 'List console messages from the page.', objectSchema({})),
  tool(
    'list_network_requests',
    'List network requests made by the page.',
    objectSchema({
      pageIdx: { type: 'integer' },
      type: { type: 'string' },
      pageSize: { type: 'integer' },
    }),
  ),
  tool(
    'fill',
    'Fill an input or textarea with a value.',
    objectSchema({ uid: { type: 'string' }, value: { type: 'string' } }, ['uid', 'value']),
  ),
  tool(
    'type_text',
    'Type text via the keyboard into the focused element.',
    objectSchema({ text: { type: 'string' } }, ['text']),
  ),
  tool(
    'click',
    'Click the element with the given uid.',
    objectSchema({ uid: { type: 'string' } }, ['uid']),
  ),
  tool(
    'wait_for',
    'Wait for text to appear on the page.',
    objectSchema({ text: { type: 'string' }, timeout: { type: 'integer' } }, ['text']),
  ),
  tool(
    'performance_start_trace',
    'Start a performance trace of the page.',
    objectSchema({ reload: { type: 'boolean' }, autoStop: { type: 'boolean' } }),
  ),
  tool('performance_stop_trace', 'Stop the current performance trace.', objectSchema({})),
];

const appTools: Tool[] = [
  tool('open_dashboard', 'Open the fixture MCP App dashboard.', objectSchema({}), {
    _meta: {
      ui: { resourceUri: 'ui://fixture/dashboard' },
      'ui/resourceUri': 'ui://fixture/dashboard',
    },
  }),
  // Companion action without its own UI metadata: the server is still App-wide.
  tool('app_action', 'Perform an action exposed by the fixture MCP App.', objectSchema({})),
];

const duplicateProviderTools: Tool[] = [
  tool(
    'read_wiki_structure',
    'Get the documentation structure for a GitHub repository, listing its main topics and pages.',
    objectSchema({ repoName: { type: 'string' } }, ['repoName']),
  ),
];

function serverSpecs(includeDuplicateProvider: boolean): FixtureServerSpec[] {
  const specs: FixtureServerSpec[] = [
    {
      slug: 'deepwiki',
      name: 'DeepWiki',
      kind: 'remote',
      nodeId: null,
      enabled: true,
      indexed: true,
      instructions: 'DeepWiki answers questions about GitHub repositories.',
      tools: deepwikiTools,
    },
    {
      slug: 'github',
      name: 'GitHub',
      kind: 'remote',
      nodeId: null,
      enabled: true,
      indexed: true,
      instructions: 'GitHub MCP server for repositories, issues and pull requests.',
      hiddenTools: ['delete_file'],
      tools: githubTools,
    },
    {
      slug: 'shadcn',
      name: 'shadcn/ui',
      kind: 'remote',
      nodeId: null,
      enabled: true,
      indexed: true,
      instructions: 'shadcn registry browser.',
      tools: shadcnTools,
    },
    {
      slug: 'context7',
      name: 'Context7',
      kind: 'remote',
      nodeId: null,
      enabled: true,
      indexed: true,
      instructions: 'Context7 library documentation.',
      tools: context7Tools,
    },
    {
      slug: 'browser',
      name: 'Chrome DevTools',
      kind: 'node',
      nodeId: 'laptop',
      enabled: true,
      indexed: true,
      instructions: 'Drive the local Chrome browser.',
      tools: browserTools,
    },
    {
      slug: 'fixture-app',
      name: 'Fixture App',
      kind: 'remote',
      nodeId: null,
      enabled: true,
      indexed: true,
      instructions: null,
      tools: appTools,
    },
    {
      slug: 'figma',
      name: 'Figma',
      kind: 'remote',
      nodeId: null,
      enabled: true,
      indexed: false,
      instructions: null,
      tools: [],
    },
    {
      slug: 'sentry',
      name: 'Sentry',
      kind: 'remote',
      nodeId: null,
      enabled: false,
      indexed: true,
      instructions: null,
      tools: [
        tool('search_issues', 'Search Sentry issues.', objectSchema({ query: { type: 'string' } })),
      ],
    },
    {
      slug: 'memory',
      name: 'Memory',
      kind: 'remote',
      nodeId: null,
      enabled: true,
      indexed: true,
      instructions: null,
      defaultVisibility: 'hidden',
      tools: [
        tool(
          'create_entities',
          'Create entities in the knowledge graph memory.',
          objectSchema({ entities: { type: 'array' } }, ['entities']),
        ),
      ],
    },
    {
      slug: 'desktop-chrome',
      name: 'Desktop Chrome',
      kind: 'node',
      nodeId: 'desktop',
      enabled: true,
      indexed: true,
      instructions: null,
      tools: [
        tool(
          'navigate_page',
          'Navigate the page to a URL.',
          objectSchema({ url: { type: 'string' } }, ['url']),
        ),
      ],
    },
  ];
  if (includeDuplicateProvider) {
    specs.push({
      slug: 'deepwiki-eu',
      name: 'DeepWiki (EU)',
      kind: 'remote',
      nodeId: null,
      enabled: true,
      indexed: true,
      instructions: null,
      tools: duplicateProviderTools,
    });
  }
  return specs;
}

function snapshotFor(server: ServerRecord, spec: FixtureServerSpec): CapabilitySnapshot {
  const tools = spec.tools;
  return {
    serverId: server.id,
    version: 1,
    protocolVersion: '2026-07-28',
    protocolEra: 'modern',
    serverInfo: { name: spec.slug, version: '1.0.0' },
    capabilities: { tools: { listChanged: false } },
    instructions: spec.instructions,
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
    fingerprint: `fixture-${spec.slug}-v1`,
    refreshedAt: '2026-10-02T10:00:00.000Z',
  };
}

export interface CompactFixture {
  bySlug: Record<string, ServerRecord>;
  /** Visible tool count per indexed server (null when unindexed). */
  visibleTools: Record<string, number | null>;
}

/**
 * Populate a Store with the deterministic corpus. Projections (hidden delete_file,
 * fully hidden memory server) are written here so catalog tests do not mutate
 * shared state.
 */
export function seedCompactCatalog(
  store: Store,
  options: { duplicateProvider?: boolean } = {},
): CompactFixture {
  const bySlug: Record<string, ServerRecord> = {};
  const visibleTools: Record<string, number | null> = {};
  for (const spec of serverSpecs(options.duplicateProvider ?? false)) {
    const server = store.createServer({
      slug: spec.slug,
      name: spec.name,
      kind: spec.kind,
      nodeId: spec.nodeId,
      transport:
        spec.kind === 'remote'
          ? {
              type: 'streamable-http',
              url: `https://${spec.slug}.example.test/mcp`,
              protocolMode: 'modern',
              allowSseFallback: false,
              headers: {},
            }
          : {
              type: 'stdio',
              command: 'node',
              args: [],
              env: {},
              protocolMode: 'auto',
            },
      credentialId: null,
      enabled: spec.enabled,
      settings,
    });
    bySlug[spec.slug] = server;
    if (spec.indexed) {
      store.saveSnapshot(snapshotFor(server, spec));
      visibleTools[spec.slug] = spec.defaultVisibility === 'hidden' ? 0 : spec.tools.length;
    } else {
      visibleTools[spec.slug] = null;
    }
    if (spec.defaultVisibility !== undefined) {
      store.setServerProjection(server.id, spec.defaultVisibility);
    }
    for (const hidden of spec.hiddenTools ?? []) {
      store.setToolProjection(server.id, hidden, 'hidden');
      visibleTools[spec.slug] = (visibleTools[spec.slug] ?? spec.tools.length) - 1;
    }
  }
  return { bySlug, visibleTools };
}

// ── Labeled retrieval tasks ───────────────────────────────────────────────

export type RetrievalGroup = 'english' | 'chinese' | 'chinese-rewritten' | 'no-answer';

export interface RetrievalTask {
  id: string;
  query: string;
  /** Exact aggregate tool id a human would pick, or null when no tool applies. */
  expected: string | null;
  group: RetrievalGroup;
  note: string;
}

export const retrievalTasks: RetrievalTask[] = [
  {
    id: 'english-read-structure',
    query: 'read React repository documentation structure',
    expected: toolId('deepwiki', 'read_wiki_structure'),
    group: 'english',
    note: 'DeepWiki structure wins over contents because of "structure".',
  },
  {
    id: 'english-view-contents',
    query: 'view documentation contents for a repository',
    expected: toolId('deepwiki', 'read_wiki_contents'),
    group: 'english',
    note: '"view" and "contents" point at read_wiki_contents.',
  },
  {
    id: 'english-ask-question',
    query: 'ask a question about a GitHub repository',
    expected: toolId('deepwiki', 'ask_question'),
    group: 'english',
    note: 'Question answering on a repository.',
  },
  {
    id: 'english-search-repos',
    query: 'search GitHub repositories by keyword',
    expected: toolId('github', 'search_repositories'),
    group: 'english',
    note: 'Repository search, not code search.',
  },
  {
    id: 'english-get-file',
    query: 'get file contents from a repository',
    expected: toolId('github', 'get_file_contents'),
    group: 'english',
    note: 'Single-file read.',
  },
  {
    id: 'english-search-code',
    query: 'search code across repositories',
    expected: toolId('github', 'search_code'),
    group: 'english',
    note: 'Code search beats repository search on "code" and "across".',
  },
  {
    id: 'english-list-issues',
    query: 'list open issues in a repository',
    expected: toolId('github', 'list_issues'),
    group: 'english',
    note: 'List vs create issue.',
  },
  {
    id: 'english-create-issue',
    query: 'create a new issue in a repository',
    expected: toolId('github', 'create_issue'),
    group: 'english',
    note: 'Write action; "new" is non-discriminating.',
  },
  {
    id: 'english-open-pr',
    query: 'open a pull request',
    expected: toolId('github', 'create_pull_request'),
    group: 'english',
    note: 'Opening a PR maps to create_pull_request.',
  },
  {
    id: 'english-list-branches',
    query: 'list branches in a repository',
    expected: toolId('github', 'list_branches'),
    group: 'english',
    note: 'Branch listing.',
  },
  {
    id: 'english-shadcn-search',
    query: 'search shadcn registry items',
    expected: toolId('shadcn', 'search_items_in_registries'),
    group: 'english',
    note: 'Provider name plus registry items.',
  },
  {
    id: 'english-shadcn-add',
    query: 'get the add command for registry items',
    expected: toolId('shadcn', 'get_add_command_for_items'),
    group: 'english',
    note: 'Install command helper.',
  },
  {
    id: 'english-context7-resolve',
    query: 'resolve a library id with context7',
    expected: toolId('context7', 'resolve-library-id'),
    group: 'english',
    note: 'Resolve-library-id.',
  },
  {
    id: 'english-context7-docs',
    query: 'get up to date library documentation',
    expected: toolId('context7', 'get-library-docs'),
    group: 'english',
    note: 'Library docs fetching.',
  },
  {
    id: 'english-browser-navigate',
    query: 'navigate the browser to a url',
    expected: toolId('browser', 'navigate_page'),
    group: 'english',
    note: 'Browser navigation.',
  },
  {
    id: 'english-browser-screenshot',
    query: 'take a screenshot of the page',
    expected: toolId('browser', 'take_screenshot'),
    group: 'english',
    note: 'Screenshot capture.',
  },
  {
    id: 'english-browser-console',
    query: 'list browser console messages',
    expected: toolId('browser', 'list_console_messages'),
    group: 'english',
    note: 'Console message listing.',
  },
  {
    id: 'english-browser-script',
    query: 'run a custom script in the page',
    expected: toolId('browser', 'evaluate_script'),
    group: 'english',
    note: 'Script evaluation on the page.',
  },
  {
    id: 'chinese-read-structure',
    query: '读取仓库的文档结构',
    expected: null,
    group: 'chinese',
    note: 'Pure Chinese is not translated by the v1 lexical ranker; reported as a limitation.',
  },
  {
    id: 'chinese-search-code',
    query: '搜索代码仓库',
    expected: null,
    group: 'chinese',
    note: 'Pure Chinese no-match, paired with its rewritten form.',
  },
  {
    id: 'chinese-add-command',
    query: '获取组件库的使用命令',
    expected: null,
    group: 'chinese',
    note: 'Pure Chinese no-match, paired with its rewritten form.',
  },
  {
    id: 'chinese-screenshot',
    query: '浏览器截取网页截图',
    expected: null,
    group: 'chinese',
    note: 'Pure Chinese no-match, paired with its rewritten form.',
  },
  {
    id: 'rewritten-read-structure',
    query: 'read repository documentation structure',
    expected: toolId('deepwiki', 'read_wiki_structure'),
    group: 'chinese-rewritten',
    note: 'Agent rewrite of 读取仓库的文档结构.',
  },
  {
    id: 'rewritten-search-code',
    query: 'search code in repository',
    expected: toolId('github', 'search_code'),
    group: 'chinese-rewritten',
    note: 'Agent rewrite of 搜索代码仓库.',
  },
  {
    id: 'rewritten-add-command',
    query: 'list registry component add command',
    expected: toolId('shadcn', 'get_add_command_for_items'),
    group: 'chinese-rewritten',
    note: 'Agent rewrite of 获取组件库的使用命令.',
  },
  {
    id: 'rewritten-screenshot',
    query: 'browser take screenshot',
    expected: toolId('browser', 'take_screenshot'),
    group: 'chinese-rewritten',
    note: 'Agent rewrite of 浏览器截取网页截图.',
  },
  {
    id: 'no-answer-dentist',
    query: 'schedule a dentist appointment',
    expected: null,
    group: 'no-answer',
    note: 'No tool overlap.',
  },
  {
    id: 'no-answer-flight',
    query: 'book a flight to Tokyo',
    expected: null,
    group: 'no-answer',
    note: 'No tool overlap.',
  },
];

// ── Robustness inputs ─────────────────────────────────────────────────────

export interface RobustnessInput {
  id: string;
  query: string;
  outcome: 'match' | 'no-match';
  /** Exact aggregate id required within topK when outcome is 'match'. */
  expected?: string;
  topK?: number;
  /** Requires a seeded duplicate provider (two servers exposing one tool name). */
  requiresDuplicateProvider?: boolean;
  note: string;
}

const longNoiseQuery = [
  'repositories',
  ...Array.from({ length: 40 }, (_, i) => `noise${i}token`),
].join(' ');

export const robustnessInputs: RobustnessInput[] = [
  {
    id: 'duplicate-query-words',
    query: 'search search repositories repositories repositories',
    outcome: 'match',
    expected: toolId('github', 'search_repositories'),
    topK: 1,
    note: 'Repeated query tokens are deduped and must not change coverage or rank.',
  },
  {
    id: 'stopwords-only',
    query: 'the and for with a',
    outcome: 'no-match',
    note: 'Zero meaningful tokens returns no candidates instead of the whole directory.',
  },
  {
    id: 'single-word',
    query: 'screenshot',
    outcome: 'match',
    expected: toolId('browser', 'take_screenshot'),
    topK: 1,
    note: 'A single meaningful token must hit.',
  },
  {
    id: 'no-overlap',
    query: 'quantum chromodynamics lattice gauge',
    outcome: 'no-match',
    note: 'No token overlaps any indexed field.',
  },
  {
    id: 'provider-only-overlap',
    query: 'shadcn context7',
    outcome: 'no-match',
    note: 'Two provider names alone do not satisfy the multi-word coverage gate.',
  },
  {
    id: 'long-query-single-common-word',
    query: longNoiseQuery,
    outcome: 'no-match',
    note: 'A long query with one common word must be rejected, not ranked by noise.',
  },
  {
    id: 'same-name-across-providers',
    query: 'read wiki structure',
    outcome: 'match',
    expected: toolId('deepwiki', 'read_wiki_structure'),
    topK: 2,
    requiresDuplicateProvider: true,
    note: 'Duplicate tool names stay distinct candidates instead of being merged.',
  },
];

export { toolId };
