import {
  ProtocolError,
  type ClientCapabilities,
  type Notification,
  type ServerContext,
} from '@modelcontextprotocol/client';
import { AppError, errorMessage } from '../domain/errors.js';
import type { CapabilitySnapshot, RuntimeState, ServerRecord } from '../domain/models.js';
import type { Logger } from '../observability/logger.js';
import type { Store } from '../storage/store.js';
import {
  UpstreamAdapter,
  type BridgeTransforms,
  type UpstreamEvent,
  type UpstreamRequest,
} from './adapter.js';
import type { CredentialResolver } from './credential-resolver.js';

type UpstreamEventListener = (event: UpstreamEvent) => void;

interface ManagedAdapter {
  updatedAt: string;
  adapter: UpstreamAdapter;
}

export class UpstreamManager {
  readonly #adapters = new Map<string, ManagedAdapter>();
  readonly #refreshing = new Map<string, Promise<CapabilitySnapshot>>();
  readonly #listeners = new Set<UpstreamEventListener>();
  readonly #recovering = new Map<string, Promise<void>>();
  readonly #store: Store;
  readonly #credentials: CredentialResolver;
  readonly #logger: Logger;
  #closed = false;

  constructor(store: Store, credentials: CredentialResolver, logger: Logger) {
    this.#store = store;
    this.#credentials = credentials;
    this.#logger = logger;
  }

  subscribe(listener: UpstreamEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async execute(
    serverId: string,
    request: UpstreamRequest,
    context: ServerContext,
    clientCapabilities: ClientCapabilities,
    transforms: BridgeTransforms = {},
  ): Promise<unknown> {
    const server = this.#requireServer(serverId, true);
    const adapter = await this.#adapterFor(server);
    try {
      const result = await adapter.execute(request, {
        context,
        clientCapabilities,
        ...transforms,
      });
      this.#markReady(server, adapter);
      return result;
    } catch (error) {
      if (this.#isConnectionFailure(error)) this.#markFailure(server, error);
      throw error;
    }
  }

  async notify(
    serverId: string,
    notification: Notification,
    context: ServerContext,
    clientCapabilities: ClientCapabilities,
  ): Promise<void> {
    const server = this.#requireServer(serverId, true);
    const adapter = await this.#adapterFor(server);
    await adapter.notify(notification, clientCapabilities, { context, clientCapabilities });
  }

  async notifyDetached(
    serverId: string,
    notification: Notification,
    clientCapabilities: ClientCapabilities,
  ): Promise<void> {
    const server = this.#requireServer(serverId, true);
    const adapter = await this.#adapterFor(server);
    await adapter.notify(notification, clientCapabilities);
  }

  async subscribeResources(
    serverId: string,
    uris: string[],
    clientCapabilities: ClientCapabilities,
  ): Promise<() => Promise<void>> {
    const server = this.#requireServer(serverId, true);
    const adapter = await this.#adapterFor(server);
    return adapter.subscribeResources(uris, clientCapabilities);
  }

  refresh(serverId: string): Promise<CapabilitySnapshot> {
    const existing = this.#refreshing.get(serverId);
    if (existing) return existing;
    const operation = this.#refreshNow(serverId).finally(() => this.#refreshing.delete(serverId));
    this.#refreshing.set(serverId, operation);
    return operation;
  }

  async restart(serverId: string): Promise<CapabilitySnapshot> {
    const server = this.#requireServer(serverId, false);
    const refreshing = this.#refreshing.get(serverId);
    const managed = this.#adapters.get(serverId);
    if (managed) await managed.adapter.restart();
    await refreshing?.catch(() => undefined);
    const state = this.#store.getRuntimeState(serverId);
    this.#saveRuntime(server, {
      status: 'connecting',
      processId: null,
      restartCount: (state?.restartCount ?? 0) + 1,
      lastError: null,
    });
    return this.refresh(serverId);
  }

  async remove(serverId: string): Promise<void> {
    const managed = this.#adapters.get(serverId);
    this.#adapters.delete(serverId);
    if (managed) await managed.adapter.close();
  }

  async invalidate(serverId: string): Promise<void> {
    const refreshing = this.#refreshing.get(serverId);
    await this.remove(serverId);
    await refreshing?.catch(() => undefined);
    this.#store.deleteSnapshot(serverId);
    const server = this.#store.getServer(serverId);
    if (server) {
      this.#saveRuntime(server, {
        status: server.enabled ? 'unknown' : 'disabled',
        protocolVersion: null,
        protocolEra: null,
        processId: null,
        lastError: null,
      });
    }
    this.#emitCapabilityChanges(serverId);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const adapters = [...this.#adapters.values()];
    this.#adapters.clear();
    await Promise.allSettled(adapters.map((item) => item.adapter.close()));
    await Promise.allSettled([...this.#refreshing.values(), ...this.#recovering.values()]);
  }

  async #refreshNow(serverId: string): Promise<CapabilitySnapshot> {
    const server = this.#requireServer(serverId, false);
    const adapter = await this.#adapterFor(server);
    this.#saveRuntime(server, { status: 'connecting', lastError: null });
    try {
      const previous = this.#store.getSnapshot(serverId);
      const snapshot = await adapter.discoverSnapshot(previous?.version ?? 0);
      this.#store.saveSnapshot(snapshot);
      if (previous?.fingerprint !== snapshot.fingerprint) this.#emitCapabilityChanges(serverId);
      this.#saveRuntime(server, {
        status: server.enabled ? 'ready' : 'disabled',
        protocolVersion: snapshot.protocolVersion,
        protocolEra: snapshot.protocolEra,
        processId: adapter.processId(),
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
      });
      this.#store.appendEvent({
        level: 'info',
        type: 'server.refreshed',
        serverId,
        message: `Refreshed ${server.slug}`,
        detail: {
          protocolVersion: snapshot.protocolVersion,
          protocolEra: snapshot.protocolEra,
          tools: snapshot.tools.length,
          resources: snapshot.resources.length,
          prompts: snapshot.prompts.length,
        },
      });
      return snapshot;
    } catch (error) {
      this.#markFailure(server, error);
      throw error;
    }
  }

  async #adapterFor(server: ServerRecord): Promise<UpstreamAdapter> {
    if (this.#closed) throw new AppError('upstream_closed', 'Upstream manager is closed', 503);
    const existing = this.#adapters.get(server.id);
    if (existing?.updatedAt === server.updatedAt) return existing.adapter;
    if (existing) await existing.adapter.close();
    const adapter = new UpstreamAdapter(server, this.#credentials, this.#logger, (event) =>
      this.#onEvent(event),
    );
    this.#adapters.set(server.id, { updatedAt: server.updatedAt, adapter });
    return adapter;
  }

  #onEvent(event: UpstreamEvent): void {
    if (this.#closed) return;
    if (event.type === 'stderr') {
      this.#store.appendEvent({
        level: 'debug',
        type: 'server.stderr',
        serverId: event.serverId,
        message: event.message,
        detail: {},
      });
      return;
    }
    if (event.type === 'connection_closed') {
      if (this.#recovering.has(event.serverId)) return;
      const operation = this.#recover(event.serverId).finally(() =>
        this.#recovering.delete(event.serverId),
      );
      this.#recovering.set(event.serverId, operation);
      return;
    }
    if (event.type === 'resource_updated') {
      for (const listener of this.#listeners) listener(event);
      return;
    }
    void this.refresh(event.serverId)
      .then(() => undefined)
      .catch((error) => {
        this.#logger.warn('Capability refresh after list change failed', {
          serverId: event.serverId,
          error: errorMessage(error),
        });
      });
  }

  async #recover(serverId: string): Promise<void> {
    const server = this.#store.getServer(serverId);
    if (!server) return;
    const refreshing = this.#refreshing.get(serverId);
    await this.remove(serverId);
    await refreshing?.catch(() => undefined);
    if (this.#closed) return;
    const state = this.#store.getRuntimeState(serverId);
    // Both home-hosted and node-hosted servers are stdio processes this manager
    // owns, so a dropped connection is restartable for either placement.
    const restart =
      server.kind !== 'remote' && server.enabled && server.settings.restart !== 'never';
    this.#store.appendEvent({
      level: 'warn',
      type: 'server.connection_closed',
      serverId,
      message: `Connection to ${server.slug} closed`,
      detail: { restart },
    });
    if (!restart) {
      this.#saveRuntime(server, {
        status: server.enabled ? 'unreachable' : 'disabled',
        processId: null,
        lastError: 'Upstream connection closed',
      });
      return;
    }
    this.#saveRuntime(server, {
      status: 'connecting',
      processId: null,
      restartCount: (state?.restartCount ?? 0) + 1,
      lastError: null,
    });
    try {
      await this.refresh(serverId);
    } catch (error) {
      this.#saveRuntime(server, {
        status: 'start-failed',
        processId: null,
        lastError: errorMessage(error),
      });
    }
  }

  #emitCapabilityChanges(serverId: string): void {
    for (const listener of this.#listeners) {
      listener({ type: 'tools_changed', serverId });
      listener({ type: 'prompts_changed', serverId });
      listener({ type: 'resources_changed', serverId });
    }
  }

  #requireServer(serverId: string, requireEnabled: boolean): ServerRecord {
    const server = this.#store.getServer(serverId);
    if (!server) throw new AppError('server_not_found', 'Server not found', 404);
    if (requireEnabled && !server.enabled) {
      throw new AppError('server_disabled', `Server ${server.slug} is disabled`, 503);
    }
    return server;
  }

  #markReady(server: ServerRecord, adapter: UpstreamAdapter): void {
    const state = this.#store.getRuntimeState(server.id);
    if (state?.status === 'ready') return;
    const snapshot = this.#store.getSnapshot(server.id);
    this.#saveRuntime(server, {
      status: server.enabled ? 'ready' : 'disabled',
      protocolVersion: snapshot?.protocolVersion ?? null,
      protocolEra: snapshot?.protocolEra ?? null,
      processId: adapter.processId(),
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
    });
  }

  #markFailure(server: ServerRecord, error: unknown): void {
    const message = errorMessage(error);
    const lower = message.toLowerCase();
    const status =
      lower.includes('401') || lower.includes('unauthorized') ? 'auth-required' : 'unreachable';
    this.#saveRuntime(server, { status, lastError: message });
    this.#store.appendEvent({
      level: 'error',
      type: 'server.error',
      serverId: server.id,
      message: `Server ${server.slug} failed`,
      detail: { error: message },
    });
  }

  #saveRuntime(server: ServerRecord, patch: Partial<RuntimeState>): RuntimeState {
    const current = this.#store.getRuntimeState(server.id);
    return this.#store.saveRuntimeState({
      serverId: server.id,
      status: patch.status ?? current?.status ?? 'unknown',
      protocolVersion:
        patch.protocolVersion === undefined
          ? (current?.protocolVersion ?? null)
          : patch.protocolVersion,
      protocolEra:
        patch.protocolEra === undefined ? (current?.protocolEra ?? null) : patch.protocolEra,
      processId: patch.processId === undefined ? (current?.processId ?? null) : patch.processId,
      restartCount: patch.restartCount ?? current?.restartCount ?? 0,
      lastSuccessAt: patch.lastSuccessAt ?? current?.lastSuccessAt ?? null,
      lastError: patch.lastError === undefined ? (current?.lastError ?? null) : patch.lastError,
      updatedAt: new Date().toISOString(),
    });
  }

  #isConnectionFailure(error: unknown): boolean {
    if (ProtocolError.isInstance(error)) return false;
    if (error instanceof AppError) {
      if (error.code === 'upstream_jsonrpc_error') return false;
      if (
        [
          'upstream_closed',
          'upstream_restarted',
          'upstream_stream_ended',
          'upstream_timeout',
        ].includes(error.code)
      ) {
        return true;
      }
    }
    const message = errorMessage(error).toLowerCase();
    return [
      'econnrefused',
      'econnreset',
      'enotfound',
      'fetch failed',
      'socket',
      'connection closed',
      'unauthorized',
      'status 401',
      'status 403',
    ].some((fragment) => message.includes(fragment));
  }
}
