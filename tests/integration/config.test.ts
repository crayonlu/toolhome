import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { controlRequest, createTestRuntime, jsonResponse } from '../support/runtime.js';

const exportSchema = z
  .object({
    version: z.literal(1),
    secretsIncluded: z.boolean(),
    credentials: z.array(
      z
        .object({
          ref: z.string(),
          name: z.string(),
          type: z.string(),
          payload: z.unknown().optional(),
        })
        .passthrough(),
    ),
    servers: z.array(
      z
        .object({
          slug: z.string(),
          credentialRef: z.string().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

describe('configuration backup', () => {
  it('redacts by default and restores a secret export with remapped IDs', async () => {
    const source = createTestRuntime();
    const destination = createTestRuntime();
    try {
      const credential = z.object({ id: z.string() }).parse(
        await jsonResponse(
          await controlRequest(source.runtime, source.controlKey, 'POST', '/api/v1/credentials', {
            name: 'Backup credential',
            payload: { type: 'bearer', token: 'backup-secret' },
          }),
        ),
      );
      await jsonResponse(
        await controlRequest(source.runtime, source.controlKey, 'POST', '/api/v1/servers', {
          slug: 'backup-server',
          name: 'Backup server',
          kind: 'remote',
          transport: {
            type: 'streamable-http',
            url: 'https://mcp.example.test/mcp',
            protocolMode: 'auto',
            allowSseFallback: false,
            headers: { 'x-static-secret': 'transport-secret' },
          },
          credentialId: credential.id,
          enabled: false,
          settings: {},
        }),
      );

      const redacted = exportSchema.parse(
        await jsonResponse(
          await controlRequest(source.runtime, source.controlKey, 'GET', '/api/v1/config/export'),
        ),
      );
      expect(redacted.secretsIncluded).toBe(false);
      expect(redacted.credentials[0]?.payload).toBeUndefined();
      expect(JSON.stringify(redacted)).not.toContain('transport-secret');
      const rejected = await controlRequest(
        destination.runtime,
        destination.controlKey,
        'POST',
        '/api/v1/config/import',
        redacted,
      );
      expect(rejected.status).toBe(400);

      const backup = exportSchema.parse(
        await jsonResponse(
          await controlRequest(
            source.runtime,
            source.controlKey,
            'GET',
            '/api/v1/config/export?includeSecrets=true',
          ),
        ),
      );
      expect(backup.secretsIncluded).toBe(true);
      expect(backup.credentials[0]?.payload).toEqual({
        type: 'bearer',
        token: 'backup-secret',
      });
      expect(JSON.stringify(backup)).toContain('transport-secret');
      await jsonResponse(
        await controlRequest(
          destination.runtime,
          destination.controlKey,
          'POST',
          '/api/v1/config/import',
          backup,
        ),
      );
      const importedServers = z
        .array(z.object({ slug: z.string(), credentialId: z.string().nullable() }).passthrough())
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
      const importedCredentials = z
        .array(z.object({ id: z.string(), name: z.string() }).passthrough())
        .parse(
          await jsonResponse(
            await controlRequest(
              destination.runtime,
              destination.controlKey,
              'GET',
              '/api/v1/credentials',
            ),
          ),
        );
      expect(importedServers).toHaveLength(1);
      expect(importedCredentials).toHaveLength(1);
      expect(importedServers[0]?.credentialId).toBe(importedCredentials[0]?.id);
      expect(importedCredentials[0]?.id).not.toBe(credential.id);
    } finally {
      await source.close();
      await destination.close();
    }
  });

  it('previews and imports a harness mcpServers config (stdio + remote)', async () => {
    const runtime = createTestRuntime();
    try {
      const harnessConfig = {
        mcpServers: {
          mosaic: {
            command: 'npx',
            args: ['-y', 'mosaic-mcp'],
            env: {
              MOSAIC_SERVER_URL: 'http://localhost:3001',
              MOSAIC_USERNAME: 'admin',
              MOSAIC_PASSWORD: 'top-secret',
            },
          },
          docs: {
            url: 'https://docs.example.test/mcp',
            headers: { Authorization: 'Bearer remote-token' },
          },
        },
      };

      // Preview: masked, no writes.
      const preview = z
        .object({
          preview: z.literal(true),
          entries: z.array(
            z
              .object({
                slug: z.string(),
                kind: z.enum(['remote', 'home']),
                transportSummary: z.string(),
                credential: z
                  .object({ type: z.string(), fields: z.array(z.object({ name: z.string() })) })
                  .nullable(),
                warnings: z.array(z.string()),
              })
              .passthrough(),
          ),
        })
        .parse(
          await jsonResponse(
            await controlRequest(
              runtime.runtime,
              runtime.controlKey,
              'POST',
              '/api/v1/config/import-harness',
              { config: harnessConfig, preview: true },
            ),
          ),
        );
      const mosaicPreview = preview.entries.find((e) => e.slug === 'mosaic');
      const docsPreview = preview.entries.find((e) => e.slug === 'docs');
      expect(mosaicPreview?.kind).toBe('home');
      expect(mosaicPreview?.credential?.type).toBe('env');
      expect(mosaicPreview?.credential?.fields.map((f) => f.name)).toContain('MOSAIC_PASSWORD');
      expect(mosaicPreview?.credential?.fields.map((f) => f.name)).not.toContain(
        'MOSAIC_SERVER_URL',
      );
      expect(JSON.stringify(preview)).not.toContain('top-secret');
      expect(JSON.stringify(preview)).not.toContain('remote-token');
      expect(mosaicPreview?.warnings.join(' ')).toContain('Market');
      expect(docsPreview?.kind).toBe('remote');
      expect(docsPreview?.credential?.type).toBe('bearer');

      // Import for real.
      const result = z
        .object({
          preview: z.literal(false),
          entries: z.array(
            z
              .object({ slug: z.string(), status: z.string(), serverId: z.string().optional() })
              .passthrough(),
          ),
        })
        .parse(
          await jsonResponse(
            await controlRequest(
              runtime.runtime,
              runtime.controlKey,
              'POST',
              '/api/v1/config/import-harness',
              { config: harnessConfig },
            ),
          ),
        );
      expect(result.entries.map((e) => e.status)).toEqual(['created', 'created']);

      // Secrets landed in an encrypted credential, not in the transport env.
      const servers = z
        .array(
          z
            .object({ slug: z.string(), transport: z.record(z.string(), z.unknown()) })
            .passthrough(),
        )
        .parse(
          await jsonResponse(
            await controlRequest(runtime.runtime, runtime.controlKey, 'GET', '/api/v1/servers'),
          ),
        );
      const mosaicServer = servers.find((s) => s.slug === 'mosaic');
      const mosaicEnv = z.record(z.string(), z.string()).parse(mosaicServer?.transport.env ?? {});
      expect(mosaicEnv.MOSAIC_SERVER_URL).toBe('http://localhost:3001');
      expect(mosaicEnv).not.toHaveProperty('MOSAIC_PASSWORD');
      expect(JSON.stringify(servers)).not.toContain('top-secret');

      // Second import reports conflicts instead of duplicating.
      const again = z
        .object({ entries: z.array(z.object({ slug: z.string(), status: z.string() })) })
        .parse(
          await jsonResponse(
            await controlRequest(
              runtime.runtime,
              runtime.controlKey,
              'POST',
              '/api/v1/config/import-harness',
              { config: harnessConfig },
            ),
          ),
        );
      expect(again.entries.map((e) => e.status)).toEqual(['conflict', 'conflict']);
    } finally {
      await runtime.close();
    }
  });

  it('upsert mode diffs existing servers: unchanged skip, changed update', async () => {
    const runtime = createTestRuntime();
    try {
      const config = {
        mcpServers: {
          mosaic: {
            command: 'npx',
            args: ['-y', 'mosaic-mcp'],
            env: { MOSAIC_SERVER_URL: 'http://localhost:3001', MOSAIC_PASSWORD: 'pw-one' },
          },
        },
      };
      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/config/import-harness',
          { config },
        ),
      );

      const entrySchema = z.object({
        slug: z.string(),
        status: z.string(),
        changes: z.array(z.string()).optional(),
      });

      // Identical config in upsert mode -> unchanged.
      const same = z.object({ entries: z.array(entrySchema) }).parse(
        await jsonResponse(
          await controlRequest(
            runtime.runtime,
            runtime.controlKey,
            'POST',
            '/api/v1/config/import-harness',
            { config, mode: 'upsert' },
          ),
        ),
      );
      expect(same.entries[0]?.status).toBe('unchanged');

      // Changed env (password) + args -> changed with field names only.
      const updatedConfig = {
        mcpServers: {
          mosaic: {
            command: 'npx',
            args: ['-y', 'mosaic-mcp@next'],
            env: { MOSAIC_SERVER_URL: 'http://localhost:3001', MOSAIC_PASSWORD: 'pw-two' },
          },
        },
      };
      const changed = z.object({ entries: z.array(entrySchema) }).parse(
        await jsonResponse(
          await controlRequest(
            runtime.runtime,
            runtime.controlKey,
            'POST',
            '/api/v1/config/import-harness',
            { config: updatedConfig, mode: 'upsert', preview: true },
          ),
        ),
      );
      expect(changed.entries[0]?.status).toBe('changed');
      expect(changed.entries[0]?.changes).toContain('args');
      expect(changed.entries[0]?.changes).toContain('credential');
      expect(JSON.stringify(changed)).not.toContain('pw-two');

      await jsonResponse(
        await controlRequest(
          runtime.runtime,
          runtime.controlKey,
          'POST',
          '/api/v1/config/import-harness',
          { config: updatedConfig, mode: 'upsert' },
        ),
      );

      // The server now runs the new command/args; the secret lives only in the credential.
      const servers = z
        .array(z.object({ slug: z.string(), transport: z.record(z.string(), z.unknown()) }).passthrough())
        .parse(
          await jsonResponse(
            await controlRequest(runtime.runtime, runtime.controlKey, 'GET', '/api/v1/servers'),
          ),
        );
      const mosaic = servers.find((server) => server.slug === 'mosaic');
      expect(mosaic?.transport.args).toEqual(['-y', 'mosaic-mcp@next']);
      expect(JSON.stringify(servers)).not.toContain('pw-two');
    } finally {
      await runtime.close();
    }
  });
});

const importReportSchema = z
  .object({
    mode: z.enum(['create', 'merge']),
    upsert: z.boolean(),
    dryRun: z.boolean(),
    credentials: z.array(z.object({ name: z.string(), status: z.string() }).passthrough()),
    servers: z.array(z.object({ slug: z.string(), status: z.string() }).passthrough()),
    clis: z.array(z.object({ slug: z.string(), status: z.string() }).passthrough()),
    installations: z.array(
      z.object({ entryId: z.string(), targetType: z.string(), targetSlug: z.string() }),
    ),
    counts: z.record(z.string(), z.number()),
  })
  .passthrough();

describe('configuration transfer', () => {
  async function seedSource(
    source: ReturnType<typeof createTestRuntime>,
  ): Promise<{ exportBody: unknown; credentialId: string }> {
    const credentialId = z.object({ id: z.string() }).parse(
      await jsonResponse(
        await controlRequest(source.runtime, source.controlKey, 'POST', '/api/v1/credentials', {
          name: 'laptop-env',
          payload: { type: 'env', variables: { GH_TOKEN: 'laptop-secret' } },
        }),
      ),
    ).id;
    // A node-placed server used to abort the whole import: the export dropped nodeId.
    await jsonResponse(
      await controlRequest(source.runtime, source.controlKey, 'POST', '/api/v1/servers', {
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
      await controlRequest(source.runtime, source.controlKey, 'POST', '/api/v1/servers', {
        slug: 'firecrawl',
        name: 'Firecrawl',
        kind: 'remote',
        transport: { type: 'streamable-http', url: 'https://mcp.firecrawl.dev/v2/mcp' },
        enabled: true,
        settings: {},
      }),
    );
    await jsonResponse(
      await controlRequest(source.runtime, source.controlKey, 'POST', '/api/v1/clis', {
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
    await jsonResponse(
      await controlRequest(source.runtime, source.controlKey, 'POST', '/api/v1/clis', {
        slug: 'azure-cli',
        name: 'Azure CLI (az)',
        command: 'mcr.microsoft.com/azure-cli:2.89.0',
        executionMode: 'docker',
        entrypoint: 'az',
        authStrategy: 'azure-service-principal',
        containerVolumes: [{ source: 'toolhome-azure-cli-state', target: '/root/.azure' }],
        allowList: { allow: [['account', 'show']], deny: [['login']] },
        credentialId,
        credentialBindings: { GH_TOKEN: 'env:GH_TOKEN' },
      }),
    );
    const exportBody = await jsonResponse(
      await controlRequest(
        source.runtime,
        source.controlKey,
        'GET',
        '/api/v1/config/export?includeSecrets=true',
      ),
    );
    return { exportBody, credentialId };
  }

  it('carries node placement and the CLI plane, and reinstates both on the target', async () => {
    const source = createTestRuntime();
    const destination = createTestRuntime();
    try {
      const { exportBody } = await seedSource(source);
      const report = importReportSchema.parse(
        await jsonResponse(
          await controlRequest(
            destination.runtime,
            destination.controlKey,
            'POST',
            '/api/v1/config/import',
            exportBody,
          ),
        ),
      );
      expect(report.counts.created).toBe(4);
      expect(report.servers.map((item) => item.status)).toEqual(['created', 'created']);
      expect(report.clis.map((item) => item.status)).toEqual(['created', 'created']);

      const servers = z
        .array(
          z
            .object({ slug: z.string(), kind: z.string(), nodeId: z.string().nullable() })
            .passthrough(),
        )
        .parse(
          await jsonResponse(
            await controlRequest(destination.runtime, destination.controlKey, 'GET', '/api/v1/servers'),
          ),
        );
      expect(servers.find((server) => server.slug === 'chrome-devtools')).toMatchObject({
        kind: 'node',
        nodeId: 'crayons-air',
      });

      const clis = await jsonResponse(
        await controlRequest(destination.runtime, destination.controlKey, 'GET', '/api/v1/clis'),
      );
      const azure = z
        .array(
          z
            .object({
              slug: z.string(),
              authStrategy: z.string(),
              containerVolumes: z.array(
                z.object({ source: z.string(), target: z.string(), readOnly: z.boolean() }),
              ),
              credentialBindings: z.record(z.string(), z.string()),
              credentialId: z.string().nullable(),
            })
            .passthrough(),
        )
        .parse(clis)
        .find((cli) => cli.slug === 'azure-cli');
      expect(azure).toMatchObject({
        authStrategy: 'azure-service-principal',
        containerVolumes: [{ source: 'toolhome-azure-cli-state', target: '/root/.azure', readOnly: false }],
        credentialBindings: { GH_TOKEN: 'env:GH_TOKEN' },
      });
      expect(azure?.credentialId).not.toBeNull();
      // The secret landed in an encrypted credential on the target, never in the record.
      expect(JSON.stringify(clis)).not.toContain('laptop-secret');
    } finally {
      await source.close();
      await destination.close();
    }
  });

  it('reports a dry run without writing, then applies in merge mode idempotently', async () => {
    const source = createTestRuntime();
    const destination = createTestRuntime();
    try {
      const { exportBody } = await seedSource(source);

      const preview = importReportSchema.parse(
        await jsonResponse(
          await controlRequest(
            destination.runtime,
            destination.controlKey,
            'POST',
            '/api/v1/config/import',
            { ...(exportBody as object), mode: 'merge', dryRun: true },
          ),
        ),
      );
      expect(preview.dryRun).toBe(true);
      expect(preview.servers.every((item) => item.status === 'created')).toBe(true);
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

      const first = importReportSchema.parse(
        await jsonResponse(
          await controlRequest(
            destination.runtime,
            destination.controlKey,
            'POST',
            '/api/v1/config/import',
            { ...(exportBody as object), mode: 'merge' },
          ),
        ),
      );
      expect(first.counts.created).toBe(4);

      const second = importReportSchema.parse(
        await jsonResponse(
          await controlRequest(
            destination.runtime,
            destination.controlKey,
            'POST',
            '/api/v1/config/import',
            { ...(exportBody as object), mode: 'merge' },
          ),
        ),
      );
      expect(second.counts.created).toBe(0);
      expect(second.counts.skipped).toBe(4);
      expect(second.credentials.every((item) => item.status === 'reused')).toBe(true);
      expect(
        z
          .array(z.unknown())
          .parse(
            await jsonResponse(
              await controlRequest(destination.runtime, destination.controlKey, 'GET', '/api/v1/clis'),
            ),
          ),
      ).toHaveLength(2);
    } finally {
      await source.close();
      await destination.close();
    }
  });

  it('refuses to merge over a credential whose payload differs, until --upsert', async () => {
    const source = createTestRuntime();
    const destination = createTestRuntime();
    try {
      const { exportBody } = await seedSource(source);
      await jsonResponse(
        await controlRequest(destination.runtime, destination.controlKey, 'POST', '/api/v1/credentials', {
          name: 'laptop-env',
          payload: { type: 'env', variables: { GH_TOKEN: 'different-secret' } },
        }),
      );
      const rejected = await controlRequest(
        destination.runtime,
        destination.controlKey,
        'POST',
        '/api/v1/config/import',
        { ...(exportBody as object), mode: 'merge' },
      );
      expect(rejected.status).toBe(409);
      expect(JSON.stringify(await rejected.json())).toContain('laptop-env');

      const upserted = importReportSchema.parse(
        await jsonResponse(
          await controlRequest(
            destination.runtime,
            destination.controlKey,
            'POST',
            '/api/v1/config/import',
            { ...(exportBody as object), mode: 'merge', upsert: true },
          ),
        ),
      );
      expect(upserted.credentials.filter((item) => item.status === 'updated')).toHaveLength(1);
      const credentials = z
        .array(z.object({ name: z.string() }).passthrough())
        .parse(
          await jsonResponse(
            await controlRequest(
              destination.runtime,
              destination.controlKey,
              'GET',
              '/api/v1/credentials',
            ),
          ),
        );
      expect(credentials).toHaveLength(1);
    } finally {
      await source.close();
      await destination.close();
    }
  });

  it('refuses a state transfer that is not backed by a writable Docker volume', async () => {
    const runtime = createTestRuntime();
    try {
      const host = z.object({ id: z.string() }).parse(
        await jsonResponse(
          await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/clis', {
            slug: 'host-tool',
            name: 'Host tool',
            command: '/usr/local/bin/tool',
            executionMode: 'host',
            allowList: { allow: [['--version']], deny: [] },
          }),
        ),
      );
      const notDocker = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'GET',
        `/api/v1/clis/${host.id}/state?volume=toolhome-gh-cli-state`,
      );
      expect(notDocker.status).toBe(400);
      expect(JSON.stringify(await notDocker.json())).toContain('keeps no container volume state');

      const docker = z.object({ id: z.string() }).parse(
        await jsonResponse(
          await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/clis', {
            slug: 'gh-cli',
            name: 'GitHub CLI (gh)',
            command: 'toolhome/gh-cli:2.97.0',
            executionMode: 'docker',
            entrypoint: 'gh',
            containerVolumes: [
              { source: 'toolhome-gh-cli-state', target: '/root/.config/gh' },
              { source: 'toolhome-gh-cli-cache', target: '/root/.cache/gh', readOnly: true },
            ],
            allowList: { allow: [['gh', '*']], deny: [] },
          }),
        ),
      );
      const unknown = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'GET',
        `/api/v1/clis/${docker.id}/state?volume=not-declared`,
      );
      expect(unknown.status).toBe(400);
      expect(JSON.stringify(await unknown.json())).toContain('declares no volume');

      const readOnly = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'POST',
        `/api/v1/clis/${docker.id}/state?volume=toolhome-gh-cli-cache`,
        { archive: Buffer.from('tar').toString('base64') },
      );
      expect(readOnly.status).toBe(400);
      expect(JSON.stringify(await readOnly.json())).toContain('read-only');

      const missingVolume = await controlRequest(
        runtime.runtime,
        runtime.controlKey,
        'GET',
        `/api/v1/clis/${docker.id}/state`,
      );
      expect(missingVolume.status).toBe(400);
    } finally {
      await runtime.close();
    }
  });

  it('keeps create mode failing on an existing slug and names the conflicts', async () => {
    const source = createTestRuntime();
    const destination = createTestRuntime();
    try {
      const { exportBody } = await seedSource(source);
      await jsonResponse(
        await controlRequest(destination.runtime, destination.controlKey, 'POST', '/api/v1/servers', {
          slug: 'firecrawl',
          name: 'Existing Firecrawl',
          kind: 'remote',
          transport: { type: 'streamable-http', url: 'https://other.example/mcp' },
          enabled: true,
          settings: {},
        }),
      );
      const rejected = await controlRequest(
        destination.runtime,
        destination.controlKey,
        'POST',
        '/api/v1/config/import',
        exportBody,
      );
      expect(rejected.status).toBe(409);
      const body = JSON.stringify(await rejected.json());
      expect(body).toContain('firecrawl');
      expect(body).toContain('mode merge');
      const credentials = z
        .array(z.unknown())
        .parse(
          await jsonResponse(
            await controlRequest(
              destination.runtime,
              destination.controlKey,
              'GET',
              '/api/v1/credentials',
            ),
          ),
        );
      expect(credentials).toHaveLength(0);
    } finally {
      await source.close();
      await destination.close();
    }
  });
});
