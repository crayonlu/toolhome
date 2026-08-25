import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { marketCatalog, entryPlane, type MarketEntry } from './catalog.js';
import { AppError } from '../domain/errors.js';
import type { ControlService } from '../control/control-service.js';
import type {
  CredentialPayload,
  InstallJobRecord,
  MarketInstallation,
  SecureActionRecord,
} from '../domain/models.js';
import type { Store } from '../storage/store.js';
import type { SecureActionService } from '../security/secure-action.js';
import { fingerprint } from '../upstream/stable-json.js';

export interface InstallJobView {
  id: string;
  entryId: string;
  status: InstallJobRecord['status'];
  step: string;
  output: string;
  result?: unknown;
  error?: string;
  actionUrl?: string;
}

interface LiveJob {
  record: InstallJobRecord;
  output: string;
  result?: unknown;
  error?: string;
}

type EntryOperation = { kind: 'job'; id: string } | { kind: 'uninstall'; id: string };

export class MarketService {
  readonly #service: ControlService;
  readonly #store: Store;
  readonly #actions: SecureActionService;
  readonly #marketDir: string;
  readonly #uvEnv: Record<string, string>;
  readonly #jobs = new Map<string, LiveJob>();
  /** One in-flight mutating operation per catalog entry in this process. */
  readonly #entryOperations = new Map<string, EntryOperation>();

  constructor(
    service: ControlService,
    store: Store,
    actions: SecureActionService,
    marketDir: string,
    dataDir?: string,
    uvIndexUrl?: string,
  ) {
    this.#service = service;
    this.#store = store;
    this.#actions = actions;
    this.#marketDir = marketDir;
    const uvRoot = dataDir === undefined ? marketDir : join(dataDir, '.uv');
    this.#uvEnv = {
      UV_CACHE_DIR: join(uvRoot, 'cache'),
      UV_TOOL_DIR: join(uvRoot, 'tools'),
      UV_TOOL_BIN_DIR: join(uvRoot, 'tools', 'bin'),
      UV_COMPILE_BYTECODE: '0',
      ...(uvIndexUrl === undefined ? {} : { UV_DEFAULT_INDEX: uvIndexUrl }),
    };
    // A fresh process never carries in-flight installs; surface them as
    // interrupted so they are visible and retryable instead of silently lost.
    this.#store.markInterruptedInstallJobs();
  }

  list() {
    const servers = this.#service.listServers();
    return marketCatalog.map((entry) => {
      const installation = this.#store.getInstallation(entry.id);
      const plane = entryPlane(entry);
      const installed =
        plane === 'cli'
          ? this.#store.getCliBySlug(entry.id) !== null
          : servers.some((server) => server.slug === entry.id);
      return {
        ...entry,
        plane,
        installed,
        installedVersion: installation?.entryVersion ?? null,
        updateAvailable:
          installation !== null && (entry.version ?? 'unpinned') !== installation.entryVersion,
      };
    });
  }

  /**
   * Per-entry version drift: installed version vs the catalog pin (deterministic,
   * no network) plus a best-effort upstream lookup (registry JSON, short timeout).
   */
  async updates() {
    const entries = marketCatalog
      .map((entry) => ({ entry, installation: this.#store.getInstallation(entry.id) }))
      .filter((item) => item.installation !== null);
    return Promise.all(
      entries.map(async ({ entry, installation }) => {
        const catalogVersion = entry.version ?? 'unpinned';
        return {
          entryId: entry.id,
          installedVersion: installation!.entryVersion,
          catalogVersion,
          updateAvailable: catalogVersion !== installation!.entryVersion,
          latestUpstream: await this.#latestUpstream(entry),
        };
      }),
    );
  }

  /**
   * Explicit update to the catalog's current pin. Reinstalls the package, bumps
   * the installation record, and restarts the server — the credential and
   * visibility configuration survive. On failure the old process keeps running.
   */
  async update(id: string): Promise<{ jobId: string | null; status: string }> {
    const entry = this.#entry(id);
    this.#assertEntryAvailable(entry.id);
    const installation = this.#store.getInstallation(entry.id);
    if (!installation) {
      throw new AppError('market_not_installed', `Market entry "${id}" is not installed`, 404);
    }
    const catalogVersion = entry.version ?? 'unpinned';
    if (installation.entryVersion === catalogVersion) {
      return { jobId: null, status: 'up_to_date' };
    }
    const job = this.#createJob(entry, entry.version ?? null, 'updating');
    this.#claimEntry(entry.id, job.record.id);
    try {
      this.#update(job, { step: 'starting update' });
      void this.#runUpdate(entry, installation, job);
      return { jobId: job.record.id, status: 'updating' };
    } catch (error) {
      this.#releaseEntry(entry.id, job.record.id);
      throw error;
    }
  }

  installations() {
    return this.#store.listInstallations();
  }

  getJob(jobId: string): InstallJobView {
    const live = this.#jobs.get(jobId);
    if (live) {
      if (live.record.status === 'awaiting_secret') {
        return this.#expireIfActionStale(live.record);
      }
      return this.#view(live);
    }
    const record = this.#store.getInstallJob(jobId);
    if (!record) throw new AppError('market_job_not_found', 'Install job not found', 404);
    if (record.status === 'awaiting_secret') return this.#expireIfActionStale(record);
    return {
      id: record.id,
      entryId: record.entryId,
      status: record.status,
      step: record.step,
      output: record.boundedOutput,
      error: record.errorCode ?? undefined,
    };
  }

  async install(
    id: string,
    values: Record<string, string> = {},
    principalId = 'cli',
  ): Promise<{
    jobId: string | null;
    status: string;
    actionId?: string;
    actionUrl?: string;
    installed?: unknown;
  }> {
    const entry = this.#entry(id);
    this.#assertEntryAvailable(entry.id);
    const existing = this.#store.getInstallation(entry.id);
    if (existing) {
      const target =
        existing.targetType === 'server'
          ? this.#store.getServer(existing.targetId)
          : this.#store.getCli(existing.targetId);
      if (target !== null) {
        return {
          jobId: null,
          status: 'already_installed',
          installed: {
            entryId: entry.id,
            version: existing.entryVersion,
            targetType: existing.targetType,
            targetId: existing.targetId,
            slug: target.slug,
          },
        };
      }
      // A prior uninstall may have removed the target after its marker write.
      // Remove the stale marker so a retry can provision a clean target.
      for (const installation of this.#store
        .listInstallations()
        .filter((item) => item.entryId === entry.id)) {
        this.#store.deleteInstallation(installation.id);
      }
    }
    for (const requirement of entry.requires) {
      if (requirement.required && !requirement.secret && !values[requirement.name]) {
        throw new AppError(
          'market_missing_value',
          `Missing required value ${requirement.name}`,
          400,
        );
      }
    }
    const missingSecrets = entry.requires.filter(
      (requirement) => requirement.required && requirement.secret && !values[requirement.name],
    );
    const requestedVersion = entry.version ?? null;
    const job = this.#createJob(
      entry,
      requestedVersion,
      missingSecrets.length > 0 ? 'awaiting_secret' : 'installing',
    );
    this.#claimEntry(entry.id, job.record.id);

    try {
      if (missingSecrets.length > 0) {
        // URL-mode elicitation: never accept the secret through tool arguments.
        const { action, url } = this.#actions.create('market_install', job.record.id, principalId);
        this.#updateRecord(job, { actionId: action.id });
        return {
          jobId: job.record.id,
          status: 'awaiting_secret',
          actionId: action.id,
          actionUrl: url,
        };
      }

      this.#startInstall(entry, values, job);
      return { jobId: job.record.id, status: 'installing' };
    } catch (error) {
      this.#releaseEntry(entry.id, job.record.id);
      throw error;
    }
  }

  #startInstall(entry: MarketEntry, values: Record<string, string>, job: LiveJob): void {
    this.#update(job, { step: 'starting' });
    if (entryPlane(entry) === 'cli') {
      void this.#runCliInstall(entry, values, job);
    } else {
      void this.#runInstall(entry, values, job);
    }
  }

  /** Completes a URL-mode secret action and resumes the linked install job. */
  async completeAction(
    actionId: string,
    token: string,
    principalId: string | undefined,
    values: Record<string, string>,
  ): Promise<InstallJobView> {
    const actionRecord = this.#store.getSecureAction(actionId);
    if (actionRecord === null) {
      throw new AppError('secure_action_not_found', 'Secure action not found', 404);
    }
    let pending: SecureActionRecord;
    try {
      pending = this.#actions.verify(actionId, token, principalId);
    } catch (error) {
      if (actionRecord.status === 'pending' && Date.parse(actionRecord.expiresAt) <= Date.now()) {
        const expiredJob = this.#store.getInstallJob(actionRecord.target);
        if (expiredJob) this.#releaseEntry(expiredJob.entryId, expiredJob.id);
      }
      throw error;
    }
    const pendingJob = this.#store.getInstallJob(pending.target);
    if (!pendingJob || pendingJob.status !== 'awaiting_secret') {
      if (pendingJob) this.#releaseEntry(pendingJob.entryId, pendingJob.id);
      throw new AppError(
        'market_job_not_found',
        'Install job not found or not awaiting a secret',
        404,
      );
    }
    const entry = this.#entry(pendingJob.entryId);
    const heldBy = this.#entryOperations.get(entry.id);
    if (heldBy !== undefined && heldBy.id !== pendingJob.id) {
      throw new AppError(
        'market_operation_in_progress',
        `Market entry "${entry.id}" already has an operation in progress`,
        409,
      );
    }
    const claimed = heldBy === undefined;
    if (claimed) this.#claimEntry(entry.id, pendingJob.id);

    try {
      const completed = this.#store.transaction(() => {
        // Consume the action and transition its job together. If the job is no
        // longer resumable, the transaction rolls back and the URL remains usable.
        const action = this.#actions.complete(actionId, token, principalId, values);
        const record = this.#store.getInstallJob(action.target);
        if (!record || record.status !== 'awaiting_secret') {
          throw new AppError(
            'market_job_not_found',
            'Install job not found or not awaiting a secret',
            404,
          );
        }
        const job = this.#store.updateInstallJob(record.id, {
          status: 'installing',
          step: 'starting',
        });
        return { action, job };
      });
      const live = this.#jobs.get(completed.action.target) ?? {
        record: completed.job,
        output: completed.job.boundedOutput,
      };
      live.record = completed.job;
      this.#jobs.set(completed.action.target, live);
      this.#startInstall(entry, values, live);
      return this.#view(live);
    } catch (error) {
      if (claimed) this.#releaseEntry(entry.id, pendingJob.id);
      throw error;
    }
  }

  /** Reads a pending action's required secret fields after validating its URL token. */
  secureActionInfo(actionId: string, token: string | undefined, principalId?: string) {
    if (token === undefined || token === '') {
      throw new AppError('secure_action_invalid', 'Secure action token is required', 400);
    }
    const action = this.#actions.verify(actionId, token, principalId);
    const job = this.#store.getInstallJob(action.target);
    const entry = job ? marketCatalog.find((item) => item.id === job.entryId) : undefined;
    return {
      actionId: action.id,
      status: action.status,
      entryId: entry?.id ?? null,
      entryName: entry?.name ?? null,
      fields: (entry?.requires ?? [])
        .filter((requirement) => requirement.secret)
        .map((requirement) => ({
          name: requirement.name,
          description: requirement.description,
        })),
    };
  }

  async uninstall(id: string) {
    const entry = this.#entry(id);
    const operationId = `uninstall:${randomUUID()}`;
    this.#assertEntryAvailable(entry.id);
    this.#entryOperations.set(entry.id, { kind: 'uninstall', id: operationId });
    try {
      if (entryPlane(entry) === 'cli') {
        const cli = this.#store.getCliBySlug(entry.id);
        if (!cli) {
          throw new AppError('market_not_installed', `Market entry "${id}" is not installed`, 404);
        }
        this.#store.transaction(() => {
          if (cli.credentialId) this.#store.deleteCredential(cli.credentialId);
          this.#store.deleteCli(cli.id);
          for (const installation of this.#store
            .listInstallations()
            .filter((item) => item.entryId === entry.id)) {
            this.#store.deleteInstallation(installation.id);
          }
        });
      } else {
        const servers = this.#service.listServers().filter((server) => server.slug === entry.id);
        if (servers.length === 0) {
          throw new AppError('market_not_installed', `Market entry "${id}" is not installed`, 404);
        }
        const installations = this.#store
          .listInstallations()
          .filter((item) => item.entryId === entry.id);
        // Remove the marker before touching runtime-backed resources. If marker
        // cleanup fails, the target and its credential remain untouched.
        this.#store.transaction(() => {
          for (const installation of installations) {
            this.#store.deleteInstallation(installation.id);
          }
        });
        try {
          for (const server of servers) {
            if (server.credentialId) await this.#service.deleteCredential(server.credentialId);
            await this.#service.deleteServer(server.id);
          }
        } catch (error) {
          // Restore the marker when an upstream/runtime deletion fails so the
          // next uninstall can retry the same installation.
          try {
            this.#store.transaction(() => {
              for (const installation of installations) {
                this.#store.createInstallation({
                  source: installation.source,
                  entryId: installation.entryId,
                  entryVersion: installation.entryVersion,
                  recipeRevision: installation.recipeRevision,
                  targetType: installation.targetType,
                  targetId: installation.targetId,
                  credentialId: installation.credentialId,
                });
              }
            });
          } catch {
            // Preserve the original deletion error if compensation also fails.
          }
          throw error;
        }
      }
    } finally {
      this.#releaseEntry(entry.id, operationId);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * CLI-plane install: no package fetch happens here — `cli-image` entries run
   * a pinned upstream image per exec and `cli-binary` entries use a host
   * binary, so "installing" means creating the Env credential (values become
   * injected variables), the CLI record (allow-list from the catalog), and
   * the installation marker.
   */
  async #runCliInstall(entry: MarketEntry, values: Record<string, string>, job: LiveJob) {
    let credential: ReturnType<ControlService['createCredential']> | undefined;
    let cli: ReturnType<Store['createCli']> | undefined;
    let installation: MarketInstallation | undefined;
    try {
      this.#update(job, { step: 'creating credential' });
      credential = this.#service.createCredential({
        name: entry.name,
        payload: this.#credentialPayload(entry, values),
      });
      this.#update(job, { step: 'creating CLI record' });
      const command = entry.kind === 'cli-image' ? (entry.image ?? '') : (entry.bin ?? entry.id);
      const allowList = entry.allowList;
      if (allowList === undefined || allowList.allow.length === 0) {
        throw new AppError(
          'market_cli_allow_list_required',
          `Market CLI entry "${entry.id}" must declare an argv allow-list`,
          400,
        );
      }
      const provisioned = this.#store.transaction(() => {
        const createdCli = this.#store.createCli({
          slug: entry.id,
          name: entry.name,
          command,
          executionMode: entry.kind === 'cli-image' ? 'docker' : 'host',
          entrypoint: entry.kind === 'cli-image' ? (entry.entrypoint ?? null) : null,
          allowList,
          interactive: false,
          credentialId: credential!.id,
          probe: entry.probe ?? { command, args: ['--version'] },
          enabled: true,
          timeoutMs: 120_000,
          maxOutputBytes: 64 * 1024,
        });
        const createdInstallation = this.#store.createInstallation({
          source: 'curated',
          entryId: entry.id,
          entryVersion: entry.version ?? 'unpinned',
          recipeRevision: fingerprint(entry),
          targetType: 'cli',
          targetId: createdCli.id,
          credentialId: credential!.id,
        });
        return { cli: createdCli, installation: createdInstallation };
      });
      cli = provisioned.cli;
      installation = provisioned.installation;
      this.#update(job, {
        step: 'done',
        result: {
          entryId: entry.id,
          cliId: cli.id,
          slug: cli.slug,
          credential,
          installation,
        },
      });
      this.#updateRecord(job, { status: 'completed', resultReference: installation.id });
    } catch (error) {
      try {
        if (installation !== undefined) this.#store.deleteInstallation(installation.id);
        if (cli !== undefined) this.#store.deleteCli(cli.id);
        if (credential !== undefined) await this.#service.deleteCredential(credential.id);
      } catch {
        // Preserve the original install error if cleanup also fails.
      }
      try {
        this.#update(job, {
          step: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        this.#updateRecord(job, {
          status: 'failed',
          errorCode: error instanceof AppError ? error.code : 'market_install_failed',
        });
      } catch {
        // The runtime may have been torn down mid-install; nothing to persist.
      }
    } finally {
      this.#releaseEntry(entry.id, job.record.id);
    }
  }

  #createJob(
    entry: MarketEntry,
    requestedVersion: string | null,
    status: InstallJobRecord['status'],
  ): LiveJob {
    const record = this.#store.createInstallJob({
      entryId: entry.id,
      requestedVersion,
      // Unique per attempt: a failed/interrupted job keeps its row (audit),
      // and retrying must not collide on the UNIQUE constraint. Post-success
      // duplicates are already rejected by the already-installed check.
      idempotencyKey: `${entry.id}:${requestedVersion ?? 'latest'}:${randomUUID()}`,
      status,
      step: status,
      boundedOutput: '',
      resultReference: null,
      actionId: null,
      errorCode: null,
    });
    const live: LiveJob = { record, output: '' };
    this.#jobs.set(record.id, live);
    return live;
  }

  #view(live: LiveJob): InstallJobView {
    return {
      id: live.record.id,
      entryId: live.record.entryId,
      status: live.record.status,
      step: live.record.step,
      output: live.output || live.record.boundedOutput,
      ...(live.result === undefined ? {} : { result: live.result }),
      ...(live.error === undefined ? {} : { error: live.error }),
    };
  }

  /**
   * A waiting job whose secret link has passed its TTL can never resume. Fail it
   * on read so pollers observe a terminal state, and release the entry claim so
   * a retry can start; the action itself stays pending until someone consumes
   * or the store prunes it.
   */
  #expireIfActionStale(record: InstallJobRecord): InstallJobView {
    const action = record.actionId === null ? null : this.#store.getSecureAction(record.actionId);
    if (
      action !== null &&
      action.status === 'pending' &&
      Date.parse(action.expiresAt) <= Date.now()
    ) {
      this.#releaseEntry(record.entryId, record.id);
      const failed = this.#store.updateInstallJob(record.id, {
        status: 'failed',
        step: 'secure action expired',
        errorCode: 'secure_action_expired',
      });
      return {
        id: failed.id,
        entryId: failed.entryId,
        status: failed.status,
        step: failed.step,
        output: failed.boundedOutput,
        error: failed.errorCode ?? undefined,
      };
    }
    return {
      id: record.id,
      entryId: record.entryId,
      status: record.status,
      step: record.step,
      output: record.boundedOutput,
      error: record.errorCode ?? undefined,
    };
  }

  #update(
    job: LiveJob,
    patch: { step?: string; output?: string; result?: unknown; error?: string },
  ) {
    if (patch.step !== undefined) {
      this.#updateRecord(job, { step: patch.step });
    }
    if (patch.output !== undefined) {
      job.output = patch.output;
      this.#updateRecord(job, { boundedOutput: patch.output });
    }
    if (patch.result !== undefined) job.result = patch.result;
    if (patch.error !== undefined) job.error = patch.error;
  }

  #updateRecord(job: LiveJob, patch: Partial<InstallJobRecord>) {
    job.record = this.#store.updateInstallJob(job.record.id, patch);
  }

  async #runInstall(entry: MarketEntry, values: Record<string, string>, job: LiveJob) {
    try {
      if (entry.kind === 'home-stdio') {
        await this.#npmInstall(entry, job);
      } else if (entry.kind === 'uvx') {
        await this.#uvxInstall(entry, job);
      } else if (entry.kind === 'docker') {
        await this.#dockerInstall(entry, job);
      }
      this.#update(job, { step: 'creating credential' });
      const credential = this.#service.createCredential({
        name: entry.name,
        payload: this.#credentialPayload(entry, values),
      });
      this.#update(job, { step: 'creating server' });
      let result: unknown;
      if (entry.kind === 'home-stdio') {
        const args = (entry.argsTemplate ?? []).map((argument) =>
          argument.replace(/\$\{([^}]+)\}/g, (_, key: string) => values[key] ?? ''),
        );
        result = {
          server: await this.#service.createServer({
            slug: entry.id,
            name: entry.name,
            kind: 'home',
            transport: { type: 'stdio', command: this.#binPath(entry), args },
            credentialId: credential.id,
            enabled: true,
          }),
          credential,
        };
      } else if (entry.kind === 'uvx') {
        const args = [
          entry.package ?? entry.id,
          ...(entry.argsTemplate ?? []).map((argument) =>
            argument.replace(/\$\{([^}]+)\}/g, (_, key: string) => values[key] ?? ''),
          ),
        ];
        result = {
          server: await this.#service.createServer({
            slug: entry.id,
            name: entry.name,
            kind: 'home',
            transport: {
              type: 'stdio',
              command: 'uvx',
              args,
              env: { ...this.#uvEnv },
            },
            credentialId: credential.id,
            enabled: true,
          }),
          credential,
        };
      } else if (entry.kind === 'docker') {
        result = {
          server: await this.#service.createServer({
            slug: entry.id,
            name: entry.name,
            kind: 'home',
            transport: {
              type: 'stdio',
              command: 'docker',
              args: ['run', '--rm', '-i', entry.image ?? ''],
            },
            credentialId: credential.id,
            enabled: true,
          }),
          credential,
        };
      } else {
        result = {
          server: await this.#service.createServer({
            slug: entry.id,
            name: entry.name,
            kind: 'remote',
            transport: { type: 'streamable-http', url: entry.url ?? '' },
            credentialId: credential.id,
            enabled: true,
          }),
          credential,
        };
      }
      const server = (result as { server: { id: string } }).server;
      const installation = this.#store.createInstallation({
        source: 'curated',
        entryId: entry.id,
        entryVersion: entry.version ?? 'unpinned',
        recipeRevision: fingerprint(entry),
        targetType: 'server',
        targetId: server.id,
        credentialId: credential.id,
      });
      this.#update(job, { step: 'done', result: { ...(result as object), installation } });
      this.#updateRecord(job, { status: 'completed', resultReference: installation.id });
    } catch (error) {
      try {
        this.#update(job, {
          step: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        this.#updateRecord(job, {
          status: 'failed',
          errorCode: error instanceof AppError ? error.code : 'market_install_failed',
        });
      } catch {
        // The runtime may have been torn down mid-install; nothing to persist.
      }
    } finally {
      this.#releaseEntry(entry.id, job.record.id);
    }
  }

  #entry(id: string): MarketEntry {
    const entry = marketCatalog.find((item) => item.id === id);
    if (!entry) throw new AppError('market_not_found', `Market entry "${id}" not found`, 404);
    return entry;
  }

  #assertEntryAvailable(entryId: string): void {
    const operation = this.#entryOperations.get(entryId);
    if (operation === undefined) return;
    if (operation.kind === 'job') {
      const job = this.#store.getInstallJob(operation.id);
      const active =
        job !== null && ['awaiting_secret', 'installing', 'updating'].includes(job.status);
      if (!active) {
        this.#entryOperations.delete(entryId);
        return;
      }
      if (job.status === 'awaiting_secret') {
        const action = job.actionId === null ? null : this.#store.getSecureAction(job.actionId);
        if (
          action === null ||
          action.status !== 'pending' ||
          Date.parse(action.expiresAt) <= Date.now()
        ) {
          this.#entryOperations.delete(entryId);
          return;
        }
      }
    }
    throw new AppError(
      'market_operation_in_progress',
      `Market entry "${entryId}" already has an operation in progress`,
      409,
    );
  }

  #claimEntry(entryId: string, operationId: string): void {
    this.#assertEntryAvailable(entryId);
    this.#entryOperations.set(entryId, { kind: 'job', id: operationId });
  }

  #releaseEntry(entryId: string, operationId: string): void {
    if (this.#entryOperations.get(entryId)?.id === operationId) {
      this.#entryOperations.delete(entryId);
    }
  }

  async #runUpdate(entry: MarketEntry, installation: MarketInstallation, job: LiveJob) {
    try {
      // Remote entries carry no package; only the recipe revision can drift.
      if (entryPlane(entry) === 'cli') {
        if (entry.kind === 'cli-image') {
          await this.#dockerInstall(entry, job, true);
        }
        this.#update(job, { step: 'updating installation record' });
        const updated = this.#store.updateInstallation(installation.id, {
          entryVersion: entry.version ?? 'unpinned',
          recipeRevision: fingerprint(entry),
        });
        this.#update(job, {
          step: 'done',
          result: {
            entryId: entry.id,
            version: updated.entryVersion,
            targetType: installation.targetType,
            targetId: installation.targetId,
          },
        });
      } else {
        if (entry.kind === 'home-stdio') {
          await this.#npmInstall(entry, job);
        } else if (entry.kind === 'uvx') {
          await this.#uvxInstall(entry, job);
        } else if (entry.kind === 'docker') {
          await this.#dockerInstall(entry, job, true);
        }
        this.#update(job, { step: 'updating installation record' });
        const updated = this.#store.updateInstallation(installation.id, {
          entryVersion: entry.version ?? 'unpinned',
          recipeRevision: fingerprint(entry),
        });
        this.#update(job, { step: 'restarting server' });
        // The package is already updated; a failed restart must not roll the job
        // back — the old process (or a later manual restart) keeps serving.
        let restartError: string | undefined;
        try {
          await this.#service.restartServer(installation.targetId);
        } catch (error) {
          restartError = error instanceof Error ? error.message : String(error);
        }
        this.#update(job, {
          step: 'done',
          result: {
            entryId: entry.id,
            version: updated.entryVersion,
            targetType: installation.targetType,
            targetId: installation.targetId,
            ...(restartError === undefined ? {} : { restartError }),
          },
        });
      }
      this.#updateRecord(job, { status: 'completed', resultReference: installation.id });
    } catch (error) {
      try {
        this.#update(job, {
          step: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        this.#updateRecord(job, {
          status: 'failed',
          errorCode: error instanceof AppError ? error.code : 'market_update_failed',
        });
      } catch {
        // Runtime torn down mid-update; nothing to persist.
      }
    } finally {
      this.#releaseEntry(entry.id, job.record.id);
    }
  }

  /** Best-effort latest upstream version; null when unreachable or unsupported. */
  async #latestUpstream(entry: MarketEntry): Promise<string | null> {
    const pkg = entry.package;
    if (pkg === undefined) return null;
    const url =
      entry.kind === 'uvx'
        ? `https://pypi.org/pypi/${pkg}/json`
        : entry.kind === 'home-stdio'
          ? `https://registry.npmmirror.com/${pkg}/latest`
          : null;
    if (url === null) return null;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const body = (await response.json()) as { version?: unknown; info?: { version?: unknown } };
      const version =
        typeof body.version === 'string'
          ? body.version
          : typeof body.info?.version === 'string'
            ? body.info.version
            : null;
      return version;
    } catch {
      return null;
    }
  }

  #binPath(entry: MarketEntry): string {
    return join(this.#marketDir, 'node_modules', '.bin', entry.bin ?? entry.id);
  }

  #pinnedPackage(entry: MarketEntry, kind: 'npm' | 'uvx'): string {
    const base = entry.package ?? entry.id;
    if (!entry.version) return base;
    return kind === 'uvx' ? `${base}==${entry.version}` : `${base}@${entry.version}`;
  }

  #credentialPayload(entry: MarketEntry, values: Record<string, string>): CredentialPayload {
    switch (entry.credential.type) {
      case 'oauth':
        return { type: 'oauth', tokenType: 'Bearer' };
      case 'env':
        return { type: 'env', variables: values };
      case 'bearer':
        return { type: 'bearer', token: values[entry.credential.tokenKey] ?? '' };
      case 'api-key':
        return {
          type: 'api-key',
          headerName: entry.credential.headerName,
          value: values[entry.credential.valueKey] ?? '',
        };
      case 'headers':
        return {
          type: 'headers',
          headers: Object.fromEntries(
            entry.credential.headers.map((header) => [
              header.name,
              header.valueKey ? (values[header.valueKey] ?? '') : (header.value ?? ''),
            ]),
          ),
        };
    }
  }

  #runDocker(
    args: string[],
    job: LiveJob,
    step: string,
  ): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      this.#update(job, { step });
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const append = (chunk: string) => {
        output = `${output}${chunk}`.slice(-4000);
        this.#update(job, { output });
      };
      child.stdout.on('data', (chunk) => append(String(chunk)));
      child.stderr.on('data', (chunk) => append(String(chunk)));
      const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, output });
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: 1, output: `docker: ${error.message}` });
      });
    });
  }

  async #dockerInstall(entry: MarketEntry, job: LiveJob, force = false): Promise<void> {
    const image = entry.image;
    if (!image) {
      throw new AppError('market_install_failed', 'Docker entry is missing an image', 500);
    }
    const inspect = force
      ? { code: 1, output: '' }
      : await this.#runDocker(['image', 'inspect', image], job, `docker image inspect ${image}`);
    if (inspect.code === 0) return;
    const pull = await this.#runDocker(['pull', image], job, `docker pull ${image}`);
    if (pull.code === 0) return;
    if (entry.dockerfile !== undefined) {
      const directory = join(this.#marketDir, 'dockerfiles', entry.id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'Dockerfile'), entry.dockerfile);
      const build = await this.#runDocker(
        ['build', '-t', image, directory],
        job,
        `docker build -t ${image}`,
      );
      if (build.code === 0) return;
      throw new AppError(
        'market_install_failed',
        `Docker image ${image} could not be pulled or built: ${pull.output.slice(-240)}`,
        500,
      );
    }
    throw new AppError(
      'market_install_failed',
      `Docker image ${image} could not be pulled: ${pull.output.slice(-240)}`,
      500,
    );
  }

  #uvxInstall(entry: MarketEntry, job: LiveJob): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#update(job, { step: `uv tool install ${this.#pinnedPackage(entry, 'uvx')}` });
      const args = ['tool', 'install', this.#pinnedPackage(entry, 'uvx')];
      for (const dependency of entry.uvWith ?? []) args.push('--with', dependency);
      const child = spawn('uv', args, {
        env: { ...process.env, ...this.#uvEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const append = (chunk: string) => {
        output = `${output}${chunk}`.slice(-4000);
        this.#update(job, { output });
      };
      child.stdout.on('data', (chunk) => append(String(chunk)));
      child.stderr.on('data', (chunk) => append(String(chunk)));
      const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          this.#update(job, { output });
          reject(
            new AppError(
              'market_install_failed',
              `uv tool install failed (${code}): ${output.slice(-400)}`,
              500,
            ),
          );
        }
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new AppError('market_install_failed', `Failed to run uv: ${error.message}`, 500));
      });
    });
  }

  #npmInstall(entry: MarketEntry, job: LiveJob): Promise<void> {
    return new Promise((resolve, reject) => {
      mkdirSync(this.#marketDir, { recursive: true });
      this.#update(job, { step: `npm install ${this.#pinnedPackage(entry, 'npm')}` });
      const child = spawn(
        'npm',
        [
          'install',
          '--prefix',
          this.#marketDir,
          '--no-audit',
          '--no-fund',
          this.#pinnedPackage(entry, 'npm'),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      const append = (chunk: string) => {
        output = `${output}${chunk}`.slice(-4000);
        this.#update(job, { output });
      };
      child.stdout.on('data', (chunk) => append(String(chunk)));
      child.stderr.on('data', (chunk) => append(String(chunk)));
      const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          this.#update(job, { output });
          reject(
            new AppError(
              'market_install_failed',
              `npm install failed (${code}): ${output.slice(-400)}`,
              500,
            ),
          );
        }
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new AppError('market_install_failed', `Failed to run npm: ${error.message}`, 500));
      });
    });
  }
}

export type { MarketInstallation };
