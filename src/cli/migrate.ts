import { z } from 'zod';

/**
 * Move a configuration export from one ToolHome instance to another.
 *
 * Order matters. A Market entry creates its own credential, record and
 * installation record, so reinstalling first and importing afterwards lets the
 * import pass skip what the Market already provisioned and keep provenance for
 * it. Importing first would collide on the entry's slug.
 */

export interface ControlApi {
  request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown>;
}

const credentialPayloadSchema = z
  .object({
    type: z.enum(['bearer', 'api-key', 'headers', 'env', 'oauth']),
    token: z.string().optional(),
    value: z.string().optional(),
    variables: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const exportSchema = z.object({
  credentials: z
    .array(
      z.object({
        ref: z.string(),
        name: z.string(),
        type: z.string(),
        payload: credentialPayloadSchema.optional(),
      }),
    )
    .default([]),
  servers: z.array(z.object({ slug: z.string(), kind: z.string() }).passthrough()).default([]),
  clis: z.array(z.object({ slug: z.string() }).passthrough()).default([]),
  installations: z
    .array(
      z.object({
        entryId: z.string(),
        targetType: z.enum(['server', 'cli']),
        targetSlug: z.string(),
        credentialRef: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

const marketEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    plane: z.enum(['mcp', 'cli']),
    installed: z.boolean().default(false),
    requires: z
      .array(
        z.object({
          name: z.string(),
          secret: z.boolean().default(false),
          required: z.boolean().default(false),
        }),
      )
      .default([]),
    credential: z
      .object({
        type: z.enum(['none', 'oauth', 'env', 'bearer', 'api-key', 'headers']),
        tokenKey: z.string().optional(),
        valueKey: z.string().optional(),
        headers: z
          .array(
            z.object({
              name: z.string(),
              valueKey: z.string().optional(),
              value: z.string().optional(),
            }),
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

const importReportSchema = z
  .object({
    counts: z.record(z.string(), z.number()).default({}),
    servers: z.array(z.object({ slug: z.string(), status: z.string() }).passthrough()).default([]),
    clis: z.array(z.object({ slug: z.string(), status: z.string() }).passthrough()).default([]),
    credentials: z
      .array(z.object({ name: z.string(), status: z.string() }).passthrough())
      .default([]),
  })
  .passthrough();

const statusSchema = z
  .object({
    installed: z.boolean().nullable(),
    version: z.string().nullable(),
    loggedIn: z.boolean(),
  })
  .passthrough();

export interface ReinstallOutcome {
  entryId: string;
  plane: 'mcp' | 'cli';
  status: 'pending' | 'installed' | 'already-installed' | 'needs-secret' | 'failed' | 'not-in-catalog';
  detail?: string;
}

export interface StateTransferOutcome {
  slug: string;
  volume: string;
  status: 'moved' | 'failed';
  bytes?: number;
  detail?: string;
}

export interface MigrationReport {
  dryRun: boolean;
  source: { servers: number; clis: number; credentials: number; installations: number };
  target: { servers: number; clis: number; credentials: number };
  reinstalls: ReinstallOutcome[];
  imported: z.infer<typeof importReportSchema>;
  stateTransfers: StateTransferOutcome[];
  verification: {
    clis: { slug: string; installed: boolean | null; version: string | null; loggedIn: boolean }[];
    mcpOk: boolean | null;
  };
  oauthRegistrationsReset: string[];
  accessKey: { name: string; key: string; snippet: string } | null;
  manual: string[];
}

export interface MigrationOptions {
  planes?: { mcp: boolean; cli: boolean };
  dryRun?: boolean;
  withState?: boolean;
  resetOauthClients?: boolean;
  accessKeyName?: string;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export async function migrateConfiguration(
  source: ControlApi,
  target: ControlApi,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const planes = options.planes ?? { mcp: true, cli: true };
  const dryRun = options.dryRun === true;
  const log = options.log ?? ((): void => {});

  log('reading the source instance');
  const exported = exportSchema.parse(
    await source.request('GET', '/api/v1/config/export?includeSecrets=true'),
  );
  const sourceMarket = parseMarket(await source.request('GET', '/api/v1/market'));
  const targetMarket = parseMarket(await target.request('GET', '/api/v1/market'));
  const targetOverview = z
    .object({ servers: z.object({ total: z.number() }), clis: z.object({ total: z.number() }), credentials: z.number() })
    .passthrough()
    .parse(await target.request('GET', '/api/v1/overview'));

  const servers = planes.mcp ? exported.servers : [];
  const clis = planes.cli ? exported.clis : [];
  const usedRefs = new Set<string>();
  for (const installation of exported.installations) {
    if (planes.mcp && installation.targetType === 'server') usedRefs.add(installation.credentialRef ?? '');
    if (planes.cli && installation.targetType === 'cli') usedRefs.add(installation.credentialRef ?? '');
  }
  const credentials = exported.credentials.filter((credential) => {
    if (usedRefs.has(credential.ref)) return true;
    return [...servers, ...clis].some(
      (record) => 'credentialRef' in record && (record as { credentialRef?: string }).credentialRef === credential.ref,
    );
  });

  const body = {
    version: 1,
    secretsIncluded: true,
    mode: 'merge',
    upsert: false,
    credentials,
    servers,
    clis,
    installations: exported.installations,
  };

  const reinstalls: ReinstallOutcome[] = [];
  const pendingValues = new Map<number, Record<string, string>>();
  for (const installation of exported.installations) {
    const plane = installation.targetType === 'cli' ? 'cli' : 'mcp';
    if (plane === 'cli' && !planes.cli) continue;
    if (plane === 'mcp' && !planes.mcp) continue;
    const entry = sourceMarket.get(installation.entryId);
    const targetEntry = targetMarket.get(installation.entryId);
    if (entry === undefined || targetEntry === undefined) {
      reinstalls.push({
        entryId: installation.entryId,
        plane,
        status: 'not-in-catalog',
        detail: 'the target catalog has no such entry; the record is imported as plain configuration',
      });
      continue;
    }
    if (targetEntry.installed) {
      reinstalls.push({ entryId: entry.id, plane, status: 'already-installed' });
      continue;
    }
    const harvest = harvestValues(entry, installation.credentialRef, exported.credentials);
    if (harvest.missing.length > 0) {
      reinstalls.push({
        entryId: entry.id,
        plane,
        status: 'needs-secret',
        detail: `no stored value for ${harvest.missing.join(', ')}`,
      });
      continue;
    }
    pendingValues.set(reinstalls.length, harvest.values);
    reinstalls.push({ entryId: entry.id, plane, status: 'pending' });
  }

  const applyImport = async (isDryRun: boolean): Promise<z.infer<typeof importReportSchema>> =>
    importReportSchema.parse(
      await target.request('POST', '/api/v1/config/import', { ...body, dryRun: isDryRun }),
    );

  let imported: z.infer<typeof importReportSchema>;
  if (dryRun) {
    imported = await applyImport(true);
  } else {
    // Install first: each Market entry provisions its own credential, record and
    // installation record, and the import pass then skips what already exists.
    log('reinstalling Market entries');
    for (const [index, outcome] of reinstalls.entries()) {
      if (outcome.status !== 'pending') continue;
      const values = pendingValues.get(index) ?? {};
      try {
        const job = z
          .object({
            jobId: z.string().nullable(),
            status: z.string(),
            actionUrl: z.string().optional(),
          })
          .passthrough()
          .parse(
            await target.request('POST', `/api/v1/market/${outcome.entryId}/install`, { values }),
          );
        if (job.status === 'awaiting_secret') {
          reinstalls[index] = {
            entryId: outcome.entryId,
            plane: outcome.plane,
            status: 'needs-secret',
            detail: `complete the one-time URL on the target: ${job.actionUrl ?? '(see the console)'}`,
          };
          continue;
        }
        await waitForJob(target, job.jobId, options);
        reinstalls[index] = { entryId: outcome.entryId, plane: outcome.plane, status: 'installed' };
      } catch (error) {
        reinstalls[index] = {
          entryId: outcome.entryId,
          plane: outcome.plane,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    log('importing the records the Market did not create');
    imported = await applyImport(false);
  }

  const report: MigrationReport = {
    dryRun,
    source: {
      servers: exported.servers.length,
      clis: exported.clis.length,
      credentials: exported.credentials.length,
      installations: exported.installations.length,
    },
    target: {
      servers: targetOverview.servers.total,
      clis: targetOverview.clis.total,
      credentials: targetOverview.credentials,
    },
    reinstalls,
    imported,
    stateTransfers: [],
    verification: { clis: [], mcpOk: null },
    oauthRegistrationsReset: [],
    accessKey: null,
    manual: [],
  };
  if (dryRun) {
    report.manual.push(...manualFollowUps(report, exported.credentials, options));
    return report;
  }

  if (options.withState === true && planes.cli) {
    log('moving hosted CLI login state');
    const sourceClis = z
      .array(
        z.object({
          slug: z.string(),
          containerVolumes: z
            .array(z.object({ source: z.string(), readOnly: z.boolean().default(false) }).passthrough())
            .default([]),
        })
        .passthrough(),
      )
      .parse(await source.request('GET', '/api/v1/clis'));
    for (const cli of sourceClis) {
      for (const volume of cli.containerVolumes) {
        if (volume.readOnly) continue;
        try {
          const exported = z
            .object({ archive: z.string(), bytes: z.number() })
            .parse(
              await source.request(
                'GET',
                `/api/v1/clis/${encodeURIComponent(cli.slug)}/state?volume=${encodeURIComponent(volume.source)}`,
                undefined,
                120_000,
              ),
            );
          const restored = z
            .object({ bytes: z.number() })
            .parse(
              await target.request(
                'POST',
                `/api/v1/clis/${encodeURIComponent(cli.slug)}/state?volume=${encodeURIComponent(volume.source)}`,
                { archive: exported.archive },
                120_000,
              ),
            );
          report.stateTransfers.push({
            slug: cli.slug,
            volume: volume.source,
            status: 'moved',
            bytes: restored.bytes,
          });
        } catch (error) {
          report.stateTransfers.push({
            slug: cli.slug,
            volume: volume.source,
            status: 'failed',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  if (options.resetOauthClients === true) {
    log('resetting OAuth client registrations that point at the source origin');
    const targetCredentials = z
      .array(z.object({ id: z.string(), name: z.string(), type: z.string() }).passthrough())
      .parse(await target.request('GET', '/api/v1/credentials'));
    const carried = new Set(exported.credentials.map((credential) => credential.name));
    for (const credential of targetCredentials) {
      if (credential.type !== 'oauth' || !carried.has(credential.name)) continue;
      try {
        await target.request('POST', `/api/v1/credentials/${credential.id}/reset-oauth-registration`);
        report.oauthRegistrationsReset.push(credential.name);
      } catch {
        // A credential the target cannot resolve is reported through the manual list.
      }
    }
  }

  if (planes.cli) {
    log('verifying hosted CLIs on the target');
    const targetClis = z
      .array(z.object({ slug: z.string(), enabled: z.boolean() }).passthrough())
      .parse(await target.request('GET', '/api/v1/clis'));
    for (const cli of targetClis) {
      try {
        const status = statusSchema.parse(await target.request('GET', `/cli/${cli.slug}/status`));
        report.verification.clis.push({ slug: cli.slug, ...status });
      } catch (error) {
        report.verification.clis.push({
          slug: cli.slug,
          installed: null,
          version: null,
          loggedIn: false,
        });
        log(`  ${cli.slug}: probe failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }
  if (planes.mcp) {
    try {
      const diagnostics = z.object({ ok: z.boolean() }).passthrough().parse(
        await target.request('GET', '/api/v1/diagnostics'),
      );
      report.verification.mcpOk = diagnostics.ok;
    } catch {
      report.verification.mcpOk = null;
    }
  }

  if (options.accessKeyName !== undefined) {
    const issued = z.object({ key: z.string() }).parse(
      await target.request('POST', '/api/v1/access-keys', { name: options.accessKeyName }),
    );
    report.accessKey = {
      name: options.accessKeyName,
      key: issued.key,
      snippet: JSON.stringify({ mcpServers: { toolhome: { url: '<target>/mcp', headers: { Authorization: `Bearer ${issued.key}` } } } }, null, 2),
    };
  }

  report.manual.push(...manualFollowUps(report, exported.credentials, options));
  return report;
}

function parseMarket(value: unknown): Map<string, z.infer<typeof marketEntrySchema>> {
  return new Map(
    z.array(marketEntrySchema).parse(value).map((entry) => [entry.id, entry]),
  );
}

/** Reconstruct the values a Market install needs from the exported credential. */
export function harvestValues(
  entry: z.infer<typeof marketEntrySchema>,
  credentialRef: string | null,
  credentials: z.infer<typeof exportSchema>['credentials'],
): { values: Record<string, string>; missing: string[] } {
  const credential =
    credentials.find((item) => item.ref === credentialRef) ??
    credentials.find((item) => item.name === entry.name);
  const payload = credential?.payload;
  let values: Record<string, string> = {};
  if (entry.credential.type === 'env') {
    values = { ...(payload?.variables ?? {}) };
  } else if (entry.credential.type === 'bearer' && entry.credential.tokenKey !== undefined) {
    if (payload?.token !== undefined) values[entry.credential.tokenKey] = payload.token;
  } else if (entry.credential.type === 'api-key' && entry.credential.valueKey !== undefined) {
    if (payload?.value !== undefined) values[entry.credential.valueKey] = payload.value;
  } else if (entry.credential.type === 'headers') {
    for (const header of entry.credential.headers ?? []) {
      if (header.valueKey === undefined) continue;
      const stored = payload?.headers?.[header.name];
      if (stored !== undefined) values[header.valueKey] = stored;
    }
  }
  const missing = entry.requires
    .filter((requirement) => requirement.required && values[requirement.name] === undefined)
    .map((requirement) => requirement.name);
  return { values, missing };
}

async function waitForJob(
  target: ControlApi,
  jobId: string | null,
  options: MigrationOptions,
): Promise<void> {
  if (jobId === null) return;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  for (;;) {
    const job = z
      .object({ status: z.string(), step: z.string().default(''), error: z.string().optional() })
      .passthrough()
      .parse(await target.request('GET', `/api/v1/market/install/${jobId}`));
    if (job.status === 'failed') throw new Error(job.error ?? `install ${jobId} failed`);
    if (job.status !== 'installing' && job.status !== 'updating') return;
    await sleep(options.pollIntervalMs ?? 1_500);
  }
}

function manualFollowUps(
  report: MigrationReport,
  credentials: z.infer<typeof exportSchema>['credentials'],
  options: MigrationOptions,
): string[] {
  const manual: string[] = [];
  if (report.accessKey === null) {
    manual.push(
      'Access keys are stored as digests and cannot be moved: create one on the target with `toolhome access-key create <name>` and re-point every harness.',
    );
  }
  for (const cli of report.verification.clis) {
    if (cli.loggedIn) continue;
    const moved = report.stateTransfers.some(
      (transfer) => transfer.slug === cli.slug && transfer.status === 'moved',
    );
    manual.push(
      moved
        ? `Hosted CLI "${cli.slug}" received its state volume and still reports no login: run \`toolhome cli adopt ${cli.slug}\` while its credential is still available locally.`
        : `Hosted CLI "${cli.slug}" has no login state on the target yet: run \`toolhome cli adopt ${cli.slug}\` while its credential is still available locally.`,
    );
  }
  for (const transfer of report.stateTransfers) {
    if (transfer.status === 'failed') {
      manual.push(
        `State volume "${transfer.volume}" of "${transfer.slug}" did not move: ${transfer.detail ?? ''}`,
      );
    }
  }
  for (const outcome of report.reinstalls) {
    if (outcome.status === 'needs-secret') {
      manual.push(`Market entry "${outcome.entryId}" needs a value on the target: ${outcome.detail ?? ''}`);
    }
    if (outcome.status === 'failed') {
      manual.push(`Market entry "${outcome.entryId}" failed to reinstall: ${outcome.detail ?? ''}`);
    }
  }
  for (const credential of credentials) {
    if (credential.type === 'oauth' && options.resetOauthClients !== true) {
      manual.push(
        `OAuth credential "${credential.name}" kept its client registration, which points at the source origin: re-run with --reset-oauth-clients, then \`toolhome credential authorize ${credential.name}\` on the target.`,
      );
    }
  }
  if (report.verification.mcpOk === false) {
    manual.push('The target reports unhealthy MCP servers: run `toolhome doctor` there.');
  }
  return manual;
}
