import { describe, expect, it } from 'vitest';
import {
  harvestValues,
  migrateConfiguration,
  type ControlApi,
} from '../../src/cli/migrate.js';

const credentials = [
  {
    ref: 'cred-env',
    name: 'Azure SP',
    type: 'env' as const,
    payload: {
      type: 'env' as const,
      variables: { AZURE_CLIENT_ID: 'client-1', AZURE_CLIENT_SECRET: 'secret-1' },
    },
  },
  {
    ref: 'cred-token',
    name: 'Firecrawl',
    type: 'bearer' as const,
    payload: { type: 'bearer' as const, token: 'fc-1' },
  },
];

describe('market value harvest', () => {
  it('reads env variables, bearer tokens and api keys from the exported credential', () => {
    expect(
      harvestValues(
        {
          id: 'azure-cli',
          name: 'Azure CLI',
          plane: 'cli',
          installed: true,
          requires: [
            { name: 'AZURE_CLIENT_ID', secret: false, required: true },
            { name: 'AZURE_CLIENT_SECRET', secret: true, required: true },
          ],
          credential: { type: 'env' },
        },
        'cred-env',
        credentials,
      ),
    ).toEqual({
      values: { AZURE_CLIENT_ID: 'client-1', AZURE_CLIENT_SECRET: 'secret-1' },
      missing: [],
    });

    expect(
      harvestValues(
        {
          id: 'firecrawl-cli',
          name: 'Firecrawl',
          plane: 'cli',
          installed: true,
          requires: [{ name: 'FIRECRAWL_API_KEY', secret: true, required: true }],
          credential: { type: 'bearer', tokenKey: 'FIRECRAWL_API_KEY' },
        },
        'cred-token',
        credentials,
      ),
    ).toEqual({ values: { FIRECRAWL_API_KEY: 'fc-1' }, missing: [] });
  });

  it('reports a required value that no credential carries, and oauth for what has none', () => {
    expect(
      harvestValues(
        {
          id: 'github',
          name: 'GitHub',
          plane: 'mcp',
          installed: true,
          requires: [{ name: 'GITHUB_TOKEN', secret: true, required: true }],
          credential: { type: 'bearer', tokenKey: 'GITHUB_TOKEN' },
        },
        null,
        credentials,
      ),
    ).toEqual({ values: {}, missing: ['GITHUB_TOKEN'] });

    expect(
      harvestValues(
        {
          id: 'cloudflare',
          name: 'Cloudflare',
          plane: 'mcp',
          installed: true,
          requires: [],
          credential: { type: 'oauth' },
        },
        null,
        credentials,
      ),
    ).toEqual({ values: {}, missing: [] });
  });
});

interface StubCall {
  method: string;
  path: string;
  body?: unknown;
}

function stubApi(
  routes: (path: string, body?: unknown) => unknown,
  calls: StubCall[] = [],
): ControlApi & { calls: StubCall[] } {
  return {
    calls,
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      // Verification endpoints answer with an empty, healthy target by default.
      if (path === '/api/v1/clis') return [];
      if (path === '/api/v1/diagnostics') return { ok: true };
      return routes(path, body);
    },
  };
}

const restoredExport = {
  credentials: [{ ref: 'ref-1', name: 'Azure SP', type: 'env', payload: { type: 'env', variables: { AZURE_CLIENT_SECRET: 's' } } }],
  servers: [],
  clis: [{ slug: 'azure-cli' }],
  installations: [
    { entryId: 'azure-cli', targetType: 'cli', targetSlug: 'azure-cli', credentialRef: 'ref-1' },
  ],
};

const azureEntry = {
  id: 'azure-cli',
  name: 'Azure CLI (az)',
  plane: 'cli',
  installed: true,
  requires: [{ name: 'AZURE_CLIENT_SECRET', secret: true, required: true }],
  credential: { type: 'env' },
};

const emptyTarget = { servers: { total: 0 }, clis: { total: 0 }, credentials: 0 };

function emptyImportReport(): unknown {
  return { counts: { created: 1 }, servers: [], clis: [{ slug: 'azure-cli', status: 'created' }], credentials: [{ name: 'Azure SP', status: 'created' }] };
}

describe('migration orchestration', () => {
  it('reinstalls a Market entry with harvested values before importing records', async () => {
    const order: string[] = [];
    const target = stubApi((path, body) => {
      if (path === '/api/v1/market') return [{ ...azureEntry, installed: false }];
      if (path === '/api/v1/overview') return emptyTarget;
      if (path === '/api/v1/config/import') {
        order.push('import');
        return emptyImportReport();
      }
      if (path.startsWith('/api/v1/market/azure-cli/install')) {
        order.push('install');
        expect(body).toEqual({ values: { AZURE_CLIENT_SECRET: 's' } });
        return { jobId: 'job-1', status: 'installing' };
      }
      if (path === '/api/v1/market/install/job-1') return { status: 'completed', step: 'done' };
      throw new Error(`unexpected target call ${path}`);
    });
    const source = stubApi((path) => {
      if (path.startsWith('/api/v1/config/export')) return restoredExport;
      if (path === '/api/v1/market') return [azureEntry];
      throw new Error(`unexpected source call ${path}`);
    });

    const report = await migrateConfiguration(source, target, {
      planes: { mcp: false, cli: true },
      sleep: async () => {},
    });

    // The Market owns artifact + provenance, so it installs before the import pass.
    expect(order).toEqual(['install', 'import']);
    expect(report.reinstalls).toEqual([
      { entryId: 'azure-cli', plane: 'cli', status: 'installed' },
    ]);
    expect(report.verification.clis).toEqual([]);
  });

  it('leaves an entry the target already has alone and reports the ones it cannot fill', async () => {
    const target = stubApi((path) => {
      if (path === '/api/v1/market') {
        return [
          { ...azureEntry, installed: true },
          {
            id: 'github',
            name: 'GitHub',
            plane: 'mcp',
            installed: false,
            requires: [{ name: 'GITHUB_TOKEN', secret: true, required: true }],
            credential: { type: 'bearer', tokenKey: 'GITHUB_TOKEN' },
          },
        ];
      }
      if (path === '/api/v1/overview') return emptyTarget;
      if (path === '/api/v1/config/import') return emptyImportReport();
      throw new Error(`unexpected target call ${path}`);
    });
    const source = stubApi((path) => {
      if (path.startsWith('/api/v1/config/export')) {
        return {
          ...restoredExport,
          installations: [
            { entryId: 'azure-cli', targetType: 'cli', targetSlug: 'azure-cli', credentialRef: 'ref-1' },
            { entryId: 'github', targetType: 'server', targetSlug: 'github', credentialRef: null },
          ],
        };
      }
      if (path === '/api/v1/market') {
        return [
          azureEntry,
          {
            id: 'github',
            name: 'GitHub',
            plane: 'mcp',
            installed: true,
            requires: [{ name: 'GITHUB_TOKEN', secret: true, required: true }],
            credential: { type: 'bearer', tokenKey: 'GITHUB_TOKEN' },
          },
        ];
      }
      throw new Error(`unexpected source call ${path}`);
    });

    const report = await migrateConfiguration(source, target, {
      planes: { mcp: true, cli: true },
      sleep: async () => {},
    });

    expect(report.reinstalls).toEqual([
      { entryId: 'azure-cli', plane: 'cli', status: 'already-installed' },
      {
        entryId: 'github',
        plane: 'mcp',
        status: 'needs-secret',
        detail: 'no stored value for GITHUB_TOKEN',
      },
    ]);
    expect(report.manual.join('\n')).toContain('github');
  });

  it('records a failed reinstall instead of aborting the transfer', async () => {
    const target = stubApi((path) => {
      if (path === '/api/v1/market') return [{ ...azureEntry, installed: false }];
      if (path === '/api/v1/overview') return emptyTarget;
      if (path === '/api/v1/config/import') return emptyImportReport();
      if (path.startsWith('/api/v1/market/azure-cli/install')) {
        return { jobId: 'job-1', status: 'installing' };
      }
      if (path === '/api/v1/market/install/job-1') {
        return { status: 'failed', step: 'pulling', error: 'docker is unavailable' };
      }
      throw new Error(`unexpected target call ${path}`);
    });
    const source = stubApi((path) => {
      if (path.startsWith('/api/v1/config/export')) return restoredExport;
      if (path === '/api/v1/market') return [azureEntry];
      throw new Error(`unexpected source call ${path}`);
    });

    const report = await migrateConfiguration(source, target, {
      planes: { mcp: false, cli: true },
      sleep: async () => {},
    });
    expect(report.reinstalls[0]).toMatchObject({ status: 'failed' });
    expect(report.manual.join('\n')).toContain('docker is unavailable');
  });

  it('writes nothing on a dry run', async () => {
    const target = stubApi((path, body) => {
      if (path === '/api/v1/market') return [{ ...azureEntry, installed: false }];
      if (path === '/api/v1/overview') return emptyTarget;
      if (path === '/api/v1/config/import') {
        expect(body).toMatchObject({ dryRun: true, mode: 'merge' });
        return emptyImportReport();
      }
      throw new Error(`unexpected target call ${path}`);
    });
    const source = stubApi((path) => {
      if (path.startsWith('/api/v1/config/export')) return restoredExport;
      if (path === '/api/v1/market') return [azureEntry];
      throw new Error(`unexpected source call ${path}`);
    });

    const report = await migrateConfiguration(source, target, {
      planes: { mcp: false, cli: true },
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.reinstalls[0]?.status).toBe('pending');
    expect(target.calls.some((call) => call.path.includes('/install'))).toBe(false);
  });
});
