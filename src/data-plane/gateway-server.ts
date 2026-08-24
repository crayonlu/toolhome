import {
  CallToolRequestParamsSchema,
  CallToolResultSchema,
  ClientCapabilitiesSchema,
  CompleteResultSchema,
  EmptyResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourceTemplatesResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
  ResultSchema,
} from '@modelcontextprotocol/core';
import {
  CLIENT_CAPABILITIES_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  Server,
  createRequestStateCodec,
  isInputRequiredResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type Notification,
  type Prompt,
  type RequestStateCodec,
  type Resource,
  type ResourceTemplateType,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { ToolCallDraft, ToolCallStatus } from '../domain/models.js';
import type { CallRecorder } from '../observability/call-recorder.js';
import type { CursorCodec } from '../security/cursor-codec.js';
import type { UpstreamManager } from '../upstream/manager.js';
import { fingerprint } from '../upstream/stable-json.js';
import { CapabilityRegistry, type RegistryEntry } from './registry.js';
import { canonicalTaskMethod } from './task-extension.js';
import { ToolProjectionService } from './projection.js';
import {
  aggregateName,
  aggregateExtensionMethod,
  expandVirtualResourceTemplate,
  parseVirtualResourceUri,
  parseVirtualResourceTemplate,
  parseVirtualTaskId,
  rewriteAggregateContent,
  rewriteAggregateTask,
  rewriteAggregateTool,
  restoreAggregateContent,
  splitAggregateName,
  splitAggregateExtensionMethod,
  virtualResourceTemplate,
  virtualResourceUri,
} from './virtualization.js';

const paramsSchema = z.record(z.string(), z.unknown());
const inputRequiredResultSchema = z
  .object({
    resultType: z.literal('input_required'),
    inputRequests: z.record(z.string(), z.unknown()).optional(),
    requestState: z.string().optional(),
  })
  .passthrough();
const extensionTaskResultSchema = z
  .object({
    resultType: z.literal('task'),
    taskId: z.string().min(1),
  })
  .passthrough();
const legacyTaskResultSchema = z
  .object({
    task: z.object({ taskId: z.string().min(1) }).passthrough(),
  })
  .passthrough();
const gatewayCallResultSchema = z.union([
  CallToolResultSchema,
  inputRequiredResultSchema,
  extensionTaskResultSchema,
  legacyTaskResultSchema,
]);
const taskParamsSchema = z
  .object({
    taskId: z.string().min(1),
  })
  .passthrough();
const pageSize = 100;

interface GatewayRequestState {
  aggregate: boolean;
  serverId: string;
  upstreamRequestState?: string;
}

interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export class GatewayServerFactory {
  readonly #stateCodec: RequestStateCodec<GatewayRequestState>;
  readonly #aggregateServers = new WeakSet<Server>();
  readonly #registry: CapabilityRegistry;
  readonly #upstreams: UpstreamManager;
  readonly #cursors: CursorCodec;
  readonly #projections: ToolProjectionService;
  readonly #recorder: CallRecorder;

  constructor(
    registry: CapabilityRegistry,
    upstreams: UpstreamManager,
    cursors: CursorCodec,
    masterKey: string,
    projections: ToolProjectionService,
    recorder: CallRecorder,
  ) {
    this.#registry = registry;
    this.#upstreams = upstreams;
    this.#cursors = cursors;
    this.#projections = projections;
    this.#recorder = recorder;
    this.#stateCodec = createRequestStateCodec<GatewayRequestState>({
      key: createHash('sha256').update(masterKey).digest(),
      ttlSeconds: 86_400,
      bind: (context) =>
        `${context.mcpReq.method}\0${context.http?.authInfo?.clientId ?? 'anonymous'}`,
    });
  }

  aggregate(): Server {
    const aggregate = this.#registry.aggregate();
    const server = new Server(
      { name: 'toolhome', version: '0.1.0', title: 'ToolHome' },
      {
        capabilities: aggregate.capabilities,
        instructions:
          'ToolHome aggregates enabled servers. Tools and prompts use server_slug.name. Resources use toolhome:// virtual URIs. Use an individual /mcp/{server_slug} endpoint for exact upstream names and extension semantics.',
        requestState: { verify: this.#stateCodec.verify },
        inputRequired: { legacyShim: true },
      },
    );
    this.#aggregateServers.add(server);

    if (aggregate.capabilities.tools) {
      server.setRequestHandler('tools/list', async (request, context) => {
        const entries = this.#registry.entries();
        const tools = await this.#aggregateTools(server, entries, context, request.params);
        const page = this.#page(tools, request.params?.cursor, fingerprint({ tools }));
        return {
          tools: page.items,
          ...this.#nextCursor(page),
          ttlMs: 0,
          cacheScope: 'private',
          _meta: { 'toolhome/server-count': entries.length },
        };
      });
      server.setRequestHandler(
        'tools/call',
        { params: CallToolRequestParamsSchema, result: gatewayCallResultSchema },
        async (request, context) => {
          const startedAt = new Date();
          let route: { entry: RegistryEntry; originalName: string } | null = null;
          try {
            route = await this.#liveToolRoute(server, request.name, context);
            const params = this.#prepareParams(
              this.#restoreParams({ ...request, name: route.originalName }, route.entry.server.slug),
              context,
              route.entry.server.id,
              route.entry.server.slug,
            );
            const raw = await this.#execute(
              server,
              route.entry,
              { method: 'tools/call', params },
              context,
            );
            this.#recordCall(context, {
              endpointType: 'aggregate',
              serverId: route.entry.server.id,
              exposedToolName: request.name,
              upstreamToolName: route.originalName,
              status: 'success',
              startedAt,
              raw,
            });
            return this.#parseToolResult(
              raw,
              context,
              route.entry.server.id,
              route.entry.server.slug,
            );
          } catch (error) {
            this.#recordCallError(context, {
              endpointType: 'aggregate',
              serverId: route?.entry.server.id ?? null,
              exposedToolName: request.name,
              upstreamToolName: route?.originalName ?? request.name,
              startedAt,
              error,
            });
            throw error;
          }
        },
      );
    }

    if (aggregate.capabilities.prompts) {
      server.setRequestHandler('prompts/list', async (request, context) => {
        const prompts = await this.#aggregatePrompts(
          server,
          this.#registry.entries(),
          context,
          request.params,
        );
        const page = this.#page(prompts, request.params?.cursor, fingerprint({ prompts }));
        return {
          prompts: page.items,
          ...this.#nextCursor(page),
          ttlMs: 0,
          cacheScope: 'private',
        };
      });
      server.setRequestHandler('prompts/get', async (request, context) => {
        const route = await this.#livePromptRoute(server, request.params.name, context);
        const params = this.#prepareParams(
          this.#restoreParams(
            { ...request.params, name: route.originalName },
            route.entry.server.slug,
          ),
          context,
          route.entry.server.id,
          route.entry.server.slug,
        );
        const raw = await this.#execute(
          server,
          route.entry,
          { method: 'prompts/get', params },
          context,
        );
        const result = await this.#parsePromptResult(
          raw,
          context,
          route.entry.server.id,
          route.entry.server.slug,
        );
        if (isInputRequiredResult(result)) return result;
        return GetPromptResultSchema.parse(
          rewriteAggregateContent(result, route.entry.server.slug),
        );
      });
    }

    if (aggregate.capabilities.resources) {
      server.setRequestHandler('resources/list', async (request, context) => {
        const resources = await this.#aggregateResources(
          server,
          this.#registry.entries(),
          context,
          request.params,
        );
        const page = this.#page(resources, request.params?.cursor, fingerprint({ resources }));
        return {
          resources: page.items,
          ...this.#nextCursor(page),
          ttlMs: 0,
          cacheScope: 'private',
        };
      });
      server.setRequestHandler('resources/templates/list', async (request, context) => {
        const resourceTemplates = await this.#aggregateResourceTemplates(
          server,
          this.#registry.entries(),
          context,
          request.params,
        );
        const page = this.#page(
          resourceTemplates,
          request.params?.cursor,
          fingerprint({ resourceTemplates }),
        );
        return {
          resourceTemplates: page.items,
          ...this.#nextCursor(page),
          ttlMs: 0,
          cacheScope: 'private',
        };
      });
      server.setRequestHandler('resources/read', async (request, context) => {
        const route = this.#resourceRoute(request.params.uri);
        const params = this.#prepareParams(
          { ...request.params, uri: route.upstreamUri },
          context,
          route.entry.server.id,
          route.entry.server.slug,
        );
        const raw = await this.#execute(
          server,
          route.entry,
          { method: 'resources/read', params },
          context,
        );
        const result = await this.#parseResourceResult(
          raw,
          context,
          route.entry.server.id,
          route.entry.server.slug,
        );
        if (isInputRequiredResult(result)) return result;
        return ReadResourceResultSchema.parse(
          rewriteAggregateContent(result, route.entry.server.slug),
        );
      });
      if (aggregate.capabilities.resources.subscribe) {
        server.setRequestHandler('resources/subscribe', async (request, context) => {
          const route = this.#resourceRoute(request.params.uri);
          await this.#execute(
            server,
            route.entry,
            {
              method: 'resources/subscribe',
              params: { ...request.params, uri: route.upstreamUri },
            },
            context,
          );
          return {};
        });
        server.setRequestHandler('resources/unsubscribe', async (request, context) => {
          const route = this.#resourceRoute(request.params.uri);
          await this.#execute(
            server,
            route.entry,
            {
              method: 'resources/unsubscribe',
              params: { ...request.params, uri: route.upstreamUri },
            },
            context,
          );
          return {};
        });
      }
    }

    if (aggregate.capabilities.completions) {
      server.setRequestHandler('completion/complete', async (request, context) => {
        const route = await (request.params.ref.type === 'ref/prompt'
          ? this.#promptCompletionRoute(server, request.params.ref.name, context)
          : Promise.resolve(this.#resourceCompletionRoute(request.params.ref.uri)));
        const params = this.#restoreParams(
          {
            ...request.params,
            ref:
              request.params.ref.type === 'ref/prompt'
                ? { ...request.params.ref, name: route.original }
                : { ...request.params.ref, uri: route.original },
          },
          route.entry.server.slug,
        );
        const raw = await this.#execute(
          server,
          route.entry,
          { method: 'completion/complete', params },
          context,
        );
        return CompleteResultSchema.parse(raw);
      });
    }

    if (aggregate.capabilities.logging) {
      server.setRequestHandler('logging/setLevel', async (request, context) => {
        const targets = this.#registry
          .entries()
          .filter(({ snapshot }) => snapshot.capabilities.logging);
        const results = await Promise.allSettled(
          targets.map((entry) =>
            this.#execute(
              server,
              entry,
              { method: 'logging/setLevel', params: request.params },
              context,
            ),
          ),
        );
        if (results.length > 0 && results.every((result) => result.status === 'rejected')) {
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            'Every upstream rejected log level',
          );
        }
        return {};
      });
    }

    server.fallbackRequestHandler = async (request, context) => {
      const taskMethod = canonicalTaskMethod(request.method);
      if (taskMethod) {
        const params = taskParamsSchema.parse(request.params);
        const route = parseVirtualTaskId(params.taskId);
        if (!route) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid ToolHome task ID');
        }
        const entry = this.#registry.entryBySlug(route.slug);
        const raw = await this.#execute(
          server,
          entry,
          {
            method: taskMethod,
            params: this.#restoreParams({ ...params, taskId: route.upstreamTaskId }, route.slug),
          },
          context,
        );
        return ResultSchema.parse(rewriteAggregateTask(raw, route.slug));
      }
      const route = splitAggregateExtensionMethod(request.method);
      if (!route) {
        throw new ProtocolError(
          ProtocolErrorCode.MethodNotFound,
          'Aggregate extension methods must use toolhome/{server_slug}/{upstream_method}',
        );
      }
      const entry = this.#registry.entryBySlug(route.slug);
      const raw = await this.#execute(
        server,
        entry,
        {
          method: route.upstreamMethod,
          ...(request.params === undefined
            ? {}
            : { params: this.#restoreParams(request.params, route.slug) }),
        },
        context,
      );
      return ResultSchema.parse(rewriteAggregateContent(raw, route.slug));
    };
    server.fallbackNotificationHandler = async (notification) => {
      const route = splitAggregateExtensionMethod(notification.method);
      if (!route) return;
      const entry = this.#registry.entryBySlug(route.slug);
      const forwarded: Notification = {
        method: route.upstreamMethod,
        ...(notification.params === undefined
          ? {}
          : { params: this.#restoreParams(notification.params, route.slug) }),
      };
      await this.#upstreams.notifyDetached(
        entry.server.id,
        forwarded,
        this.#notificationClientCapabilities(notification, server),
      );
    };
    this.#installClientNotificationBridges(server, () => this.#registry.entries());
    return server;
  }

  individual(slug: string): Server {
    const entry = this.#registry.entryBySlug(slug);
    const snapshot = entry.snapshot;
    const server = new Server(
      {
        name: `toolhome/${slug}`,
        title: entry.server.name,
        version: '0.1.0',
      },
      {
        capabilities: snapshot.capabilities,
        ...(snapshot.instructions === null ? {} : { instructions: snapshot.instructions }),
        requestState: { verify: this.#stateCodec.verify },
        inputRequired: { legacyShim: true },
      },
    );

    if (snapshot.capabilities.tools) {
      server.setRequestHandler('tools/list', async (request, context) => {
        const raw = await this.#execute(
          server,
          entry,
          { method: 'tools/list', params: request.params },
          context,
        );
        return ListToolsResultSchema.parse(raw);
      });
      server.setRequestHandler(
        'tools/call',
        { params: CallToolRequestParamsSchema, result: gatewayCallResultSchema },
        async (request, context) => {
          const startedAt = new Date();
          try {
            const raw = await this.#execute(
              server,
              entry,
              {
                method: 'tools/call',
                params: this.#prepareParams(request, context, entry.server.id),
              },
              context,
            );
            this.#recordCall(context, {
              endpointType: 'individual',
              serverId: entry.server.id,
              exposedToolName: request.name,
              upstreamToolName: request.name,
              status: 'success',
              startedAt,
              raw,
            });
            return this.#parseToolResult(raw, context, entry.server.id, null);
          } catch (error) {
            this.#recordCallError(context, {
              endpointType: 'individual',
              serverId: entry.server.id,
              exposedToolName: request.name,
              upstreamToolName: request.name,
              startedAt,
              error,
            });
            throw error;
          }
        },
      );
    }

    if (snapshot.capabilities.prompts) {
      server.setRequestHandler('prompts/list', async (request, context) => {
        const raw = await this.#execute(
          server,
          entry,
          { method: 'prompts/list', params: request.params },
          context,
        );
        return ListPromptsResultSchema.parse(raw);
      });
      server.setRequestHandler('prompts/get', async (request, context) => {
        const raw = await this.#execute(
          server,
          entry,
          {
            method: 'prompts/get',
            params: this.#prepareParams(request.params, context, entry.server.id),
          },
          context,
        );
        return this.#parsePromptResult(raw, context, entry.server.id);
      });
    }

    if (snapshot.capabilities.resources) {
      server.setRequestHandler('resources/list', async (request, context) => {
        const raw = await this.#execute(
          server,
          entry,
          { method: 'resources/list', params: request.params },
          context,
        );
        return ListResourcesResultSchema.parse(raw);
      });
      server.setRequestHandler('resources/templates/list', async (request, context) => {
        const raw = await this.#execute(
          server,
          entry,
          { method: 'resources/templates/list', params: request.params },
          context,
        );
        return ListResourceTemplatesResultSchema.parse(raw);
      });
      server.setRequestHandler('resources/read', async (request, context) => {
        const raw = await this.#execute(
          server,
          entry,
          {
            method: 'resources/read',
            params: this.#prepareParams(request.params, context, entry.server.id),
          },
          context,
        );
        return this.#parseResourceResult(raw, context, entry.server.id);
      });
      if (snapshot.capabilities.resources.subscribe) {
        server.setRequestHandler('resources/subscribe', async (request, context) => {
          await this.#execute(
            server,
            entry,
            { method: 'resources/subscribe', params: request.params },
            context,
          );
          return {};
        });
        server.setRequestHandler('resources/unsubscribe', async (request, context) => {
          await this.#execute(
            server,
            entry,
            { method: 'resources/unsubscribe', params: request.params },
            context,
          );
          return {};
        });
      }
    }

    if (snapshot.capabilities.completions) {
      server.setRequestHandler('completion/complete', async (request, context) => {
        const raw = await this.#execute(
          server,
          entry,
          { method: 'completion/complete', params: request.params },
          context,
        );
        return CompleteResultSchema.parse(raw);
      });
    }

    if (snapshot.capabilities.logging) {
      server.setRequestHandler('logging/setLevel', async (request, context) => {
        const raw = await this.#execute(
          server,
          entry,
          { method: 'logging/setLevel', params: request.params },
          context,
        );
        return EmptyResultSchema.parse(raw);
      });
    }

    server.fallbackRequestHandler = async (request, context) => {
      const taskMethod = canonicalTaskMethod(request.method);
      const raw = await this.#execute(
        server,
        entry,
        { method: taskMethod ?? request.method, params: request.params },
        context,
      );
      return ResultSchema.parse(raw);
    };
    server.fallbackNotificationHandler = async (notification) => {
      await this.#upstreams.notifyDetached(
        entry.server.id,
        notification,
        this.#notificationClientCapabilities(notification, server),
      );
    };
    this.#installClientNotificationBridges(server, () => [entry]);
    return server;
  }

  async #execute(
    server: Server,
    entry: RegistryEntry,
    request: { method: string; params?: Record<string, unknown> | undefined },
    context: ServerContext,
  ): Promise<unknown> {
    try {
      return await this.#upstreams.execute(
        entry.server.id,
        request,
        context,
        this.#requestClientCapabilities(server, context),
        this.#aggregateServers.has(server)
          ? {
              transformClientResult: (value: unknown) =>
                restoreAggregateContent(value, entry.server.slug),
              transformNotification: (notification: Notification) =>
                this.#aggregateNotification(notification, entry.server.slug),
              transformRequest: (upstreamRequest: {
                method: string;
                params?: Record<string, unknown>;
              }) => this.#aggregateRequest(upstreamRequest, entry.server.slug),
            }
          : {},
      );
    } catch (error) {
      if (ProtocolError.isInstance(error)) throw error;
      if (error instanceof AppError) {
        const code =
          error.status === 404
            ? ProtocolErrorCode.InvalidParams
            : error.status >= 500
              ? ProtocolErrorCode.InternalError
              : ProtocolErrorCode.InvalidParams;
        throw new ProtocolError(code, error.message, {
          source: entry.server.slug,
          code: error.code,
        });
      }
      throw error;
    }
  }

  #aggregateNotification(notification: Notification, slug: string): Notification {
    const method = coreServerNotificationMethods.has(notification.method)
      ? notification.method
      : aggregateExtensionMethod(slug, notification.method);
    if (notification.params === undefined) return { method };
    let value: unknown = rewriteAggregateContent(notification.params, slug);
    if (notification.method === 'notifications/resources/updated') {
      const uri = notification.params.uri;
      if (typeof uri === 'string' && isRecord(value)) {
        value = { ...value, uri: virtualResourceUri(slug, uri) };
      }
    }
    if (
      notification.method === 'notifications/tasks/status' ||
      notification.method === 'notifications/tasks'
    ) {
      value = rewriteAggregateTask(notification.params, slug);
    }
    return isRecord(value) ? { method, params: value } : { method, params: notification.params };
  }

  #aggregateRequest(
    request: { method: string; params?: Record<string, unknown> },
    slug: string,
  ): { method: string; params?: Record<string, unknown> } {
    const method = coreClientRequestMethods.has(request.method)
      ? request.method
      : aggregateExtensionMethod(slug, request.method);
    if (request.params === undefined) return { method };
    const rewritten = rewriteAggregateContent(request.params, slug);
    return {
      method,
      params: isRecord(rewritten) ? rewritten : request.params,
    };
  }

  #requestClientCapabilities(server: Server, context: ServerContext): ClientCapabilities {
    const envelope = context.mcpReq.envelope;
    if (envelope) {
      const parsed = ClientCapabilitiesSchema.safeParse(
        Reflect.get(envelope, CLIENT_CAPABILITIES_META_KEY),
      );
      if (parsed.success) return parsed.data;
    }
    return server.getClientCapabilities() ?? {};
  }

  #notificationClientCapabilities(notification: Notification, server: Server): ClientCapabilities {
    const metadata = notification.params?._meta;
    if (metadata) {
      const parsed = ClientCapabilitiesSchema.safeParse(
        Reflect.get(metadata, CLIENT_CAPABILITIES_META_KEY),
      );
      if (parsed.success) return parsed.data;
    }
    return server.getClientCapabilities() ?? {};
  }

  #installClientNotificationBridges(server: Server, entries: () => RegistryEntry[]): void {
    const forward = async (notification: Notification): Promise<void> => {
      const capabilities = this.#notificationClientCapabilities(notification, server);
      await Promise.allSettled(
        entries().map((entry) =>
          this.#upstreams.notifyDetached(entry.server.id, notification, capabilities),
        ),
      );
    };
    server.setNotificationHandler('notifications/roots/list_changed', forward);
    server.setNotificationHandler('notifications/elicitation/complete', forward);
  }

  #prepareParams(
    value: Record<string, unknown>,
    context: ServerContext,
    serverId: string,
    aggregateSlug?: string,
  ): Record<string, unknown> {
    const state = context.mcpReq.requestState<GatewayRequestState>();
    const aggregate = aggregateSlug !== undefined;
    if (state && (state.serverId !== serverId || state.aggregate !== aggregate)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Request state target mismatch');
    }
    const prepared = {
      ...value,
      ...(context.mcpReq.inputResponses === undefined
        ? {}
        : { inputResponses: context.mcpReq.inputResponses }),
      ...(state?.upstreamRequestState === undefined
        ? {}
        : { requestState: state.upstreamRequestState }),
    };
    return aggregateSlug === undefined ? prepared : this.#restoreParams(prepared, aggregateSlug);
  }

  #restoreParams(value: unknown, slug: string): Record<string, unknown> {
    const restored = restoreAggregateContent(value, slug);
    if (!isRecord(restored)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid aggregate request params');
    }
    return restored;
  }

  async #parseToolResult(
    value: unknown,
    context: ServerContext,
    serverId: string,
    aggregateSlug: string | null,
  ): Promise<z.infer<typeof gatewayCallResultSchema>> {
    if (isInputRequiredResult(value)) {
      return gatewayCallResultSchema.parse(
        await this.#wrapInputRequired(value, context, serverId, aggregateSlug),
      );
    }
    if (
      extensionTaskResultSchema.safeParse(value).success ||
      legacyTaskResultSchema.safeParse(value).success
    ) {
      return gatewayCallResultSchema.parse(
        aggregateSlug === null ? value : rewriteAggregateTask(value, aggregateSlug),
      );
    }
    return gatewayCallResultSchema.parse(
      aggregateSlug === null ? value : rewriteAggregateContent(value, aggregateSlug),
    );
  }

  async #parsePromptResult(
    value: unknown,
    context: ServerContext,
    serverId: string,
    aggregateSlug: string | null = null,
  ): Promise<ReturnType<typeof GetPromptResultSchema.parse> | InputRequiredResult> {
    if (isInputRequiredResult(value)) {
      return this.#wrapInputRequired(value, context, serverId, aggregateSlug);
    }
    return GetPromptResultSchema.parse(value);
  }

  async #parseResourceResult(
    value: unknown,
    context: ServerContext,
    serverId: string,
    aggregateSlug: string | null = null,
  ): Promise<ReturnType<typeof ReadResourceResultSchema.parse> | InputRequiredResult> {
    if (isInputRequiredResult(value)) {
      return this.#wrapInputRequired(value, context, serverId, aggregateSlug);
    }
    return ReadResourceResultSchema.parse(value);
  }

  async #wrapInputRequired(
    value: InputRequiredResult,
    context: ServerContext,
    serverId: string,
    aggregateSlug: string | null,
  ): Promise<InputRequiredResult> {
    const state: GatewayRequestState = {
      aggregate: aggregateSlug !== null,
      serverId,
      ...(value.requestState === undefined ? {} : { upstreamRequestState: value.requestState }),
    };
    const rewritten =
      aggregateSlug === null ? value : rewriteAggregateContent(value, aggregateSlug);
    if (!isInputRequiredResult(rewritten)) {
      throw new ProtocolError(ProtocolErrorCode.InternalError, 'Invalid input-required result');
    }
    return {
      ...rewritten,
      requestState: await this.#stateCodec.mint(state, context),
    };
  }

  async #aggregateTools(
    server: Server,
    entries: RegistryEntry[],
    context: ServerContext,
    params: unknown,
  ): Promise<Tool[]> {
    const groups = await Promise.all(
      entries
        .filter(({ snapshot }) => snapshot.capabilities.tools)
        .map(async (entry) => {
          const tools = await this.#listTools(server, entry, context, params);
          // Tool visibility is an aggregate-endpoint projection: hidden tools
          // are excluded here (and enforced again in #liveToolRoute).
          const visible = this.#projections.apply(entry.server.id, tools);
          return visible.map((tool) => ({
            ...rewriteAggregateTool(tool, entry.server.slug),
            name: aggregateName(entry.server.slug, tool.name),
          }));
        }),
    );
    return groups.flat().sort((left, right) => left.name.localeCompare(right.name));
  }

  async #aggregatePrompts(
    server: Server,
    entries: RegistryEntry[],
    context: ServerContext,
    params: unknown,
  ): Promise<Prompt[]> {
    const groups = await Promise.all(
      entries
        .filter(({ snapshot }) => snapshot.capabilities.prompts)
        .map(async (entry) =>
          (await this.#listPrompts(server, entry, context, params)).map((prompt) => ({
            ...prompt,
            name: aggregateName(entry.server.slug, prompt.name),
          })),
        ),
    );
    return groups.flat().sort((left, right) => left.name.localeCompare(right.name));
  }

  async #aggregateResources(
    server: Server,
    entries: RegistryEntry[],
    context: ServerContext,
    params: unknown,
  ): Promise<Resource[]> {
    const groups = await Promise.all(
      entries
        .filter(({ snapshot }) => snapshot.capabilities.resources)
        .map(async (entry) =>
          (await this.#listResources(server, entry, context, params)).map((resource) => ({
            ...resource,
            uri: virtualResourceUri(entry.server.slug, resource.uri),
          })),
        ),
    );
    return groups.flat().sort((left, right) => left.uri.localeCompare(right.uri));
  }

  async #aggregateResourceTemplates(
    server: Server,
    entries: RegistryEntry[],
    context: ServerContext,
    params: unknown,
  ): Promise<ResourceTemplateType[]> {
    const groups = await Promise.all(
      entries
        .filter(({ snapshot }) => snapshot.capabilities.resources)
        .map(async (entry) =>
          (await this.#listResourceTemplates(server, entry, context, params)).map((template) => ({
            ...template,
            uriTemplate: virtualResourceTemplate(entry.server.slug, template.uriTemplate),
          })),
        ),
    );
    return groups.flat().sort((left, right) => left.uriTemplate.localeCompare(right.uriTemplate));
  }

  async #listTools(
    server: Server,
    entry: RegistryEntry,
    context: ServerContext,
    params: unknown,
  ): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 256; page += 1) {
      const raw = await this.#execute(
        server,
        entry,
        { method: 'tools/list', params: this.#listParams(params, cursor) },
        context,
      );
      const result = ListToolsResultSchema.parse(raw);
      tools.push(...result.tools);
      if (result.nextCursor === undefined) return tools;
      this.#rememberCursor(seen, result.nextCursor, 'tools/list');
      cursor = result.nextCursor;
    }
    throw new ProtocolError(ProtocolErrorCode.InternalError, 'tools/list exceeded 256 pages');
  }

  async #listPrompts(
    server: Server,
    entry: RegistryEntry,
    context: ServerContext,
    params: unknown,
  ): Promise<Prompt[]> {
    const prompts: Prompt[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 256; page += 1) {
      const raw = await this.#execute(
        server,
        entry,
        { method: 'prompts/list', params: this.#listParams(params, cursor) },
        context,
      );
      const result = ListPromptsResultSchema.parse(raw);
      prompts.push(...result.prompts);
      if (result.nextCursor === undefined) return prompts;
      this.#rememberCursor(seen, result.nextCursor, 'prompts/list');
      cursor = result.nextCursor;
    }
    throw new ProtocolError(ProtocolErrorCode.InternalError, 'prompts/list exceeded 256 pages');
  }

  async #listResources(
    server: Server,
    entry: RegistryEntry,
    context: ServerContext,
    params: unknown,
  ): Promise<Resource[]> {
    const resources: Resource[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 256; page += 1) {
      const raw = await this.#execute(
        server,
        entry,
        { method: 'resources/list', params: this.#listParams(params, cursor) },
        context,
      );
      const result = ListResourcesResultSchema.parse(raw);
      resources.push(...result.resources);
      if (result.nextCursor === undefined) return resources;
      this.#rememberCursor(seen, result.nextCursor, 'resources/list');
      cursor = result.nextCursor;
    }
    throw new ProtocolError(ProtocolErrorCode.InternalError, 'resources/list exceeded 256 pages');
  }

  async #listResourceTemplates(
    server: Server,
    entry: RegistryEntry,
    context: ServerContext,
    params: unknown,
  ): Promise<ResourceTemplateType[]> {
    const templates: ResourceTemplateType[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 256; page += 1) {
      const raw = await this.#execute(
        server,
        entry,
        { method: 'resources/templates/list', params: this.#listParams(params, cursor) },
        context,
      );
      const result = ListResourceTemplatesResultSchema.parse(raw);
      templates.push(...result.resourceTemplates);
      if (result.nextCursor === undefined) return templates;
      this.#rememberCursor(seen, result.nextCursor, 'resources/templates/list');
      cursor = result.nextCursor;
    }
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      'resources/templates/list exceeded 256 pages',
    );
  }

  async #liveToolRoute(
    server: Server,
    name: string,
    context: ServerContext,
  ): Promise<{ entry: RegistryEntry; originalName: string }> {
    const appRoute = this.#appResourceRoute(context.mcpReq._meta);
    if (appRoute) {
      const entry = this.#registry.entryBySlug(appRoute.slug);
      const tool = (await this.#listTools(server, entry, context, {})).find(
        (candidate) =>
          candidate.name === name || aggregateName(entry.server.slug, candidate.name) === name,
      );
      if (tool && this.#projections.isVisible(entry.server.id, tool.name)) {
        return { entry, originalName: tool.name };
      }
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    const parsed = splitAggregateName(name);
    if (parsed) {
      const entry = this.#registry.entryBySlug(parsed.slug);
      const tool = (await this.#listTools(server, entry, context, {})).find(
        (candidate) => aggregateName(entry.server.slug, candidate.name) === name,
      );
      if (tool && this.#projections.isVisible(entry.server.id, tool.name)) {
        return { entry, originalName: tool.name };
      }
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    const candidates = (
      await Promise.all(
        this.#registry.entries().map(async (entry) => ({
          entry,
          tool: (await this.#listTools(server, entry, context, {})).find(
            (candidate) =>
              candidate.name === name && this.#projections.isVisible(entry.server.id, candidate.name),
          ),
        })),
      )
    ).filter((candidate) => candidate.tool !== undefined);
    if (candidates.length === 1 && candidates[0]?.tool) {
      return { entry: candidates[0].entry, originalName: candidates[0].tool.name };
    }
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      candidates.length > 1
        ? `Tool name is ambiguous in the aggregate endpoint: ${name}`
        : `Unknown aggregate tool: ${name}`,
    );
  }

  #recordCall(
    context: ServerContext,
    input: {
      endpointType: ToolCallDraft['endpointType'];
      serverId: string;
      exposedToolName: string;
      upstreamToolName: string;
      status: ToolCallStatus;
      startedAt: Date;
      raw: unknown;
    },
  ): void {
    const completedAt = new Date();
    const toolError = isRecord(input.raw) && input.raw.isError === true;
    this.#recorder.record({
      endpointType: input.endpointType,
      principalKind: this.#principalKind(context),
      principalId: context.http?.authInfo?.clientId ?? 'anonymous',
      serverId: input.serverId,
      exposedToolName: input.exposedToolName,
      upstreamToolName: input.upstreamToolName,
      status: toolError ? 'tool_error' : input.status,
      errorType: toolError ? 'tool_error' : null,
      startedAt: input.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - input.startedAt.getTime()),
    });
  }

  #recordCallError(
    context: ServerContext,
    input: {
      endpointType: ToolCallDraft['endpointType'];
      serverId: string | null;
      exposedToolName: string;
      upstreamToolName: string;
      startedAt: Date;
      error: unknown;
    },
  ): void {
    const completedAt = new Date();
    this.#recorder.record({
      endpointType: input.endpointType,
      principalKind: this.#principalKind(context),
      principalId: context.http?.authInfo?.clientId ?? 'anonymous',
      serverId: input.serverId,
      exposedToolName: input.exposedToolName,
      upstreamToolName: input.upstreamToolName,
      status: this.#errorStatus(input.error),
      errorType: this.#errorCode(input.error),
      startedAt: input.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - input.startedAt.getTime()),
    });
  }

  #principalKind(context: ServerContext): ToolCallDraft['principalKind'] {
    const kind = (context.http?.authInfo?.extra as { credentialKind?: string } | undefined)
      ?.credentialKind;
    if (kind === 'control') return 'control_key';
    if (kind === 'access') return 'access_key';
    return 'oauth_client';
  }

  #errorStatus(error: unknown): ToolCallStatus {
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) return 'timeout';
    return 'protocol_error';
  }

  #errorCode(error: unknown): string | null {
    if (error instanceof ProtocolError) return String(error.code);
    if (error instanceof SdkError) return error.code;
    if (error instanceof AppError) return error.code;
    return null;
  }

  #appResourceRoute(metadata: Record<string, unknown> | undefined): { slug: string } | null {
    if (!metadata) return null;
    const legacy = metadata['ui/resourceUri'];
    if (typeof legacy === 'string') return parseVirtualResourceUri(legacy);
    const ui = metadata.ui;
    if (ui === null || typeof ui !== 'object' || Array.isArray(ui)) return null;
    const resourceUri = Reflect.get(ui, 'resourceUri');
    return typeof resourceUri === 'string' ? parseVirtualResourceUri(resourceUri) : null;
  }

  async #livePromptRoute(
    server: Server,
    name: string,
    context: ServerContext,
  ): Promise<{ entry: RegistryEntry; originalName: string }> {
    const parsed = splitAggregateName(name);
    if (!parsed)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid aggregate prompt name');
    const entry = this.#registry.entryBySlug(parsed.slug);
    const prompt = (await this.#listPrompts(server, entry, context, {})).find(
      (candidate) => aggregateName(entry.server.slug, candidate.name) === name,
    );
    if (!prompt)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    return { entry, originalName: prompt.name };
  }

  #listParams(value: unknown, cursor: string | undefined): Record<string, unknown> {
    const parsed = paramsSchema.safeParse(value);
    const base = parsed.success
      ? Object.fromEntries(Object.entries(parsed.data).filter(([key]) => key !== 'cursor'))
      : {};
    return cursor === undefined ? base : { ...base, cursor };
  }

  #rememberCursor(seen: Set<string>, cursor: string, method: string): void {
    if (seen.has(cursor)) {
      throw new ProtocolError(ProtocolErrorCode.InternalError, `${method} repeated a cursor`);
    }
    seen.add(cursor);
  }

  #resourceRoute(uri: string): { entry: RegistryEntry; upstreamUri: string } {
    const parsed = parseVirtualResourceUri(uri) ?? expandVirtualResourceTemplate(uri);
    if (!parsed) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid ToolHome URI');
    return {
      entry: this.#registry.entryBySlug(parsed.slug),
      upstreamUri: parsed.upstreamUri,
    };
  }

  async #promptCompletionRoute(
    server: Server,
    name: string,
    context: ServerContext,
  ): Promise<{ entry: RegistryEntry; original: string }> {
    const route = await this.#livePromptRoute(server, name, context);
    return { entry: route.entry, original: route.originalName };
  }

  #resourceCompletionRoute(uri: string): { entry: RegistryEntry; original: string } {
    const template = parseVirtualResourceTemplate(uri);
    if (template) {
      return {
        entry: this.#registry.entryBySlug(template.slug),
        original: template.upstreamTemplate,
      };
    }
    const route = this.#resourceRoute(uri);
    return { entry: route.entry, original: route.upstreamUri };
  }

  #page<T>(items: T[], cursor: string | undefined, key: string): Page<T> {
    const offset = cursor === undefined ? 0 : this.#cursors.decode(cursor, key).offset;
    const pageItems = items.slice(offset, offset + pageSize);
    const nextOffset = offset + pageItems.length;
    return {
      items: pageItems,
      ...(nextOffset >= items.length
        ? {}
        : { nextCursor: this.#cursors.encode({ key, offset: nextOffset }) }),
    };
  }

  #nextCursor(page: Page<unknown>): { nextCursor?: string } {
    return page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor };
  }
}

const coreServerNotificationMethods = new Set([
  'notifications/cancelled',
  'notifications/progress',
  'notifications/message',
  'notifications/resources/updated',
  'notifications/resources/list_changed',
  'notifications/tools/list_changed',
  'notifications/prompts/list_changed',
  'notifications/subscriptions/acknowledged',
  'notifications/tasks/status',
  'notifications/tasks',
]);

const coreClientRequestMethods = new Set([
  'ping',
  'roots/list',
  'sampling/createMessage',
  'elicitation/create',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
