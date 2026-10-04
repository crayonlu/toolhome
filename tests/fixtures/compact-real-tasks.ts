import { aggregateToolName } from '../../src/data-plane/virtualization.js';

/**
 * Semantically labeled retrieval tasks for the real read-only production
 * catalogs (`real-host-catalog.json`, `real-local-catalog.json`).
 *
 * Expected ids are the exact aggregate tool ids the shipped gateway exposes
 * (`aggregateToolName`). `server`/`tool` carry the upstream identity so the
 * labels can be re-verified against the actual catalog: they are identifiers,
 * not query text, and no `query` reproduces its expected id.
 *
 * `split: 'heldout'` marks additional first-pass queries never used to adjust
 * main-path wording. `group: 'chinese'` retains actual target labels so lexical
 * misses are reported separately from `chinese-rewritten` English queries.
 */

export type RealGroup = 'english' | 'chinese' | 'chinese-rewritten' | 'no-answer';

export interface RealTask {
  id: string;
  query: string;
  expected: string | null;
  group: RealGroup;
  /** Upstream server slug the label points at (empty for null labels). */
  server: string;
  /** Upstream tool name the label points at (empty for null labels). */
  tool: string;
  split?: 'main' | 'heldout';
  note: string;
}

export interface RealRobustness {
  id: string;
  query: string;
  outcome: 'match' | 'no-match';
  expected?: string;
  topK?: number;
  note: string;
}

const id = (slug: string, tool: string): string => aggregateToolName(slug, tool);
const label = (
  taskId: string,
  query: string,
  slug: string,
  tool: string,
  note: string,
  split: RealTask['split'] = 'main',
): RealTask => ({
  id: taskId,
  query,
  expected: id(slug, tool),
  group: 'english',
  server: slug,
  tool,
  split,
  note,
});
const chinese = (taskId: string, query: string, slug: string, tool: string): RealTask => ({
  ...label(taskId, query, slug, tool, 'Chinese original; v1 lexical ranker does not translate.'),
  group: 'chinese',
});
const rewrite = (
  taskId: string,
  query: string,
  slug: string,
  tool: string,
  note: string,
): RealTask => ({
  id: taskId,
  query,
  expected: id(slug, tool),
  group: 'chinese-rewritten',
  server: slug,
  tool,
  split: 'main',
  note,
});

/** 25 main English labels across DeepWiki, Context7, Firecrawl, GitHub, Resend, Tavily. */
export const realHostTasks: RealTask[] = [
  label(
    'real-deepwiki-structure',
    'list the documentation topics for a github repository',
    'deepwiki',
    'read_wiki_structure',
    'DeepWiki structure (topics).',
  ),
  label(
    'real-deepwiki-contents',
    'view the documentation contents for a github repository',
    'deepwiki',
    'read_wiki_contents',
    'DeepWiki contents vs structure.',
  ),
  label(
    'real-deepwiki-ask',
    'ask a question about a repository codebase',
    'deepwiki',
    'ask_wiki_question',
    'DeepWiki question answering.',
  ),
  label(
    'real-context7-resolve',
    'resolve a package name to a context7 library id',
    'context7',
    'resolve-library-id',
    'Context7 id resolution.',
  ),
  label(
    'real-context7-docs',
    'retrieve up-to-date documentation and code examples for a library',
    'context7',
    'query-docs',
    'Context7 docs query.',
  ),
  label(
    'real-firecrawl-scrape',
    'scrape a single url and return its markdown content',
    'firecrawl',
    'firecrawl_scrape',
    'Firecrawl single-page scrape.',
  ),
  label(
    'real-firecrawl-map',
    'enumerate urls indexed under a website',
    'firecrawl',
    'firecrawl_map',
    'Firecrawl site map.',
  ),
  label(
    'real-firecrawl-search',
    'search the web and return ranked results with highlights',
    'firecrawl',
    'firecrawl_search',
    'Firecrawl web search.',
  ),
  label(
    'real-firecrawl-crawl',
    'start a multi-page crawl at a website url',
    'firecrawl',
    'firecrawl_crawl',
    'Firecrawl multi-page crawl.',
  ),
  label(
    'real-firecrawl-check-crawl',
    'check the status of an existing crawl job',
    'firecrawl',
    'firecrawl_check_crawl_status',
    'Firecrawl crawl status.',
  ),
  label(
    'real-firecrawl-developer-search',
    'search public repositories and github issues for code',
    'firecrawl',
    'firecrawl_developer_search',
    'Firecrawl developer index search.',
  ),
  label(
    'real-firecrawl-credit-usage',
    'get the firecrawl team credit balance',
    'firecrawl',
    'firecrawl_credit_usage',
    'Firecrawl account credits.',
  ),
  label(
    'real-github-search-code',
    'search code across all github repositories',
    'github',
    'search_code',
    'GitHub code search.',
  ),
  label(
    'real-github-search-repos',
    'find github repositories by name and topics',
    'github',
    'search_repositories',
    'GitHub repository search.',
  ),
  label(
    'real-github-get-file',
    'get the contents of a file from a github repository',
    'github',
    'get_file_contents',
    'GitHub file read.',
  ),
  label(
    'real-github-list-issues',
    'list issues in a github repository',
    'github',
    'list_issues',
    'GitHub issue listing.',
  ),
  label(
    'real-github-create-pr',
    'create a new pull request in a github repository',
    'github',
    'create_pull_request',
    'GitHub PR creation.',
  ),
  label(
    'real-github-list-branches',
    'list branches in a github repository',
    'github',
    'list_branches',
    'GitHub branch listing.',
  ),
  label(
    'real-github-search-users',
    'find github users by username or real name',
    'github',
    'search_users',
    'GitHub user search.',
  ),
  label(
    'real-github-latest-release',
    'get the latest release in a github repository',
    'github',
    'get_latest_release',
    'GitHub release lookup.',
  ),
  label(
    'real-resend-send-email',
    'send a transactional email to a recipient',
    'resend',
    'send-email',
    'Resend transactional send.',
  ),
  label(
    'real-resend-list-contacts',
    'list contacts from resend',
    'resend',
    'list-contacts',
    'Resend contact listing.',
  ),
  label(
    'real-resend-create-domain',
    'create a new email domain in resend',
    'resend',
    'create-domain',
    'Resend domain creation.',
  ),
  label(
    'real-tavily-search',
    'search the web for current information on a topic',
    'tavily',
    'tavily_search',
    'Tavily web search.',
  ),
  label(
    'real-tavily-extract',
    'extract content from urls as markdown',
    'tavily',
    'tavily_extract',
    'Tavily URL extraction.',
  ),
];

/** Four labeled Chinese originals paired with concrete English rewrites. */
export const realHostChinesePairing: RealTask[] = [
  chinese('real-zh-structure', '读取仓库的文档主题列表', 'deepwiki', 'read_wiki_structure'),
  rewrite(
    'real-rewritten-structure',
    'list github repository documentation topics',
    'deepwiki',
    'read_wiki_structure',
    'Rewrite of real-zh-structure.',
  ),
  chinese('real-zh-code', '搜索代码仓库', 'github', 'search_code'),
  rewrite(
    'real-rewritten-code',
    'search code repositories for a term',
    'github',
    'search_code',
    'Rewrite of real-zh-code.',
  ),
  chinese('real-zh-domain', '创建一个新的邮件域名', 'resend', 'create-domain'),
  rewrite(
    'real-rewritten-domain',
    'create a new email domain',
    'resend',
    'create-domain',
    'Rewrite of real-zh-domain.',
  ),
  chinese('real-zh-websearch', '搜索网络上的最新信息', 'tavily', 'tavily_search'),
  rewrite(
    'real-rewritten-websearch',
    'search the web for current information',
    'tavily',
    'tavily_search',
    'Rewrite of real-zh-websearch.',
  ),
];

/** Additional distinct held-out queries, written once and never tuned. */
export const realHostHeldout: RealTask[] = [
  label(
    'real-heldout-readme',
    'download the readme file from a repository',
    'github',
    'get_file_contents',
    'Held-out file read.',
    'heldout',
  ),
  label(
    'real-heldout-list-prs',
    'list the pull requests opened in a repository',
    'github',
    'list_pull_requests',
    'Held-out PR listing.',
    'heldout',
  ),
  label(
    'real-heldout-merge-pr',
    'merge a pull request in a repository',
    'github',
    'merge_pull_request',
    'Held-out PR merge.',
    'heldout',
  ),
  label(
    'real-heldout-library-id',
    'find a library by name and get its context7 id',
    'context7',
    'resolve-library-id',
    'Held-out id resolution.',
    'heldout',
  ),
  label(
    'real-heldout-crawl',
    'crawl a website and collect its pages',
    'firecrawl',
    'firecrawl_crawl',
    'Held-out crawl.',
    'heldout',
  ),
  label(
    'real-heldout-templates',
    'list all email templates in resend',
    'resend',
    'list-templates',
    'Held-out template listing.',
    'heldout',
  ),
  label(
    'real-heldout-map',
    'map a website to a list of urls',
    'firecrawl',
    'firecrawl_map',
    'Held-out site map.',
    'heldout',
  ),
  label(
    'real-heldout-tag',
    'get details about a specific git tag',
    'github',
    'get_tag',
    'Held-out tag lookup.',
    'heldout',
  ),
];

export const realHostRobustness: RealRobustness[] = [
  {
    id: 'real-host-repeated-tokens',
    query: 'wiki wiki structure structure',
    outcome: 'match',
    expected: id('deepwiki', 'read_wiki_structure'),
    topK: 1,
    note: 'Deduped repeated tokens must not change rank.',
  },
  {
    id: 'real-host-stopwords-only',
    query: 'the and for with a',
    outcome: 'no-match',
    note: 'Zero meaningful tokens returns nothing.',
  },
  {
    id: 'real-host-no-overlap',
    query: 'quantum chromodynamics lattice gauge',
    outcome: 'no-match',
    note: 'No lexical overlap with any indexed field.',
  },
  {
    id: 'real-host-provider-only',
    query: 'firecrawl tavily',
    outcome: 'no-match',
    note: 'Provider names alone fail the coverage gate.',
  },
  {
    id: 'real-host-identity-name',
    query: 'tavily_search',
    outcome: 'match',
    expected: id('tavily', 'tavily_search'),
    topK: 1,
    note: 'Exact upstream name hits the identity channel.',
  },
];

/** 17 local-node labels across chrome-devtools, shadcn, markitdown, ghidra, azure. */
export const realLocalTasks: RealTask[] = [
  label(
    'real-local-navigate',
    'navigate the page to a url',
    'chrome-devtools',
    'navigate_page',
    'Chrome navigation.',
  ),
  label(
    'real-local-snapshot',
    'take a text snapshot of the page accessibility tree',
    'chrome-devtools',
    'take_snapshot',
    'Chrome a11y snapshot.',
  ),
  label(
    'real-local-screenshot',
    'take a screenshot of the page',
    'chrome-devtools',
    'take_screenshot',
    'Chrome screenshot.',
  ),
  label(
    'real-local-console',
    'list console messages for the page',
    'chrome-devtools',
    'list_console_messages',
    'Chrome console listing.',
  ),
  label(
    'real-local-network',
    'list network requests made by the page',
    'chrome-devtools',
    'list_network_requests',
    'Chrome network listing.',
  ),
  label(
    'real-local-click',
    'click an element in the page',
    'chrome-devtools',
    'click',
    'Chrome click.',
  ),
  label(
    'real-local-fill',
    'fill an input with a value',
    'chrome-devtools',
    'fill',
    'Chrome input fill.',
  ),
  label(
    'real-local-evaluate',
    'evaluate a javascript function in the page',
    'chrome-devtools',
    'evaluate_script',
    'Chrome script evaluation.',
  ),
  label(
    'real-local-perf-trace',
    'start a performance trace on the page',
    'chrome-devtools',
    'performance_start_trace',
    'Chrome performance trace.',
  ),
  label(
    'real-local-markitdown',
    'convert a file uri to markdown',
    'markitdown',
    'convert_to_markdown',
    'MarkItDown conversion.',
  ),
  label(
    'real-local-shadcn-search',
    'search shadcn registry components',
    'shadcn',
    'search_items_in_registries',
    'shadcn registry search.',
  ),
  label(
    'real-local-shadcn-add',
    'get the add command for registry items',
    'shadcn',
    'get_add_command_for_items',
    'shadcn add command.',
  ),
  label(
    'real-local-shadcn-audit',
    'shadcn audit checklist for a project',
    'shadcn',
    'get_audit_checklist',
    'shadcn audit checklist.',
  ),
  label(
    'real-local-ghidra-decompile',
    'decompile a function at an address to pseudocode',
    'ghidra',
    'decompile_function',
    'Ghidra decompilation.',
  ),
  label(
    'real-local-ghidra-functions',
    'list all functions in the current program',
    'ghidra',
    'list_functions',
    'Ghidra function listing.',
  ),
  label(
    'real-local-ghidra-strings',
    'search strings by regex pattern in the program',
    'ghidra',
    'search_strings',
    'Ghidra string search.',
  ),
  label(
    'real-local-azure-docs',
    'search official azure documentation',
    'azure',
    'documentation',
    'Azure documentation search.',
  ),
];

export const realLocalRobustness: RealRobustness[] = [
  {
    id: 'real-local-repeated-tokens',
    query: 'screenshot screenshot page page page',
    outcome: 'match',
    expected: id('chrome-devtools', 'take_screenshot'),
    topK: 1,
    note: 'Deduped repeated tokens must not change rank.',
  },
  {
    id: 'real-local-no-overlap',
    query: 'quantum chromodynamics lattice gauge',
    outcome: 'no-match',
    note: 'No lexical overlap.',
  },
  {
    id: 'real-local-provider-only',
    query: 'chrome-devtools ghidra',
    outcome: 'no-match',
    note: 'Provider names alone fail coverage.',
  },
];
