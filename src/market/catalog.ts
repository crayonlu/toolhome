export interface MarketRequirement {
  name: string;
  description: string;
  secret?: boolean;
  required?: boolean;
}

export type CredentialSpec =
  | { type: 'oauth' }
  | { type: 'env' }
  | { type: 'bearer'; tokenKey: string }
  | { type: 'api-key'; headerName: string; valueKey: string }
  | { type: 'headers'; headers: { name: string; valueKey?: string; value?: string }[] };

export interface MarketEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  /** Hosting plane: MCP servers (default) or hosted CLIs */
  plane?: 'mcp' | 'cli';
  kind: 'home-stdio' | 'remote' | 'uvx' | 'docker' | 'cli-binary' | 'cli-image';
  package?: string;
  bin?: string;
  /** Pinned exact artifact version (npm `@x.y.z`, uvx `==x.y.z`); installs never drift with latest */
  version?: string;
  /** Declarative installation recipe hidden behind the platform product entry. */
  installer?:
    | { type: 'npm'; package: string; bin: string; version?: string }
    | { type: 'go'; module: string; bin: string; version?: string }
    | {
        type: 'github-release';
        repository: string;
        tag: string;
        asset: string;
        url: string;
        bin: string;
        archive?: 'tar.gz' | 'zip';
      }
    | { type: 'uvx'; package: string; bin: string; version?: string; with?: string[] }
    | { type: 'docker'; image: string; entrypoint?: string | null; dockerfile?: string };
  /** Docker image to run via `docker run --rm -i` (kind: docker); the host socket must be mounted */
  image?: string;
  /** Inline Dockerfile used to build the image when it is not present and not pullable */
  dockerfile?: string;
  url?: string;
  /** Extra dependencies pinned into the uv tool env (e.g. ["mcp<2"]) to work around upstream breaks */
  uvWith?: string[];
  /** Executed argv prefix baked into every MCP stdio exec (after the binary). */
  argsTemplate?: string[];
  /** Explicit argv rules required for hosted CLI execution. */
  allowList?: { allow: string[][]; deny: string[][] };
  /** Platform identity shown in the CLI plane and used for shared auth metadata. */
  platform?: string;
  /** Maps CLI environment names to credential payload sources. */
  credentialBindings?: Record<string, string>;
  /** Declarative runtime bootstrap for hosted CLI containers. */
  cliRuntime?: {
    authStrategy?: 'none' | 'azure-service-principal' | 'tailscale-auth-key';
    containerVolumes?: { source: string; target: string; readOnly?: boolean }[];
  };
  credential: CredentialSpec;
  requires: MarketRequirement[];
  /** Optional Docker entrypoint used when the image does not declare its CLI binary. */
  entrypoint?: string;
  /** Status probe argv for the installed CLI (runs with this entry's command/entrypoint). */
  probe?: { command: string; args: string[] };
  /** Per-exec timeout ceiling applied to the installed CLI record (default 120s). */
  execTimeoutMs?: number;
  docs?: string;
}

export function entryPlane(entry: MarketEntry): 'mcp' | 'cli' {
  return entry.plane ?? 'mcp';
}

export const marketCatalog: MarketEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, issues, pull requests, code search, and Actions workflows',
    category: 'devtools',
    kind: 'remote',
    url: 'https://api.githubcopilot.com/mcp/',
    credential: { type: 'bearer', tokenKey: 'GITHUB_PERSONAL_ACCESS_TOKEN' },
    requires: [
      {
        name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        description: 'GitHub PAT (github.com/settings/personal-access-tokens)',
        secret: true,
        required: true,
      },
    ],
    docs: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues, projects, cycles, and team tracking',
    category: 'productivity',
    kind: 'remote',
    url: 'https://mcp.linear.app/mcp',
    credential: { type: 'oauth' },
    requires: [],
    docs: 'https://linear.app/docs/mcp',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Channels, messages, users, and workspace search',
    category: 'comms',
    kind: 'remote',
    url: 'https://mcp.slack.com/mcp',
    credential: { type: 'oauth' },
    requires: [],
    docs: 'https://api.slack.com/mcp',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Payments, customers, invoices, and subscriptions',
    category: 'finance',
    kind: 'remote',
    url: 'https://mcp.stripe.com',
    credential: { type: 'oauth' },
    requires: [],
    docs: 'https://stripe.com/docs/mcp',
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Design files, components, comments, and FigJam',
    category: 'design',
    kind: 'remote',
    url: 'https://mcp.figma.com/mcp',
    credential: { type: 'oauth' },
    requires: [],
    docs: 'https://www.figma.com/mcp',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Error tracking, issues, releases, and performance',
    category: 'devtools',
    kind: 'remote',
    url: 'https://mcp.sentry.dev/mcp',
    credential: { type: 'oauth' },
    requires: [],
    docs: 'https://docs.sentry.io/integrations/mcp/',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Databases, auth, storage, edge functions, and SQL',
    category: 'data',
    kind: 'remote',
    url: 'https://mcp.supabase.com/mcp',
    credential: { type: 'oauth' },
    requires: [],
    docs: 'https://supabase.com/docs/guides/getting-started/mcp',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Pages, databases, comments, and workspace search',
    category: 'productivity',
    kind: 'remote',
    url: 'https://mcp.notion.com/mcp',
    credential: { type: 'oauth' },
    requires: [],
    docs: 'https://developers.notion.com/reference/mcp',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Workers, KV, R2, D1, and DNS management',
    category: 'infra',
    kind: 'remote',
    url: 'https://mcp.cloudflare.com/mcp',
    credential: { type: 'oauth' },
    requires: [],
    docs: 'https://developers.cloudflare.com/agents/mcp/',
  },
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date, version-specific library documentation',
    category: 'devtools',
    kind: 'remote',
    url: 'https://mcp.context7.com/mcp',
    credential: { type: 'bearer', tokenKey: 'CONTEXT7_API_KEY' },
    requires: [
      { name: 'CONTEXT7_API_KEY', description: 'Context7 API key (optional)', secret: true },
    ],
    docs: 'https://github.com/upstash/context7-mcp',
  },
  {
    id: 'exa',
    name: 'Exa',
    description: 'AI-powered semantic web search for agents',
    category: 'search',
    kind: 'remote',
    url: 'https://mcp.exa.ai/mcp',
    credential: { type: 'bearer', tokenKey: 'EXA_API_KEY' },
    requires: [{ name: 'EXA_API_KEY', description: 'Exa API key', secret: true, required: true }],
    docs: 'https://github.com/exa-labs/exa-mcp-server',
  },
  {
    id: 'tavily',
    name: 'Tavily',
    description: 'Real-time web search and research retrieval',
    category: 'search',
    kind: 'remote',
    url: 'https://mcp.tavily.com/mcp',
    credential: { type: 'bearer', tokenKey: 'TAVILY_API_KEY' },
    requires: [
      { name: 'TAVILY_API_KEY', description: 'Tavily API key', secret: true, required: true },
    ],
    docs: 'https://docs.tavily.com/documentation/mcp',
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    description: 'AI-powered codebase context and answers (no auth)',
    category: 'devtools',
    kind: 'remote',
    url: 'https://mcp.deepwiki.com/mcp',
    credential: { type: 'oauth' },
    requires: [],
    docs: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    description: 'Web scraping, crawling, and site mapping',
    category: 'search',
    kind: 'remote',
    url: 'https://mcp.firecrawl.dev/v2/mcp',
    credential: { type: 'bearer', tokenKey: 'FIRECRAWL_API_KEY' },
    requires: [
      {
        name: 'FIRECRAWL_API_KEY',
        description: 'Firecrawl API key',
        secret: true,
        required: true,
      },
    ],
    docs: 'https://docs.firecrawl.dev/mcp',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Unified access to hundreds of LLM models',
    category: 'ai',
    kind: 'remote',
    url: 'https://mcp.openrouter.ai/mcp',
    credential: { type: 'bearer', tokenKey: 'OPENROUTER_API_KEY' },
    requires: [
      {
        name: 'OPENROUTER_API_KEY',
        description: 'OpenRouter API key',
        secret: true,
        required: true,
      },
    ],
    docs: 'https://openrouter.ai/docs',
  },
  {
    id: 'apifox',
    name: 'Apifox',
    description: 'API design, debugging, and documentation workspace',
    category: 'devtools',
    kind: 'remote',
    url: 'https://api.apifox.com/mcp',
    credential: {
      type: 'headers',
      headers: [
        { name: 'Authorization', valueKey: 'APIFOX_TOKEN' },
        { name: 'X-Apifox-Api-Version', value: '2025-09-01' },
      ],
    },
    requires: [
      { name: 'APIFOX_TOKEN', description: 'Apifox access token', secret: true, required: true },
    ],
    docs: 'https://apifox.com/help/ai/agent/',
  },
  {
    id: 'resend',
    name: 'Resend',
    description: 'Send transactional email and manage audiences',
    category: 'email',
    kind: 'home-stdio',
    package: 'resend-mcp',
    version: '2.12.0',
    bin: 'resend-mcp',
    credential: { type: 'env' },
    requires: [
      { name: 'RESEND_API_KEY', description: 'Resend API key', secret: true, required: true },
    ],
    docs: 'https://resend.com/docs',
  },
  {
    id: 'tailscale',
    name: 'Tailscale',
    description: 'Manage your tailnet, nodes, ACLs, and devices',
    category: 'infra',
    kind: 'home-stdio',
    package: '@hexsleeves/tailscale-mcp-server',
    version: '1.3.4',
    bin: 'tailscale-mcp-server',
    credential: { type: 'env' },
    requires: [
      { name: 'TAILSCALE_API_KEY', description: 'Tailscale API key', secret: true, required: true },
      {
        name: 'TAILSCALE_TAILNET',
        description: 'Tailnet name (e.g. example.ts.net)',
        required: true,
      },
    ],
    docs: 'https://github.com/hexsleeves/tailscale-mcp-server',
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Browser automation, page inspection, and screenshots',
    category: 'browser',
    kind: 'home-stdio',
    package: '@playwright/mcp',
    version: '0.0.79',
    bin: 'playwright-mcp',
    credential: { type: 'env' },
    requires: [],
    docs: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Read-only schema inspection and query execution',
    category: 'data',
    kind: 'home-stdio',
    package: '@modelcontextprotocol/server-postgres',
    version: '0.6.2',
    bin: 'mcp-server-postgres',
    credential: { type: 'env' },
    requires: [
      {
        name: 'POSTGRES_CONNECTION_STRING',
        description: 'Read-only connection string (postgresql://...)',
        secret: true,
        required: true,
      },
    ],
    argsTemplate: ['${POSTGRES_CONNECTION_STRING}'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query local SQLite databases',
    category: 'data',
    kind: 'uvx',
    package: 'mcp-server-sqlite',
    version: '2025.4.25',
    bin: 'mcp-server-sqlite',
    credential: { type: 'env' },
    requires: [
      { name: 'DB_PATH', description: 'Path to the SQLite database file', required: true },
    ],
    argsTemplate: ['--db', '${DB_PATH}'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent knowledge graph across conversations',
    category: 'ai',
    kind: 'home-stdio',
    package: '@modelcontextprotocol/server-memory',
    version: '2026.7.4',
    bin: 'mcp-server-memory',
    credential: { type: 'env' },
    requires: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured multi-step reasoning and planning',
    category: 'ai',
    kind: 'home-stdio',
    package: '@modelcontextprotocol/server-sequential-thinking',
    version: '2026.7.4',
    bin: 'mcp-server-sequential-thinking',
    credential: { type: 'env' },
    requires: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch web pages and convert to markdown',
    category: 'search',
    kind: 'uvx',
    package: 'mcp-server-fetch',
    version: '2026.7.10',
    bin: 'mcp-server-fetch',
    // mcp-server-fetch 2026.7.10 imports McpError which was renamed in mcp>=2.0
    uvWith: ['mcp<2'],
    credential: { type: 'env' },
    requires: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'markitdown',
    name: 'MarkItDown',
    description: 'Convert files and URLs (PDF, Office, images, audio) to Markdown',
    category: 'data',
    kind: 'docker',
    image: 'markitdown-mcp:latest',
    // onnxruntime (a hard dep) publishes no musl wheels, so the uvx runtime in
    // the Alpine gateway image cannot install it — run the official glibc image
    // as a sibling container via the mounted docker socket instead.
    dockerfile: `FROM python:3.13-slim
ENV DEBIAN_FRONTEND=noninteractive
ENV EXIFTOOL_PATH=/usr/bin/exiftool
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV MARKITDOWN_ENABLE_PLUGINS=True
RUN sed -i -e 's#http://deb.debian.org/debian#http://mirrors.tuna.tsinghua.edu.cn/debian#g' -e 's#http://security.debian.org/debian-security#http://mirrors.tuna.tsinghua.edu.cn/debian-security#g' /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends ffmpeg exiftool && rm -rf /var/lib/apt/lists/*
RUN pip --no-cache-dir install -i https://pypi.tuna.tsinghua.edu.cn/simple 'markitdown-mcp==0.0.1a4'
WORKDIR /workdir
ENTRYPOINT ["markitdown-mcp"]`,
    credential: { type: 'env' },
    requires: [],
    docs: 'https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp',
  },
  {
    id: 'mosaic',
    name: 'Mosaic',
    description: 'Query memos, diaries, AI bots, memory and stats from Mosaic',
    category: 'productivity',
    kind: 'home-stdio',
    package: 'mosaic-mcp',
    version: '0.2.0',
    bin: 'mosaic-mcp',
    credential: { type: 'env' },
    requires: [
      { name: 'MOSAIC_SERVER_URL', description: 'Mosaic backend URL', required: true },
      {
        name: 'MOSAIC_USERNAME',
        description: 'Username (paired with MOSAIC_PASSWORD)',
        secret: true,
        required: true,
      },
      { name: 'MOSAIC_PASSWORD', description: 'Password', secret: true, required: true },
      {
        name: 'MOSAIC_TOKEN',
        description: 'JWT access token (alternative to username/password)',
        secret: true,
      },
    ],
    docs: 'https://github.com/crayonlu/Mosaic/tree/main/packages/mcp-server',
  },

  // ── CLI plane: hosted platform CLIs, parallel to MCP entries ───────────
  {
    id: 'azure-cli',
    name: 'Azure CLI (az)',
    description: 'Manage Azure subscriptions, resources, and deployments through Azure APIs',
    category: 'infra',
    plane: 'cli',
    platform: 'azure',
    kind: 'cli-image',
    version: '2.89.0',
    installer: {
      type: 'docker',
      image: 'mcr.microsoft.com/azure-cli:2.89.0',
      entrypoint: 'az',
    },
    image: 'mcr.microsoft.com/azure-cli:2.89.0',
    entrypoint: 'az',
    credential: { type: 'env' },
    credentialBindings: {
      AZURE_CLIENT_ID: 'env:AZURE_CLIENT_ID',
      AZURE_CLIENT_SECRET: 'env:AZURE_CLIENT_SECRET',
      AZURE_TENANT_ID: 'env:AZURE_TENANT_ID',
    },
    cliRuntime: {
      authStrategy: 'azure-service-principal',
      containerVolumes: [{ source: 'toolhome-azure-cli-state', target: '/root/.azure' }],
    },
    requires: [
      {
        name: 'AZURE_CLIENT_ID',
        description: 'Microsoft Entra application client ID',
        secret: false,
        required: true,
      },
      {
        name: 'AZURE_CLIENT_SECRET',
        description: 'Microsoft Entra service principal secret',
        secret: true,
        required: true,
      },
      {
        name: 'AZURE_TENANT_ID',
        description: 'Microsoft Entra tenant ID',
        secret: false,
        required: true,
      },
    ],
    allowList: {
      allow: [['account', 'show'], ['group', 'list'], ['resource', 'list'], ['version']],
      deny: [['login'], ['account', 'clear']],
    },
    probe: { command: 'az', args: ['version', '--output', 'tsv', '--query', '"azure-cli"'] },
    docs: 'https://learn.microsoft.com/cli/azure/',
  },
  {
    id: 'gh-cli',
    name: 'GitHub CLI (gh)',
    description: 'Operate GitHub repositories, issues, pull requests, and Actions centrally',
    category: 'devtools',
    plane: 'cli',
    platform: 'github',
    kind: 'cli-image',
    version: '2.97.0',
    installer: {
      type: 'docker',
      image: 'ghcr.io/cli/cli:2.97.0',
      entrypoint: 'gh',
    },
    image: 'ghcr.io/cli/cli:2.97.0',
    entrypoint: 'gh',
    // Installs without credentials; authenticate afterwards via the device-flow
    // login persisted in the toolhome-gh-cli-state volume.
    credential: { type: 'env' },
    credentialBindings: {},
    requires: [],
    cliRuntime: {
      containerVolumes: [{ source: 'toolhome-gh-cli-state', target: '/root/.config/gh' }],
    },
    allowList: {
      allow: [
        ['--version'],
        ['auth', 'login'],
        ['auth', 'login', '*'],
        ['auth', 'status'],
        ['auth', 'status', '*'],
        ['repo', 'view', '*'],
        ['issue', 'list'],
        ['pr', 'list'],
      ],
      deny: [['auth', 'token']],
    },
    execTimeoutMs: 600_000,
    probe: { command: 'gh', args: ['--version'] },
    docs: 'https://cli.github.com/',
  },
  {
    id: 'tailscale-cli',
    name: 'Tailscale CLI',
    description: 'Inspect and manage a Tailscale network from the hosted control plane',
    category: 'infra',
    plane: 'cli',
    platform: 'tailscale',
    kind: 'cli-image',
    version: '1.102.3',
    installer: {
      type: 'docker',
      image: 'tailscale/tailscale:v1.102.3',
      entrypoint: 'tailscale',
    },
    image: 'tailscale/tailscale:v1.102.3',
    entrypoint: 'tailscale',
    credential: { type: 'env' },
    credentialBindings: { TS_AUTHKEY: 'env:TS_AUTHKEY' },
    cliRuntime: {
      authStrategy: 'tailscale-auth-key',
      containerVolumes: [{ source: 'toolhome-tailscale-state', target: '/var/lib/tailscale' }],
    },
    requires: [
      {
        name: 'TS_AUTHKEY',
        description: 'Tailscale auth key for the hosted node',
        secret: true,
        required: true,
      },
    ],
    allowList: {
      allow: [['version'], ['status'], ['netcheck']],
      deny: [['up'], ['logout'], ['down']],
    },
    probe: { command: 'tailscale', args: ['version'] },
    docs: 'https://tailscale.com/kb/1080/cli/',
  },
  {
    id: 'lark-cli',
    name: 'Lark CLI (lark-cli)',
    description:
      'Drive Lark/Feishu mail, calendar, docs, base, IM, and more through the official CLI (device-flow login on first use)',
    category: 'productivity',
    plane: 'cli',
    platform: 'lark',
    kind: 'cli-binary',
    version: '1.0.92',
    // The npm package is a launcher: the platform binary downloads on first
    // execution and caches inside the persistent market volume.
    installer: { type: 'npm', package: '@larksuite/cli', bin: 'lark-cli', version: '1.0.92' },
    bin: 'lark-cli',
    credential: { type: 'env' },
    credentialBindings: {},
    requires: [],
    allowList: {
      allow: [
        ['--version'],
        ['auth', 'login'],
        ['auth', 'login', '*'],
        ['auth', 'status'],
        ['auth', 'list'],
        ['auth', 'scopes'],
        ['auth', 'check', '*'],
        ['auth', 'qrcode', '*'],
        ['auth', 'logout'],
        ['schema', '*'],
        ['api', '*', '*'],
        ['application', '*'],
        ['approval', '*'],
        ['apps', '*'],
        ['attendance', '*'],
        ['base', '*'],
        ['calendar', '*'],
        ['contact', '*'],
        ['docs', '*'],
        ['drive', '*'],
        ['event', '*'],
        ['im', '*'],
        ['mail', '*'],
        ['markdown', '*'],
        ['mindnotes', '*'],
        ['minutes', '*'],
        ['note', '*'],
        ['okr', '*'],
        ['sheets', '*'],
        ['slides', '*'],
        ['task', '*'],
        ['vc', '*'],
        ['wiki', '*'],
      ],
      deny: [],
    },
    docs: 'https://www.npmjs.com/package/@larksuite/cli',
  },
  {
    id: 'firecrawl-cli',
    name: 'Firecrawl CLI (firecrawl)',
    description: 'Scrape, crawl, map, and search the web through the Firecrawl API',
    category: 'devtools',
    plane: 'cli',
    platform: 'firecrawl',
    kind: 'cli-binary',
    version: '1.23.3',
    installer: { type: 'npm', package: 'firecrawl-cli', bin: 'firecrawl', version: '1.23.3' },
    bin: 'firecrawl',
    credential: { type: 'bearer', tokenKey: 'FIRECRAWL_API_KEY' },
    credentialBindings: { FIRECRAWL_API_KEY: 'token' },
    requires: [
      {
        name: 'FIRECRAWL_API_KEY',
        description: 'Firecrawl API key (firecrawl.dev)',
        secret: true,
        required: true,
      },
    ],
    allowList: {
      allow: [
        ['--version'],
        ['--status'],
        ['scrape', '*'],
        ['crawl', '*'],
        ['map', '*'],
        ['search', '*'],
        ['parse', '*'],
      ],
      deny: [['config']],
    },
    docs: 'https://www.npmjs.com/package/firecrawl-cli',
  },
  {
    id: 'wrangler-cli',
    name: 'Cloudflare Wrangler (wrangler)',
    description: 'Manage Cloudflare Workers, KV, R2, D1, and Pages from the hosted control plane',
    category: 'infra',
    plane: 'cli',
    platform: 'cloudflare',
    kind: 'cli-binary',
    version: '4.127.0',
    installer: { type: 'npm', package: 'wrangler', bin: 'wrangler', version: '4.127.0' },
    bin: 'wrangler',
    credential: { type: 'bearer', tokenKey: 'CLOUDFLARE_API_TOKEN' },
    credentialBindings: { CLOUDFLARE_API_TOKEN: 'token' },
    requires: [
      {
        name: 'CLOUDFLARE_API_TOKEN',
        description: 'Cloudflare API token with Workers/KV/R2 permissions',
        secret: true,
        required: true,
      },
    ],
    allowList: {
      allow: [
        ['--version'],
        ['whoami'],
        ['deployments', 'list'],
        ['kv', 'namespace', 'list'],
        ['kv', 'key', 'list', '*'],
        ['r2', 'bucket', 'list'],
        ['pages', 'project', 'list'],
        ['d1', 'list'],
        ['queues', 'list'],
        ['vectorize', 'list'],
      ],
      deny: [['login'], ['logout']],
    },
    docs: 'https://developers.cloudflare.com/workers/wrangler/',
  },
  {
    id: 'vercel-cli',
    name: 'Vercel CLI (vercel)',
    description: 'Inspect Vercel projects, deployments, logs, and environment variables',
    category: 'devtools',
    plane: 'cli',
    platform: 'vercel',
    kind: 'cli-binary',
    version: '59.9.1',
    installer: { type: 'npm', package: 'vercel', bin: 'vercel', version: '59.9.1' },
    bin: 'vercel',
    credential: { type: 'bearer', tokenKey: 'VERCEL_TOKEN' },
    credentialBindings: { VERCEL_TOKEN: 'token' },
    requires: [
      {
        name: 'VERCEL_TOKEN',
        description: 'Vercel access token (vercel.com/account/tokens)',
        secret: true,
        required: true,
      },
    ],
    allowList: {
      allow: [
        ['--version'],
        ['whoami'],
        ['projects', 'ls'],
        ['projects', 'ls', '*'],
        ['deployments', 'ls'],
        ['deployments', 'ls', '*'],
        ['env', 'ls'],
        ['env', 'ls', '*'],
        ['logs', '*'],
        ['teams', 'ls'],
        ['domains', 'ls'],
      ],
      deny: [['login'], ['logout']],
    },
    docs: 'https://vercel.com/docs/cli',
  },
  {
    id: 'aliyun-cli',
    name: 'Alibaba Cloud CLI (aliyun)',
    description: 'Manage Alibaba Cloud ECS, OSS, DNS, and other OpenAPI products',
    category: 'infra',
    plane: 'cli',
    platform: 'aliyun',
    kind: 'cli-binary',
    version: '3.4.11',
    // The release asset is pinned to linux-amd64, matching the deployed gateway.
    installer: {
      type: 'github-release',
      repository: 'aliyun/aliyun-cli',
      tag: 'v3.4.11',
      asset: 'aliyun-cli-linux-3.4.11-amd64.tgz',
      url: 'https://github.com/aliyun/aliyun-cli/releases/download/v3.4.11/aliyun-cli-linux-3.4.11-amd64.tgz',
      bin: 'aliyun',
      archive: 'tar.gz',
    },
    bin: 'aliyun',
    credential: { type: 'env' },
    credentialBindings: {
      ALIBABA_CLOUD_ACCESS_KEY_ID: 'env:ALIBABA_CLOUD_ACCESS_KEY_ID',
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'env:ALIBABA_CLOUD_ACCESS_KEY_SECRET',
      ALIBABA_CLOUD_REGION_ID: 'env:ALIBABA_CLOUD_REGION_ID',
    },
    requires: [
      {
        name: 'ALIBABA_CLOUD_ACCESS_KEY_ID',
        description: 'Alibaba Cloud AccessKey ID',
        secret: false,
        required: true,
      },
      {
        name: 'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
        description: 'Alibaba Cloud AccessKey secret',
        secret: true,
        required: true,
      },
      {
        name: 'ALIBABA_CLOUD_REGION_ID',
        description: 'Default region ID (e.g. cn-hangzhou)',
        secret: false,
        required: true,
      },
    ],
    allowList: {
      allow: [
        ['version'],
        ['configure', 'list'],
        ['ecs', 'DescribeInstances', '*'],
        ['ecs', 'DescribeRegions', '*'],
        ['oss', 'ls', '*'],
      ],
      deny: [
        ['configure', 'set'],
        ['configure', 'delete'],
      ],
    },
    probe: { command: 'aliyun', args: ['version'] },
    docs: 'https://help.aliyun.com/en/cli/',
  },
  {
    id: 'host-shell',
    name: 'Host Shell (sh)',
    description: 'Run trusted commands with the host shell binary (explicit opt-in)',
    category: 'infra',
    plane: 'cli',
    kind: 'cli-binary',
    bin: '/bin/sh',
    allowList: { allow: [['-c', '*']], deny: [] },
    credential: { type: 'env' },
    requires: [],
    docs: 'https://docs.toolhome.dev/cli-plane',
  },
];
