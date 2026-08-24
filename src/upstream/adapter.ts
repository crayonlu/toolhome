import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  withInputRequired,
  type ClientCapabilities,
  type Notification,
  type McpSubscription,
  type RequestOptions,
  type ServerContext,
  type Transport,
} from '@modelcontextprotocol/client';
import {
  CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema,
  ElicitResultSchema,
  ListRootsResultSchema,
} from '@modelcontextprotocol/core';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, errorMessage, toError } from '../domain/errors.js';
import type { CapabilitySnapshot, ServerRecord } from '../domain/models.js';
import type { Logger } from '../observability/logger.js';
import type { CredentialResolver } from './credential-resolver.js';
import {
  ExtensionTransportBridge,
  extensionFetch,
  isTaskExtensionMethod,
  restoreTaskResult,
} from './extension-transport.js';
import { fingerprint, stableJson } from './stable-json.js';

const objectResultSchema = z.record(z.string(), z.unknown());
const inputRequiredResultSchema = withInputRequired(objectResultSchema);
const samplingResultSchema = z.union([
  CreateMessageResultWithToolsSchema,
  CreateMessageResultSchema,
]);
const legacyRoundStatePrefix = 'toolhome-legacy-round:';
const mrtrMethods = new Set(['tools/call', 'prompts/get', 'resources/read']);
const discoveryCapabilities: ClientCapabilities = {
  extensions: {
    'io.modelcontextprotocol/tasks': {},
    'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
  },
};

export type UpstreamEvent =
  | { type: 'tools_changed'; serverId: string }
  | { type: 'prompts_changed'; serverId: string }
  | { type: 'resources_changed'; serverId: string }
  | { type: 'resource_updated'; serverId: string; uri: string }
  | { type: 'connection_closed'; serverId: string }
  | { type: 'stderr'; serverId: string; message: string };

export interface UpstreamRequest {
  method: string;
  params?: Record<string, unknown> | undefined;
}

export interface BridgeContext {
  context: ServerContext;
  clientCapabilities: ClientCapabilities;
  transformClientResult?(value: unknown): unknown;
  transformNotification?(notification: Notification): Notification;
  transformRequest?(request: UpstreamRequest): UpstreamRequest;
}

export type BridgeTransforms = Pick<
  BridgeContext,
  'transformClientResult' | 'transformNotification' | 'transformRequest'
>;

interface BridgeRef {
  current: BridgeContext | null;
  legacyRound: LegacyRound | null;
}

interface ConnectionSlot {
  client: Client;
  transport: Transport;
  profile: string;
  bridge: BridgeRef;
  busy: boolean;
  retained: number;
  extensions: ExtensionTransportBridge;
  suppressCloseEvent: boolean;
}

interface ResourceSubscription {
  slot: ConnectionSlot;
  subscription: McpSubscription | null;
  references: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingLegacyInput {
  request: UpstreamRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

type LegacyRoundOutcome = { kind: 'result'; value: unknown } | { kind: 'error'; error: Error };

interface LegacyRound {
  id: string;
  method: string;
  slot: ConnectionSlot;
  controller: AbortController;
  completion: Promise<LegacyRoundOutcome>;
  settle(outcome: LegacyRoundOutcome): void;
  inputs: Map<string, PendingLegacyInput>;
  inputSignal: Deferred<void>;
  timer: ReturnType<typeof setTimeout>;
  detachSignal(): void;
  closed: boolean;
}

type EventSink = (event: UpstreamEvent) => void;

export class UpstreamAdapter {
  readonly server: ServerRecord;
  readonly #slots: ConnectionSlot[] = [];
  readonly #creating = new Map<string, number>();
  readonly #waiters = new Set<() => void>();
  readonly #resourceSubscriptions = new Map<string, ResourceSubscription>();
  readonly #subscriptionCreates = new Map<string, Promise<void>>();
  readonly #legacyRounds = new Map<string, LegacyRound>();
  readonly #credentials: CredentialResolver;
  readonly #logger: Logger;
  readonly #events: EventSink;
  #closed = false;
  #generation = 0;
  #restartPromise: Promise<void> | null = null;

  constructor(
    server: ServerRecord,
    credentials: CredentialResolver,
    logger: Logger,
    events: EventSink,
  ) {
    this.server = server;
    this.#credentials = credentials;
    this.#logger = logger;
    this.#events = events;
  }

  processId(): number | null {
    for (const slot of this.#slots) {
      if (slot.transport instanceof StdioClientTransport) return slot.transport.pid;
    }
    return null;
  }

  async execute(request: UpstreamRequest, bridge: BridgeContext): Promise<unknown> {
    if (request.method === 'resources/subscribe') {
      await this.#retainResource(bridge.clientCapabilities, this.#requestUri(request));
      return {};
    }
    if (request.method === 'resources/unsubscribe') {
      await this.#releaseResource(bridge.clientCapabilities, this.#requestUri(request));
      return {};
    }
    const legacyRoundId = this.#legacyRoundId(request.params?.requestState);
    if (legacyRoundId !== null) {
      return this.#resumeLegacyRound(legacyRoundId, request, bridge);
    }
    const slot = await this.#acquire(bridge.clientCapabilities);
    slot.bridge.current = bridge;
    if (
      slot.client.getProtocolEra() === 'legacy' &&
      contextIsModern(bridge.context) &&
      mrtrMethods.has(request.method)
    ) {
      return this.#startLegacyRound(slot, request, bridge);
    }
    try {
      const options = this.#requestOptions(request, bridge.context);
      return await this.#requestOnSlot(slot, request, options);
    } finally {
      slot.bridge.current = null;
      this.#release(slot);
    }
  }

  async #requestOnSlot(
    slot: ConnectionSlot,
    request: UpstreamRequest,
    options: RequestOptions,
  ): Promise<unknown> {
    if (slot.client.getProtocolEra() === 'modern' && isTaskExtensionMethod(request.method)) {
      return slot.extensions.request(request, options);
    }
    if (request.method === 'tools/call' && slot.client.getProtocolEra() === 'modern') {
      // SEP-2243: callTool mirrors declared parameters into Mcp-Param-* headers
      // and auto-retries HeaderMismatch (-32020) after refreshing tools/list.
      // The low-level request() path does neither, which breaks upstreams that
      // require header-mirrored params (e.g. GitHub's get_file_contents).
      const result = await slot.client.callTool(
        request.params as { name: string; arguments?: Record<string, unknown> },
        {
          ...options,
          allowInputRequired: true,
        },
      );
      return restoreTaskResult(result);
    }
    if (mrtrMethods.has(request.method)) {
      const result = await slot.client.request(request, inputRequiredResultSchema, {
        ...options,
        allowInputRequired: true,
      });
      return restoreTaskResult(result);
    }
    return restoreTaskResult(await slot.client.request(request, objectResultSchema, options));
  }

  async #startLegacyRound(
    slot: ConnectionSlot,
    request: UpstreamRequest,
    bridge: BridgeContext,
  ): Promise<unknown> {
    const id = randomUUID();
    const controller = new AbortController();
    const completion = deferred<LegacyRoundOutcome>();
    const round: LegacyRound = {
      id,
      method: request.method,
      slot,
      controller,
      completion: completion.promise,
      settle: completion.resolve,
      inputs: new Map(),
      inputSignal: deferred<void>(),
      timer: setTimeout(
        () =>
          this.#cancelLegacyRound(
            id,
            new AppError('legacy_round_expired', 'Legacy input round expired', 504),
          ),
        this.server.settings.maxTotalTimeoutMs,
      ),
      detachSignal: () => undefined,
      closed: false,
    };
    this.#legacyRounds.set(id, round);
    slot.bridge.legacyRound = round;
    this.#attachLegacyBridge(round, bridge);
    if (round.closed) return this.#awaitLegacyRound(round);
    const options = this.#legacyRoundRequestOptions(request, slot.bridge, controller.signal);
    void this.#requestOnSlot(slot, request, options).then(
      (value) => round.settle({ kind: 'result', value }),
      (error) =>
        round.settle({
          kind: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        }),
    );
    return this.#awaitLegacyRound(round);
  }

  async #resumeLegacyRound(
    id: string,
    request: UpstreamRequest,
    bridge: BridgeContext,
  ): Promise<unknown> {
    const round = this.#legacyRounds.get(id);
    if (!round || round.closed) {
      throw new AppError(
        'legacy_round_not_found',
        'Legacy input round expired or was restarted',
        409,
      );
    }
    if (round.method !== request.method || !contextIsModern(bridge.context)) {
      throw new AppError(
        'legacy_round_mismatch',
        'Legacy input round does not match this request',
        400,
      );
    }
    const responses = request.params?.inputResponses;
    if (isRecord(responses)) {
      for (const [key, pending] of round.inputs) {
        if (!Object.hasOwn(responses, key)) continue;
        pending.resolve(bridge.transformClientResult?.(responses[key]) ?? responses[key]);
        round.inputs.delete(key);
      }
    }
    this.#attachLegacyBridge(round, bridge);
    return this.#awaitLegacyRound(round);
  }

  async #awaitLegacyRound(round: LegacyRound): Promise<unknown> {
    while (!round.closed) {
      if (round.inputs.size === 0) {
        const outcome = await Promise.race([
          round.completion,
          round.inputSignal.promise.then((): { kind: 'input' } => ({ kind: 'input' })),
        ]);
        if (outcome.kind === 'result') {
          this.#finishLegacyRound(round);
          return outcome.value;
        }
        if (outcome.kind === 'error') {
          this.#finishLegacyRound(round, outcome.error);
          throw outcome.error;
        }
        await Promise.resolve();
        if (round.inputs.size === 0) continue;
      }
      const inputRequests = Object.fromEntries(
        [...round.inputs].map(([key, input]) => [key, input.request]),
      );
      round.inputSignal = deferred<void>();
      round.detachSignal();
      round.slot.bridge.current = null;
      return {
        resultType: 'input_required',
        inputRequests,
        requestState: `${legacyRoundStatePrefix}${round.id}`,
      };
    }
    throw new AppError('legacy_round_not_found', 'Legacy input round is closed', 409);
  }

  #attachLegacyBridge(round: LegacyRound, bridge: BridgeContext): void {
    round.detachSignal();
    round.slot.bridge.current = bridge;
    const signal = bridge.context.mcpReq.signal;
    const onAbort = (): void => {
      this.#cancelLegacyRound(
        round.id,
        new AppError('request_cancelled', 'Downstream request was cancelled', 499),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    round.detachSignal = () => signal.removeEventListener('abort', onAbort);
  }

  #cancelLegacyRound(id: string, error: Error): void {
    const round = this.#legacyRounds.get(id);
    if (!round || round.closed) return;
    round.controller.abort(error);
    round.settle({ kind: 'error', error });
    this.#finishLegacyRound(round, error);
  }

  #finishLegacyRound(round: LegacyRound, error?: Error): void {
    if (round.closed) return;
    round.closed = true;
    clearTimeout(round.timer);
    round.detachSignal();
    this.#legacyRounds.delete(round.id);
    if (round.slot.bridge.legacyRound === round) round.slot.bridge.legacyRound = null;
    round.slot.bridge.current = null;
    if (error) {
      for (const pending of round.inputs.values()) pending.reject(error);
    }
    round.inputs.clear();
    this.#release(round.slot);
  }

  #legacyRoundId(value: unknown): string | null {
    if (typeof value !== 'string' || !value.startsWith(legacyRoundStatePrefix)) return null;
    const id = value.slice(legacyRoundStatePrefix.length);
    return id.length === 0 ? null : id;
  }

  #legacyRoundRequestOptions(
    request: UpstreamRequest,
    bridge: BridgeRef,
    signal: AbortSignal,
  ): RequestOptions {
    const progressToken = this.#progressToken(request.params);
    return {
      signal,
      timeout: this.server.settings.maxTotalTimeoutMs,
      maxTotalTimeout: this.server.settings.maxTotalTimeoutMs,
      resetTimeoutOnProgress: true,
      ...(progressToken === null
        ? {}
        : {
            onprogress: async (progress) => {
              const active = bridge.current;
              if (!active) return;
              await active.context.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken, ...progress },
              });
            },
          }),
    };
  }

  async notify(
    notification: Notification,
    clientCapabilities: ClientCapabilities,
    bridge: BridgeContext | null = null,
  ): Promise<void> {
    const slot = await this.#acquire(clientCapabilities);
    slot.bridge.current = bridge;
    try {
      await slot.client.notification(notification);
    } finally {
      slot.bridge.current = null;
      this.#release(slot);
    }
  }

  async subscribeResources(
    uris: string[],
    clientCapabilities: ClientCapabilities,
  ): Promise<() => Promise<void>> {
    const uniqueUris = [...new Set(uris)];
    for (const uri of uniqueUris) await this.#retainResource(clientCapabilities, uri);
    let closed = false;
    return async () => {
      if (closed) return;
      closed = true;
      for (const uri of uniqueUris) await this.#releaseResource(clientCapabilities, uri);
    };
  }

  async discoverSnapshot(previousVersion: number): Promise<CapabilitySnapshot> {
    const slot = await this.#acquire(discoveryCapabilities);
    try {
      const capabilities = slot.client.getServerCapabilities() ?? {};
      const [toolsResult, resourcesResult, resourceTemplatesResult, promptsResult] =
        await Promise.all([
          capabilities.tools
            ? slot.client.listTools(undefined, { cacheMode: 'refresh' })
            : Promise.resolve({ tools: [] }),
          capabilities.resources
            ? slot.client.listResources(undefined, { cacheMode: 'refresh' })
            : Promise.resolve({ resources: [] }),
          capabilities.resources
            ? slot.client.listResourceTemplates(undefined, { cacheMode: 'refresh' })
            : Promise.resolve({ resourceTemplates: [] }),
          capabilities.prompts
            ? slot.client.listPrompts(undefined, { cacheMode: 'refresh' })
            : Promise.resolve({ prompts: [] }),
        ]);
      const protocolEra = slot.client.getProtocolEra();
      if (!protocolEra) throw new Error('Upstream protocol era is unavailable');
      const body = {
        serverInfo: slot.client.getServerVersion() ?? null,
        capabilities,
        instructions: slot.client.getInstructions() ?? null,
        tools: toolsResult.tools,
        resources: resourcesResult.resources,
        resourceTemplates: resourceTemplatesResult.resourceTemplates,
        prompts: promptsResult.prompts,
        listResults: {
          tools: toolsResult,
          resources: resourcesResult,
          resourceTemplates: resourceTemplatesResult,
          prompts: promptsResult,
        },
      };
      return {
        serverId: this.server.id,
        version: previousVersion + 1,
        protocolVersion: slot.client.getNegotiatedProtocolVersion() ?? 'unknown',
        protocolEra,
        ...body,
        fingerprint: fingerprint(body),
        refreshedAt: new Date().toISOString(),
      };
    } finally {
      this.#release(slot);
    }
  }

  restart(): Promise<void> {
    const current = this.#restartPromise;
    if (current) return current;
    const operation = this.#restartNow();
    this.#restartPromise = operation;
    return operation.finally(() => {
      if (this.#restartPromise === operation) this.#restartPromise = null;
      this.#wakeWaiters();
    });
  }

  async #restartNow(): Promise<void> {
    const restartError = new AppError(
      'upstream_restarted',
      'Upstream connection was restarted',
      503,
    );
    for (const id of [...this.#legacyRounds.keys()]) {
      this.#cancelLegacyRound(id, restartError);
    }
    this.#generation += 1;
    const slots = this.#slots.splice(0);
    for (const slot of slots) {
      slot.suppressCloseEvent = true;
      slot.extensions.close();
    }
    this.#wakeWaiters();
    await Promise.allSettled(slots.map((slot) => slot.client.close()));
    this.#resourceSubscriptions.clear();
    this.#subscriptionCreates.clear();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.restart();
  }

  async #acquire(capabilities: ClientCapabilities): Promise<ConnectionSlot> {
    await this.#restartPromise;
    if (this.#closed) throw new AppError('upstream_closed', 'Upstream adapter is closed', 503);
    const generation = this.#generation;
    const profile = stableJson(capabilities);
    while (true) {
      if (generation !== this.#generation || this.#closed) {
        throw new AppError('upstream_restarted', 'Upstream connection was restarted', 503);
      }
      const idle = this.#slots.find((slot) => slot.profile === profile && !slot.busy);
      if (idle) {
        idle.busy = true;
        return idle;
      }
      const creatingForProfile = this.#creating.get(profile) ?? 0;
      let creatingTotal = 0;
      for (const count of this.#creating.values()) creatingTotal += count;
      if (this.#slots.length + creatingTotal < this.server.settings.maxConcurrency) {
        this.#creating.set(profile, creatingForProfile + 1);
        try {
          const created = await this.#createConnection(capabilities, profile);
          if (generation !== this.#generation || this.#closed) {
            created.suppressCloseEvent = true;
            created.extensions.close();
            await created.client.close();
            throw new AppError('upstream_restarted', 'Upstream connection was restarted', 503);
          }
          created.busy = true;
          this.#slots.push(created);
          return created;
        } finally {
          const remaining = (this.#creating.get(profile) ?? 1) - 1;
          if (remaining === 0) this.#creating.delete(profile);
          else this.#creating.set(profile, remaining);
          this.#wakeWaiters();
        }
      }
      const recyclable = this.#slots.find((slot) => !slot.busy && slot.retained === 0);
      if (recyclable) {
        const index = this.#slots.indexOf(recyclable);
        if (index >= 0) this.#slots.splice(index, 1);
        recyclable.suppressCloseEvent = true;
        recyclable.extensions.close();
        await recyclable.client.close().catch(() => undefined);
        continue;
      }
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
  }

  #release(slot: ConnectionSlot): void {
    slot.busy = false;
    this.#wakeWaiters();
  }

  #wakeWaiters(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }

  async #createConnection(
    capabilities: ClientCapabilities,
    profile: string,
  ): Promise<ConnectionSlot> {
    const bridge: BridgeRef = { current: null, legacyRound: null };
    const connect = async (fallbackSse: boolean): Promise<ConnectionSlot> => {
      const client = this.#createClient(capabilities, bridge);
      const transport = this.#createTransport(fallbackSse);
      const generation = this.#generation;
      let connected = false;
      let slot: ConnectionSlot | null = null;
      client.onerror = (error) => {
        this.#logger.warn('Upstream MCP client error', {
          serverId: this.server.id,
          error: error.message,
        });
      };
      client.onclose = () => {
        if (
          connected &&
          !slot?.suppressCloseEvent &&
          !this.#closed &&
          generation === this.#generation
        ) {
          this.#events({ type: 'connection_closed', serverId: this.server.id });
        }
      };
      if (transport instanceof StdioClientTransport) {
        transport.stderr?.on('data', (chunk: unknown) => {
          const message = this.#redactStderr(String(chunk).trim()).slice(0, 8_192);
          if (message !== '') this.#events({ type: 'stderr', serverId: this.server.id, message });
        });
      }
      try {
        await client.connect(transport, { timeout: this.server.settings.connectTimeoutMs });
        connected = true;
        const protocolVersion = client.getNegotiatedProtocolVersion();
        if (!protocolVersion) throw new Error('Upstream protocol version is unavailable');
        const extensions = new ExtensionTransportBridge(transport, protocolVersion, capabilities);
        slot = {
          client,
          transport,
          profile,
          bridge,
          busy: false,
          retained: 0,
          extensions,
          suppressCloseEvent: false,
        };
        return slot;
      } catch (error) {
        connected = false;
        await client.close().catch(() => undefined);
        throw error;
      }
    };

    try {
      return await connect(false);
    } catch (error) {
      if (
        this.server.transport.type !== 'streamable-http' ||
        !this.server.transport.allowSseFallback
      ) {
        throw error;
      }
      this.#logger.warn('Streamable HTTP failed; trying legacy SSE', {
        serverId: this.server.id,
        error: errorMessage(error),
      });
      return connect(true);
    }
  }

  #createClient(capabilities: ClientCapabilities, bridge: BridgeRef): Client {
    const mode =
      this.server.transport.protocolMode === 'modern'
        ? { pin: '2026-07-28' }
        : this.server.transport.protocolMode;
    const client = new Client(
      { name: 'toolhome', version: '0.1.0' },
      {
        capabilities,
        versionNegotiation: { mode },
        inputRequired: { autoFulfill: false },
        listMaxPages: 256,
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: (error) => this.#onListChanged(error, 'tools_changed'),
          },
          prompts: {
            autoRefresh: false,
            onChanged: (error) => this.#onListChanged(error, 'prompts_changed'),
          },
          resources: {
            autoRefresh: false,
            onChanged: (error) => this.#onListChanged(error, 'resources_changed'),
          },
        },
      },
    );

    if (capabilities.roots) {
      client.setRequestHandler('roots/list', async (request) =>
        ListRootsResultSchema.parse(await this.#bridgeInputRequest(bridge, request)),
      );
    }
    if (capabilities.sampling) {
      client.setRequestHandler('sampling/createMessage', async (request) =>
        samplingResultSchema.parse(await this.#bridgeInputRequest(bridge, request)),
      );
    }
    if (capabilities.elicitation) {
      client.setRequestHandler('elicitation/create', async (request) =>
        ElicitResultSchema.parse(await this.#bridgeInputRequest(bridge, request)),
      );
    }

    client.setNotificationHandler('notifications/resources/updated', async (notification) => {
      this.#events({
        type: 'resource_updated',
        serverId: this.server.id,
        uri: notification.params.uri,
      });
      const active = bridge.current;
      if (active)
        await active.context.mcpReq.notify(this.#bridgeNotification(active, notification));
    });

    client.setNotificationHandler('notifications/message', async (notification) => {
      const active = bridge.current;
      if (active)
        await active.context.mcpReq.notify(this.#bridgeNotification(active, notification));
    });

    client.fallbackRequestHandler = async (request) => {
      const active = this.#requireBridge(bridge);
      const forwarded = active.transformRequest?.(request) ?? request;
      const result = await active.context.mcpReq.send(forwarded, objectResultSchema, {
        signal: active.context.mcpReq.signal,
        timeout: this.server.settings.requestTimeoutMs,
        maxTotalTimeout: this.server.settings.maxTotalTimeoutMs,
      });
      return objectResultSchema.parse(active.transformClientResult?.(result) ?? result);
    };
    client.fallbackNotificationHandler = async (notification) => {
      const active = bridge.current;
      if (!active) return;
      if (
        contextIsModern(active.context) &&
        (notification.method === 'notifications/tasks/status' ||
          notification.method === 'notifications/tasks')
      ) {
        return;
      }
      await active.context.mcpReq.notify(this.#bridgeNotification(active, notification));
    };
    return client;
  }

  #createTransport(fallbackSse: boolean): Transport {
    const credential = this.#credentials.resolve(this.server);
    if (this.server.transport.type === 'stdio') {
      const env = {
        ...getDefaultEnvironment(),
        ...this.server.transport.env,
        ...credential.env,
      };
      return new StdioClientTransport({
        command: this.server.transport.command,
        args: this.server.transport.args,
        env,
        stderr: 'pipe',
        ...(this.server.transport.cwd === undefined ? {} : { cwd: this.server.transport.cwd }),
      });
    }

    const headers = {
      ...this.server.transport.headers,
      ...credential.headers,
    };
    const options = {
      requestInit: { headers },
      fetch: extensionFetch,
      ...(credential.authProvider === undefined ? {} : { authProvider: credential.authProvider }),
    };
    return fallbackSse
      ? new SSEClientTransport(new URL(this.server.transport.url), options)
      : new StreamableHTTPClientTransport(new URL(this.server.transport.url), options);
  }

  #redactStderr(message: string): string {
    if (this.server.transport.type !== 'stdio') return message;
    const values = new Set(Object.values(this.server.transport.env));
    try {
      for (const value of Object.values(this.#credentials.resolve(this.server).env)) {
        values.add(value);
      }
    } catch {
      return '[stderr redacted while credential state changed]';
    }
    let redacted = message;
    for (const value of values) {
      if (value === '') continue;
      redacted = redacted.replaceAll(value, '[REDACTED]');
    }
    return redacted;
  }

  #requestOptions(request: UpstreamRequest, context: ServerContext): RequestOptions {
    const progressToken = this.#progressToken(request.params);
    return {
      signal: context.mcpReq.signal,
      timeout: this.server.settings.requestTimeoutMs,
      maxTotalTimeout: this.server.settings.maxTotalTimeoutMs,
      resetTimeoutOnProgress: true,
      ...(progressToken === null
        ? {}
        : {
            onprogress: async (progress) => {
              await context.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken, ...progress },
              });
            },
          }),
    };
  }

  #progressToken(params: Record<string, unknown> | undefined): string | number | null {
    if (!params) return null;
    const meta = params._meta;
    if (typeof meta !== 'object' || meta === null) return null;
    const token = Reflect.get(meta, 'progressToken');
    return typeof token === 'string' || typeof token === 'number' ? token : null;
  }

  #requestUri(request: UpstreamRequest): string {
    const uri = request.params?.uri;
    if (typeof uri !== 'string')
      throw new AppError('invalid_resource_uri', 'Resource URI required');
    return uri;
  }

  async #retainResource(capabilities: ClientCapabilities, uri: string): Promise<void> {
    const profile = stableJson(capabilities);
    const key = `${profile}\0${uri}`;
    const existing = this.#resourceSubscriptions.get(key);
    if (existing) {
      existing.references += 1;
      return;
    }
    const pending = this.#subscriptionCreates.get(key);
    if (pending) {
      await pending;
      const created = this.#resourceSubscriptions.get(key);
      if (created) created.references += 1;
      return;
    }
    const operation = this.#createResourceSubscription(key, capabilities, uri);
    this.#subscriptionCreates.set(key, operation);
    try {
      await operation;
    } finally {
      if (this.#subscriptionCreates.get(key) === operation) {
        this.#subscriptionCreates.delete(key);
      }
    }
  }

  async #createResourceSubscription(
    key: string,
    clientCapabilities: ClientCapabilities,
    uri: string,
  ): Promise<void> {
    const slot = await this.#acquire(clientCapabilities);
    try {
      const capabilities = slot.client.getServerCapabilities();
      if (!capabilities?.resources?.subscribe) return;
      if (slot.client.getProtocolEra() === 'modern') {
        const subscription = await slot.client.listen({ resourceSubscriptions: [uri] });
        slot.retained += 1;
        this.#resourceSubscriptions.set(key, { slot, subscription, references: 1 });
        return;
      }
      await slot.client.subscribeResource({ uri });
      slot.retained += 1;
      this.#resourceSubscriptions.set(key, { slot, subscription: null, references: 1 });
    } finally {
      this.#release(slot);
    }
  }

  async #releaseResource(capabilities: ClientCapabilities, uri: string): Promise<void> {
    const key = `${stableJson(capabilities)}\0${uri}`;
    await this.#subscriptionCreates.get(key)?.catch(() => undefined);
    const state = this.#resourceSubscriptions.get(key);
    if (!state) return;
    state.references -= 1;
    if (state.references > 0) return;
    this.#resourceSubscriptions.delete(key);
    if (!(await this.#acquireSpecific(state.slot))) return;
    try {
      if (state.subscription) await state.subscription.close();
      else await state.slot.client.unsubscribeResource({ uri });
    } finally {
      state.slot.retained = Math.max(0, state.slot.retained - 1);
      this.#release(state.slot);
    }
  }

  async #acquireSpecific(slot: ConnectionSlot): Promise<boolean> {
    while (this.#slots.includes(slot)) {
      if (!slot.busy) {
        slot.busy = true;
        return true;
      }
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
    return false;
  }

  #requireBridge(bridge: BridgeRef): BridgeContext {
    if (!bridge.current) {
      throw new AppError(
        'client_capability_unavailable',
        'The upstream requested a client capability outside an active MCP request',
        502,
      );
    }
    return bridge.current;
  }

  #bridgeNotification(active: BridgeContext, notification: Notification): Notification {
    return active.transformNotification?.(notification) ?? notification;
  }

  #bridgeInputRequest(bridge: BridgeRef, request: UpstreamRequest): Promise<unknown> {
    const active = this.#requireBridge(bridge);
    const forwarded = active.transformRequest?.(request) ?? request;
    const round = bridge.legacyRound;
    if (!round || round.closed) {
      return active.context.mcpReq
        .send(forwarded, objectResultSchema, {
          signal: active.context.mcpReq.signal,
          timeout: this.server.settings.requestTimeoutMs,
          maxTotalTimeout: this.server.settings.maxTotalTimeoutMs,
        })
        .then((result) => active.transformClientResult?.(result) ?? result);
    }
    const key = `input-${randomUUID()}`;
    return new Promise<unknown>((resolve, reject) => {
      round.inputs.set(key, { request: forwarded, resolve, reject });
      round.inputSignal.resolve(undefined);
    });
  }

  #onListChanged(
    error: Error | null,
    type: 'tools_changed' | 'prompts_changed' | 'resources_changed',
  ): void {
    if (error) {
      this.#logger.warn('Upstream list change refresh failed', {
        serverId: this.server.id,
        error: toError(error).message,
      });
      return;
    }
    this.#events({ type, serverId: this.server.id });
  }
}

function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolveValue = (value: T): void => {
    void value;
  };
  let rejectValue = (error: Error): void => {
    void error;
  };
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolveValue(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectValue(error);
    },
  };
}

function contextIsModern(context: ServerContext): boolean {
  return context.mcpReq.envelope !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
