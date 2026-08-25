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
    expect(github?.image).toBe('ghcr.io/cli/cli:2.97.0');
    expect(azure?.credentialBindings).toEqual({
      AZURE_CLIENT_ID: 'env:AZURE_CLIENT_ID',
      AZURE_CLIENT_SECRET: 'env:AZURE_CLIENT_SECRET',
      AZURE_TENANT_ID: 'env:AZURE_TENANT_ID',
    });
    expect(github?.credentialBindings).toEqual({ GH_TOKEN: 'token' });
  });

  it('does not expose installer technologies as separate hosted CLI products', () => {
    expect(marketCatalog.some((entry) => ['cargo', 'uv', 'npm', 'docker'].includes(entry.id))).toBe(
      false,
    );
  });
});
