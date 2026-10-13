import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { controlRequest, createTestRuntime, jsonResponse } from '../support/runtime.js';
import { migrateConfiguration, type ControlApi } from '../../src/cli/migrate.js';

function apiFor(runtime: ReturnType<typeof createTestRuntime>): ControlApi {
  return {
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      const response = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        method,
        path,
        body,
      );
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
      return value;
    },
  };
}

async function seedSource(runtime: ReturnType<typeof createTestRuntime>): Promise<void> {
  const credentialId = z.object({ id: z.string() }).parse(
    await jsonResponse(
      await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/credentials', {
        name: 'laptop-env',
        payload: { type: 'env', variables: { GH_TOKEN: 'laptop-secret' } },
      }),
    ),
  ).id;
  await jsonResponse(
    await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/servers', {
      slug: 'chrome-devtools',
      name: 'Local Chrome',
      kind: 'node',
      nodeId: 'crayons-air',
      transport: { type: 'stdio', command: 'npx', args: ['chrome-devtools-mcp@1.6.0'] },
      credentialId,
      enabled: true,
      settings: {},
    }),
  );
  await jsonResponse(
    await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/servers', {
      slug: 'firecrawl',
      name: 'Firecrawl',
      kind: 'remote',
      transport: { type: 'streamable-http', url: 'https://mcp.firecrawl.dev/v2/mcp' },
      enabled: true,
      settings: {},
    }),
  );
  await jsonResponse(
    await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/clis', {
      slug: 'gh-cli',
      name: 'GitHub CLI (gh)',
      command: 'toolhome/gh-cli:2.97.0',
      executionMode: 'docker',
      entrypoint: 'gh',
      containerVolumes: [{ source: 'toolhome-gh-cli-state', target: '/root/.config/gh' }],
      allowList: { allow: [['gh', '*']], deny: [] },
      probe: { command: 'gh', args: ['--version'] },
    }),
  );
}

describe('instance migration', () => {
  it('copies both planes into an empty instance and lists what still needs a human', async () => {
    const source = createTestRuntime();
    const destination = createTestRuntime();
    try {
      await seedSource(source);
      const report = await migrateConfiguration(apiFor(source), apiFor(destination), {
        planes: { mcp: true, cli: true },
        sleep: async () => {},
      });

      expect(report.dryRun).toBe(false);
      expect(report.imported.servers.map((item) => item.status)).toEqual(['created', 'created']);
      expect(report.imported.clis.map((item) => item.status)).toEqual(['created']);
      expect(report.verification.clis.map((item) => item.slug)).toEqual(['gh-cli']);

      const servers = z
        .array(
          z
            .object({ slug: z.string(), kind: z.string(), nodeId: z.string().nullable() })
            .passthrough(),
        )
        .parse(
          await jsonResponse(
            await controlRequest(
              destination.runtime,
              destination.controlKey,
              'GET',
              '/api/v1/servers',
            ),
          ),
        );
      expect(servers).toHaveLength(2);
      expect(servers.find((server) => server.slug === 'chrome-devtools')?.nodeId).toBe(
        'crayons-air',
      );

      const clis = z
        .array(
          z
            .object({ slug: z.string(), authStrategy: z.string(), executionMode: z.string() })
            .passthrough(),
        )
        .parse(
          await jsonResponse(
            await controlRequest(destination.runtime, destination.controlKey, 'GET', '/api/v1/clis'),
          ),
        );
      expect(clis).toEqual([
        expect.objectContaining({ slug: 'gh-cli', executionMode: 'docker' }),
      ]);

      // Secrets moved as encrypted credentials, never inside a record.
      expect(JSON.stringify(servers)).not.toContain('laptop-secret');
      const manual = report.manual.join('\n');
      expect(manual).toContain('access-key create');
      if (report.verification.clis[0]?.loggedIn === false) {
        expect(manual).toContain('cli adopt gh-cli');
      }
    } finally {
      await source.close();
      await destination.close();
    }
  });

  it('leaves an empty target untouched on a dry run', async () => {
    const source = createTestRuntime();
    const destination = createTestRuntime();
    try {
      await seedSource(source);
      const report = await migrateConfiguration(apiFor(source), apiFor(destination), {
        planes: { mcp: true, cli: true },
        dryRun: true,
      });
      expect(report.dryRun).toBe(true);
      expect(report.imported.servers.map((item) => item.status)).toEqual(['created', 'created']);
      expect(
        z
          .array(z.unknown())
          .parse(
            await jsonResponse(
              await controlRequest(
                destination.runtime,
                destination.controlKey,
                'GET',
                '/api/v1/servers',
              ),
            ),
          ),
      ).toHaveLength(0);
    } finally {
      await source.close();
      await destination.close();
    }
  });

  it('moves only the plane that was asked for', async () => {
    const source = createTestRuntime();
    const destination = createTestRuntime();
    try {
      await seedSource(source);
      await migrateConfiguration(apiFor(source), apiFor(destination), {
        planes: { mcp: false, cli: true },
        sleep: async () => {},
      });
      expect(
        z
          .array(z.unknown())
          .parse(
            await jsonResponse(
              await controlRequest(
                destination.runtime,
                destination.controlKey,
                'GET',
                '/api/v1/servers',
              ),
            ),
          ),
      ).toHaveLength(0);
      expect(
        z
          .array(z.unknown())
          .parse(
            await jsonResponse(
              await controlRequest(destination.runtime, destination.controlKey, 'GET', '/api/v1/clis'),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      await source.close();
      await destination.close();
    }
  });
});
