import { describe, expect, it } from 'vitest';
import { marketCatalog, entryPlane } from '../../src/market/catalog.js';

describe('platform CLI Market catalog', () => {
  it('treats Azure, GitHub, and Tailscale as hosted platform CLIs', () => {
    expect(
      marketCatalog
        .filter((entry) => ['azure-cli', 'gh-cli', 'tailscale-cli'].includes(entry.id))
        .map((entry) => ({
          id: entry.id,
          plane: entryPlane(entry),
          kind: entry.kind,
          platform: entry.platform,
        })),
    ).toEqual([
      { id: 'azure-cli', plane: 'cli', kind: 'cli-image', platform: 'azure' },
      { id: 'gh-cli', plane: 'cli', kind: 'cli-image', platform: 'github' },
      { id: 'tailscale-cli', plane: 'cli', kind: 'cli-image', platform: 'tailscale' },
    ]);
  });

  it('keeps installer details behind the platform CLI entry', () => {
    const azure = marketCatalog.find((entry) => entry.id === 'azure-cli');
    const github = marketCatalog.find((entry) => entry.id === 'gh-cli');
    expect(azure?.image).toBe('mcr.microsoft.com/azure-cli:2.89.0');
    expect(github?.image).toBe('toolhome/gh-cli:2.97.0');
    expect(azure?.credentialBindings).toEqual({
      AZURE_CLIENT_ID: 'env:AZURE_CLIENT_ID',
      AZURE_CLIENT_SECRET: 'env:AZURE_CLIENT_SECRET',
      AZURE_TENANT_ID: 'env:AZURE_TENANT_ID',
    });
    expect(github?.credentialBindings).toEqual({});
  });

  it('lets gh install without a token and authenticate afterwards via device flow', () => {
    const github = marketCatalog.find((entry) => entry.id === 'gh-cli');
    expect(github?.requires).toEqual([]);
    expect(github?.cliRuntime).toEqual({
      containerVolumes: [{ source: 'toolhome-gh-cli-state', target: '/root/.config/gh' }],
    });
    expect(github?.allowList?.allow).toContainEqual(['auth', 'login']);
    expect(github?.allowList?.allow).toContainEqual(['auth', 'status']);
    expect(github?.allowList?.deny).toEqual([['auth', 'token']]);
    expect(github?.execTimeoutMs).toBe(600_000);
  });

  it('does not expose installer technologies as separate hosted CLI products', () => {
    expect(marketCatalog.some((entry) => ['cargo', 'uv', 'npm', 'docker'].includes(entry.id))).toBe(
      false,
    );
  });

  it('pins the npm and GitHub Release hosted CLIs behind platform entries', () => {
    expect(
      marketCatalog
        .filter((entry) =>
          ['lark-cli', 'firecrawl-cli', 'wrangler-cli', 'vercel-cli', 'aliyun-cli'].includes(
            entry.id,
          ),
        )
        .map((entry) => ({
          id: entry.id,
          plane: entryPlane(entry),
          kind: entry.kind,
          platform: entry.platform,
          installer: entry.installer?.type,
          version: entry.version,
        })),
    ).toEqual([
      {
        id: 'lark-cli',
        plane: 'cli',
        kind: 'cli-binary',
        platform: 'lark',
        installer: 'npm',
        version: '1.0.92',
      },
      {
        id: 'firecrawl-cli',
        plane: 'cli',
        kind: 'cli-binary',
        platform: 'firecrawl',
        installer: 'npm',
        version: '1.23.3',
      },
      {
        id: 'wrangler-cli',
        plane: 'cli',
        kind: 'cli-binary',
        platform: 'cloudflare',
        installer: 'npm',
        version: '4.127.0',
      },
      {
        id: 'vercel-cli',
        plane: 'cli',
        kind: 'cli-binary',
        platform: 'vercel',
        installer: 'npm',
        version: '59.9.1',
      },
      {
        id: 'aliyun-cli',
        plane: 'cli',
        kind: 'cli-binary',
        platform: 'aliyun',
        installer: 'github-release',
        version: '3.4.11',
      },
    ]);
  });

  it('binds credentials and declares allow-lists for every hosted CLI', () => {
    expect(marketCatalog.find((entry) => entry.id === 'lark-cli')?.credentialBindings).toEqual({});
    expect(marketCatalog.find((entry) => entry.id === 'firecrawl-cli')?.credentialBindings).toEqual(
      { FIRECRAWL_API_KEY: 'token' },
    );
    expect(marketCatalog.find((entry) => entry.id === 'wrangler-cli')?.credentialBindings).toEqual({
      CLOUDFLARE_API_TOKEN: 'token',
    });
    expect(marketCatalog.find((entry) => entry.id === 'vercel-cli')?.credentialBindings).toEqual({
      VERCEL_TOKEN: 'token',
    });
    expect(marketCatalog.find((entry) => entry.id === 'aliyun-cli')?.credentialBindings).toEqual({
      ALIBABA_CLOUD_ACCESS_KEY_ID: 'env:ALIBABA_CLOUD_ACCESS_KEY_ID',
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'env:ALIBABA_CLOUD_ACCESS_KEY_SECRET',
      ALIBABA_CLOUD_REGION_ID: 'env:ALIBABA_CLOUD_REGION_ID',
    });
    for (const entry of marketCatalog.filter((item) => entryPlane(item) === 'cli')) {
      expect(entry.allowList?.allow.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('probes installed host binaries without relying on the gateway PATH', () => {
    expect(marketCatalog.find((entry) => entry.id === 'aliyun-cli')?.probe).toEqual({
      command: 'aliyun',
      args: ['version'],
    });
  });
});
