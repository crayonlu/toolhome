import { describe, expect, it } from 'vitest';
import {
  parseHarnessConfig,
  parseHarnessConfigDetailed,
  toPreview,
  toSlug,
} from '../../src/config/harness-import.js';

describe('harness config parser', () => {
  it('imports a remote entry with a bearer credential from the Authorization header', () => {
    const [entry] = parseHarnessConfig({
      mcpServers: {
        Docs: {
          url: 'https://docs.example.test/mcp',
          headers: { Authorization: 'Bearer abc123' },
        },
      },
    });
    expect(entry?.kind).toBe('remote');
    expect(entry?.slug).toBe('docs');
    expect(entry?.credential?.payload).toEqual({ type: 'bearer', token: 'abc123' });
    expect(entry?.warnings.join(' ')).toContain('Bearer');
    // The token must not leak into the plaintext transport headers.
    expect(JSON.stringify(entry?.transport)).not.toContain('abc123');
  });

  it('imports a remote entry with arbitrary headers as a headers credential', () => {
    const [entry] = parseHarnessConfig({
      mcpServers: {
        api: { url: 'https://api.example.test/mcp', headers: { 'x-api-key': 'k' } },
      },
    });
    expect(entry?.credential?.payload).toEqual({
      type: 'headers',
      headers: { 'x-api-key': 'k' },
    });
    if (entry?.transport.type === 'streamable-http') {
      expect(entry.transport.headers).toEqual({});
    }
  });

  it('imports a remote entry without headers as credential-less', () => {
    const [entry] = parseHarnessConfig({
      mcpServers: { public: { url: 'https://public.example.test/mcp' } },
    });
    expect(entry?.credential).toBeNull();
  });

  it('splits stdio env into an encrypted credential (secret-looking keys) and transport env', () => {
    const [entry] = parseHarnessConfig({
      mcpServers: {
        mosaic: {
          command: 'npx',
          args: ['-y', 'mosaic-mcp'],
          env: {
            MOSAIC_SERVER_URL: 'http://localhost:3001',
            MOSAIC_USERNAME: 'admin',
            MOSAIC_PASSWORD: 'pw',
            api_KEY: 'k',
          },
        },
      },
    });
    expect(entry?.kind).toBe('home');
    expect(entry?.transport.type).toBe('stdio');
    if (entry?.transport.type === 'stdio') {
      expect(entry.transport.env).toEqual({
        MOSAIC_SERVER_URL: 'http://localhost:3001',
        MOSAIC_USERNAME: 'admin',
      });
    }
    expect(entry?.credential?.payload).toEqual({
      type: 'env',
      variables: { MOSAIC_PASSWORD: 'pw', api_KEY: 'k' },
    });
  });

  it('flags npx packages that match a curated Market entry', () => {
    const [entry] = parseHarnessConfig({
      mcpServers: { mosaic: { command: 'npx', args: ['mosaic-mcp'] } },
    });
    expect(entry?.warnings.join(' ')).toContain('Market');
  });

  it('warns when a package runner is not in the curated catalog', () => {
    const [entry] = parseHarnessConfig({
      mcpServers: { custom: { command: 'npx', args: ['-y', 'some-random-mcp'] } },
    });
    expect(entry?.warnings.join(' ')).toContain('resolvable');
  });

  it('rejects entries with neither url nor command', () => {
    expect(() => parseHarnessConfig({ mcpServers: { broken: {} } })).toThrow(/url.*command/i);
  });

  it('sanitizes names into slugs', () => {
    expect(toSlug('My Cool MCP!')).toBe('my-cool-mcp');
    expect(toSlug('--weird__name--')).toBe('weird-name');
    expect(toSlug('中文名字')).toBe('mcp');
  });

  it('previews never expose secret values', () => {
    const [entry] = parseHarnessConfig({
      mcpServers: {
        mosaic: {
          command: 'npx',
          args: ['mosaic-mcp'],
          env: { MOSAIC_PASSWORD: 'top-secret-value' },
        },
        docs: {
          url: 'https://docs.example.test/mcp',
          headers: { Authorization: 'Bearer another-secret' },
        },
      },
    });
    const previews = parseHarnessConfig({
      mcpServers: {
        mosaic: {
          command: 'npx',
          args: ['mosaic-mcp'],
          env: { MOSAIC_PASSWORD: 'top-secret-value' },
        },
        docs: {
          url: 'https://docs.example.test/mcp',
          headers: { Authorization: 'Bearer another-secret' },
        },
      },
    }).map(toPreview);
    const serialized = JSON.stringify(previews);
    expect(serialized).not.toContain('top-secret-value');
    expect(serialized).not.toContain('another-secret');
    expect(previews[0]?.credential?.fields.map((f) => f.name)).toEqual(['MOSAIC_PASSWORD']);
    expect(previews[1]?.credential?.fields.map((f) => f.name)).toEqual(['token']);
    expect(entry).toBeDefined();
  });
});

describe('gateway entries and placement', () => {
  it('keeps a `toolhome mcp stdio` launcher out of the servers and reports it', () => {
    const result = parseHarnessConfigDetailed({
      mcpServers: {
        gateway: { command: 'toolhome', args: ['mcp', 'stdio'] },
        docs: { url: 'https://docs.example.test/mcp' },
      },
    });
    expect(result.entries.map((entry) => entry.slug)).toEqual(['docs']);
    expect(result.gateways).toEqual([
      expect.objectContaining({ slug: 'gateway', via: 'stdio', target: null }),
    ]);
    expect(result.gateways[0]?.message).toContain('wrap ToolHome inside ToolHome');
  });

  it('recognizes `mcp launch <slug>` through a package runner and names the server', () => {
    const result = parseHarnessConfigDetailed({
      mcpServers: {
        chrome: { command: 'npx', args: ['-y', 'toolhome', 'mcp', 'launch', 'chrome-devtools'] },
      },
    });
    expect(result.entries).toEqual([]);
    expect(result.gateways[0]).toMatchObject({
      via: 'launch',
      target: 'chrome-devtools',
    });
  });

  it('treats a remote entry that authenticates with a ToolHome Access Key as another instance', () => {
    const result = parseHarnessConfigDetailed({
      mcpServers: {
        other: {
          url: 'https://other.example.test/mcp',
          headers: { Authorization: 'Bearer tch_mcp_abcdef' },
        },
      },
    });
    expect(result.entries).toEqual([]);
    expect(result.gateways[0]).toMatchObject({ via: 'remote', target: 'https://other.example.test/mcp' });
  });

  it('treats an entry pointing at the instance being imported into as the gateway itself', () => {
    const result = parseHarnessConfigDetailed(
      {
        mcpServers: {
          self: { url: 'https://tool.example.test/mcp' },
          docs: { url: 'https://docs.example.test/mcp' },
        },
      },
      { targetUrl: 'https://tool.example.test' },
    );
    expect(result.entries.map((entry) => entry.slug)).toEqual(['docs']);
    expect(result.gateways[0]?.via).toBe('remote');
  });

  it('places stdio entries on the named node and says so', () => {
    const [entry] = parseHarnessConfig(
      { mcpServers: { chrome: { command: 'npx', args: ['-y', 'chrome-devtools-mcp'] } } },
      { nodeId: 'R9000P' },
    );
    expect(entry?.kind).toBe('node');
    expect(entry?.nodeId).toBe('R9000P');
    expect(entry?.warnings.join(' ')).toContain('R9000P');
    expect(toPreview(entry!).nodeId).toBe('R9000P');
  });

  it('warns when a stdio entry names a path only this machine has', () => {
    const [entry] = parseHarnessConfig({
      mcpServers: {
        chrome: { command: 'node', args: ['/home/me/node_modules/chrome-devtools-mcp/index.js'] },
      },
    });
    expect(entry?.kind).toBe('home');
    expect(entry?.warnings.join(' ')).toContain('--node');
  });

  it('keeps cwd, which harnesses use for project-scoped servers', () => {
    const [entry] = parseHarnessConfig({
      mcpServers: { local: { command: 'node', args: ['server.js'], cwd: '/srv/project' } },
    });
    expect(entry?.transport).toMatchObject({ type: 'stdio', cwd: '/srv/project' });
  });

  it('rejects a node label that is not a label', () => {
    expect(() =>
      parseHarnessConfig(
        { mcpServers: { a: { command: 'npx', args: ['pkg'] } } },
        { nodeId: 'not a label!' },
      ),
    ).toThrow();
  });
  it('imports another instance only when asked, and never this one', () => {
    const config = {
      mcpServers: {
        other: {
          url: 'https://other.example.test/mcp',
          headers: { Authorization: 'Bearer tch_mcp_abcdef' },
        },
        self: { url: 'https://tool.example.test/mcp' },
      },
    };
    const skipped = parseHarnessConfigDetailed(config, { targetUrl: 'https://tool.example.test' });
    expect(skipped.entries).toEqual([]);
    expect(skipped.gateways.map((gateway) => gateway.self)).toEqual([false, true]);

    const included = parseHarnessConfigDetailed(config, {
      targetUrl: 'https://tool.example.test',
      includeGateways: true,
    });
    expect(included.entries.map((entry) => entry.slug)).toEqual(['other']);
    expect(included.entries[0]?.credential?.payload).toEqual({
      type: 'bearer',
      token: 'tch_mcp_abcdef',
    });
    // The self-reference stays out even then.
    expect(included.gateways.map((gateway) => gateway.slug)).toEqual(['self']);
  });
});
