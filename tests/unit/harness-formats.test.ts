import { describe, expect, it } from 'vitest';
import {
  detectHarnesses,
  expandCandidate,
  parseTomlServers,
  readHarnessFile,
  renderHarnessFile,
  splitToml,
} from '../../src/config/harness-formats.js';

const grokConfig = `# Grok Build's config

[mcp_servers.toolhome]
url = "https://tool.example.test/mcp"

[mcp_servers.toolhome.headers]
Authorization = "Bearer tch_mcp_secret"

[mcp_servers.azure]
command = "npx"
args = ["-y", "@azure/mcp@latest", "server", "start"]

[mcp_servers.chrome-devtools]
command = "node"
args = [
    "/opt/chrome-devtools-mcp/index.js",
    "--wsEndpoint",
    "ws://127.0.0.1:9333/devtools/browser/relay",
]

[mcp_servers.outlook]
command = "node"
args = ["/opt/outlook/dist/index.js", "--preset", "mail"]
env = { MS365_MCP_TOKEN_CACHE_PATH = "/tmp/token.json", MODE = "mail" }

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
enabled = false

[ui]
theme = "terminal"

[[marketplace.sources]]
name = "plugin-marketplace"
git = "https://github.com/xai-org/plugin-marketplace.git"
`;

describe('TOML harness configs', () => {
  it('reads command/args/env and url/headers entries from [mcp_servers.*] tables', () => {
    const servers = parseTomlServers(grokConfig, 'mcp_servers');
    expect(Object.keys(servers).sort()).toEqual([
      'azure',
      'chrome-devtools',
      'figma',
      'outlook',
      'toolhome',
    ]);
    expect(servers.toolhome).toEqual({
      url: 'https://tool.example.test/mcp',
      headers: { Authorization: 'Bearer tch_mcp_secret' },
    });
    expect(servers.azure).toEqual({
      command: 'npx',
      args: ['-y', '@azure/mcp@latest', 'server', 'start'],
    });
    // A multi-line array keeps every element and stops at the table boundary.
    expect(servers['chrome-devtools']).toEqual({
      command: 'node',
      args: [
        '/opt/chrome-devtools-mcp/index.js',
        '--wsEndpoint',
        'ws://127.0.0.1:9333/devtools/browser/relay',
      ],
    });
    expect(servers.outlook).toEqual({
      command: 'node',
      args: ['/opt/outlook/dist/index.js', '--preset', 'mail'],
      env: { MS365_MCP_TOKEN_CACHE_PATH: '/tmp/token.json', MODE: 'mail' },
    });
    expect(servers.figma).toEqual({ url: 'https://mcp.figma.com/mcp', enabled: false });
  });

  it('leaves other tables alone when splitting', () => {
    const { tables } = splitToml(grokConfig);
    const headers = tables.map((table) => table.path.join('.'));
    expect(headers).toContain('ui');
    expect(headers).toContain('marketplace.sources');
    expect(headers).toContain('mcp_servers.toolhome.headers');
  });

  it('rewrites only the server tables, keeping the harness its own sections', () => {
    const content = readHarnessFile('config.toml', grokConfig, {
      path: 'config.toml',
      format: 'toml',
      key: 'mcp_servers',
    });
    const rendered = renderHarnessFile(content, {
      toolhome: {
        url: 'https://tool.example.test/mcp',
        headers: { Authorization: 'Bearer tch_mcp_new' },
      },
      azure: { command: 'npx', args: ['-y', '@azure/mcp@latest'] },
    });

    expect(rendered).toContain('[ui]\ntheme = "terminal"');
    expect(rendered).toContain('[[marketplace.sources]]');
    expect(rendered).not.toContain('[mcp_servers.outlook]');
    expect(rendered).not.toContain('[mcp_servers.chrome-devtools]');

    const reparsed = parseTomlServers(rendered, 'mcp_servers');
    expect(Object.keys(reparsed).sort()).toEqual(['azure', 'toolhome']);
    expect(reparsed.toolhome).toEqual({
      url: 'https://tool.example.test/mcp',
      headers: { Authorization: 'Bearer tch_mcp_new' },
    });
  });

  it('escapes values it writes', () => {
    const content = readHarnessFile('config.toml', '', {
      path: 'config.toml',
      format: 'toml',
      key: 'mcp_servers',
    });
    const rendered = renderHarnessFile(content, {
      odd: { command: 'sh', args: ['-c', 'echo "hi"'], env: { 'weird key': 'a\\b' } },
    });
    const reparsed = parseTomlServers(rendered, 'mcp_servers');
    expect(reparsed.odd).toEqual({
      command: 'sh',
      args: ['-c', 'echo "hi"'],
      env: { 'weird key': 'a\\b' },
    });
  });
});

describe('JSON harness configs', () => {
  it('reads a VS Code `servers` object and keeps unrelated keys on rewrite', () => {
    const text = JSON.stringify({
      servers: { docs: { url: 'https://docs.example.test/mcp' } },
      inputs: [{ id: 'x' }],
    });
    const content = readHarnessFile('/home/me/.config/Code/User/mcp.json', text);
    expect(content.key).toBe('servers');
    expect(content.servers).toEqual({ docs: { url: 'https://docs.example.test/mcp' } });

    const rendered = renderHarnessFile(content, { toolhome: { url: 'https://t/mcp' } });
    const parsed = JSON.parse(rendered) as Record<string, unknown>;
    expect(parsed.servers).toEqual({ toolhome: { url: 'https://t/mcp' } });
    expect(parsed.inputs).toEqual([{ id: 'x' }]);
  });
});

describe('harness locations', () => {
  it('expands ~ and $VAR, and skips a candidate whose variable is unset', () => {
    expect(expandCandidate('~/.grok/config.toml', {}, '/home/me')).toBe(
      '/home/me/.grok/config.toml',
    );
    expect(expandCandidate('$GROK_HOME/config.toml', { GROK_HOME: '/srv/grok' }, '/home/me')).toBe(
      '/srv/grok/config.toml',
    );
    expect(expandCandidate('$GROK_HOME/config.toml', {}, '/home/me')).toBeNull();
  });

  it('detects only the harnesses whose files exist', () => {
    const found = detectHarnesses(
      { GROK_HOME: '/srv/grok' },
      '/home/me',
      (path) => path === '/srv/grok/config.toml' || path === '/home/me/.claude.json',
    );
    expect(found.map((file) => file.path).sort()).toEqual([
      '/home/me/.claude.json',
      '/srv/grok/config.toml',
    ]);
    expect(found.find((file) => file.path === '/srv/grok/config.toml')?.format).toBe('toml');
    expect(found.find((file) => file.path === '/home/me/.claude.json')?.key).toBe('mcpServers');
  });
});
