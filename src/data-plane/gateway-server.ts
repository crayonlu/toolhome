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
  fromJsonSchema,
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
import { CompactState, type CompactInvocation } from './compact-state.js';
import { ToolCatalog } from './tool-catalog.js';
import {
  CompactError,
  compactErrorResult,
  compactTools,
  parseExecArgs,
  executionBoundaryForTool,
} from './compact-protocol.js';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { ToolCallDraft, ToolCallStatus } from '../domain/models.js';
import type { CallRecorder } from '../observability/call-recorder.js';
import type { CursorCodec } from '../security/cursor-codec.js';
import type { UpstreamManager } from '../upstream/manager.js';
import type { ExecutionOptions } from '../upstream/adapter.js';
import { fingerprint } from '../upstream/stable-json.js';
import { CapabilityRegistry, type RegistryEntry } from './registry.js';
import { canonicalTaskMethod } from './task-extension.js';
import { ToolProjectionService } from './projection.js';
import {
  aggregateName,
  aggregateToolName,
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
  splitAggregateToolName,
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

interface AggregateList<T> {
  items: T[];
  failedServers: string[];
}

interface GatewayRequestState {
  aggregate: boolean;
  serverId: string;
  upstreamRequestState?: string;
  compactInvocation?: string;
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
  readonly #compactState = new CompactState();
  readonly #options: {
    toolMode?: 'full' | 'compact';
    scope?: 'host' | 'local';
    nodeLabel?: string;
  };

  constructor(
    registry: CapabilityRegistry,
    upstreams: UpstreamManager,
    cursors: CursorCodec,
    masterKey: string,
    projections: ToolProjectionService,
    recorder: CallRecorder,
    options: { toolMode?: 'full' | 'compact'; scope?: 'host' | 'local'; nodeLabel?: string } = {},
  ) {
    this.#registry = registry;
    this.#upstreams = upstreams;
    this.#cursors = cursors;
    this.#projections = projections;
    this.#recorder = recorder;
    this.#options = options;
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
        capabilities:
          this.#options.toolMode === 'compact'
            ? { ...aggregate.capabilities, tools: { listChanged: true } }
            : aggregate.capabilities,
        instructions:
          'ToolHome aggregates enabled servers. Tools use server_slug_encodedToolName; prompts use server_slug.name. Resources use toolhome:// virtual URIs. Use an individual /mcp/{server_slug} endpoint for exact upstream names and extension semantics.',
        requestState: { verify: this.#stateCodec.verify },
        inputRequired: { legacyShim: true },
      },
    );
    this.#aggregateServers.add(server);

    if (this.#options.toolMode === 'compact') {
      this.#installCompactTools(server);
    } else if (aggregate.capabilities.tools) {
      server.setRequestHandler('tools/list', async (request, context) => {
        const entries = this.#registry.entries();
        const listed = await this.#aggregateTools(server, entries, context, request.params);
        const tools = listed.items;
        const page = this.#page(
          tools,
          request.params?.cursor,
          fingerprint({ tools, failedServers: listed.failedServers }),
        );
        return {
          tools: page.items,
          ...this.#nextCursor(page),
          ttlMs: 0,
          cacheScope: 'private',
          _meta: {
            'toolhome/server-count': entries.length,
            ...this.#aggregateListMeta(listed),
          },
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
              this.#restoreParams(
                { ...request, name: route.originalName },
                route.entry.server.slug,
              ),
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
        const listed = await this.#aggregatePrompts(
          server,
          this.#registry.entries(),
          context,
          request.params,
        );
        const prompts = listed.items;
        const page = this.#page(
          prompts,
          request.params?.cursor,
          fingerprint({ prompts, failedServers: listed.failedServers }),
        );
        return {
          prompts: page.items,
          ...this.#nextCursor(page),
          ttlMs: 0,
          cacheScope: 'private',
          _meta: this.#aggregateListMeta(listed),
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
        const listed = await this.#aggregateResources(
          server,
          this.#registry.entries(),
          context,
          request.params,
        );
        const resources = listed.items;
        const page = this.#page(
          resources,
          request.params?.cursor,
          fingerprint({ resources, failedServers: listed.failedServers }),
        );
        return {
          resources: page.items,
          ...this.#nextCursor(page),
          ttlMs: 0,
          cacheScope: 'private',
          _meta: this.#aggregateListMeta(listed),
        };
      });
      server.setRequestHandler('resources/templates/list', async (request, context) => {
        const listed = await this.#aggregateResourceTemplates(
          server,
          this.#registry.entries(),
          context,
          request.params,
        );
        const resourceTemplates = listed.items;
        const page = this.#page(
          resourceTemplates,
          request.params?.cursor,
          fingerprint({ resourceTemplates, failedServers: listed.failedServers }),
        );
        return {
          resourceTemplates: page.items,
          ...this.#nextCursor(page),
          ttlMs: 0,
          cacheScope: 'private',
          _meta: this.#aggregateListMeta(listed),
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
      const listKeys: Record<string, string> = {
        'tools/list': 'tools',
        'prompts/list': 'prompts',
        'resources/list': 'resources',
        'resources/templates/list': 'resourceTemplates',
      };
      const emptyListKey = Object.hasOwn(listKeys, request.method)
        ? listKeys[request.method]
        : undefined;
      if (emptyListKey) {
        context.mcpReq.signal.throwIfAborted();
        const cursor = request.params?.cursor;
        if (cursor !== undefined && typeof cursor !== 'string') {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid cursor');
        }
        const page = this.#page([], cursor, fingerprint({ [emptyListKey]: [], failedServers: [] }));
        return { [emptyListKey]: page.items, ttlMs: 0, cacheScope: 'private' };
      }
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

  async catalogChanged(): Promise<void> {
    if (this.#options.toolMode !== 'compact') return;
    await this.#compactState.revoke(
      (invocation) => {
        try {
          const target = this.#catalog().resolve(invocation.exposedTool);
          return (
            target.entry.server.id === invocation.serverId &&
            this.#compactRevision(target.entry) === invocation.revision
          );
        } catch {
          return false;
        }
      },
      (invocation) => this.#terminateCompact(invocation),
    );
  }

  async close(): Promise<void> {
    await this.#compactState.revoke(
      () => false,
      (invocation) => this.#terminateCompact(invocation),
    );
  }

  #catalog(): ToolCatalog {
    return new ToolCatalog(this.#registry.store(), this.#projections, {
      scope: this.#options.scope ?? 'host',
      nodeId: this.#options.nodeLabel,
      hosts: (record) => this.#upstreams.hosts(record),
    });
  }

  #compactProfile(server: Server, context: ServerContext): string {
    return fingerprint({
      principal: context.http?.authInfo?.clientId ?? 'local',
      capabilities: this.#requestClientCapabilities(server, context),
    });
  }

  #compactRevision(entry: RegistryEntry): string {
    return fingerprint({
      server: entry.server,
      snapshot: entry.snapshot.fingerprint,
      projection: this.#registry.store().getProjectionIndex().get(entry.server.id)
        ? {
            default: this.#registry.store().getServerProjection(entry.server.id),
            tools: this.#registry.store().listToolProjections(entry.server.id),
          }
        : null,
    });
  }

  #compactKey(profile: string, tool: string): string {
    return `${profile}/${tool}`;
  }

  #installCompactTools(server: Server): void {
    server.setRequestHandler('tools/list', async () => ({
      tools: compactTools(),
      ttlMs: 0,
      cacheScope: 'private',
    }));
    server.setRequestHandler(
      'tools/call',
      { params: CallToolRequestParamsSchema, result: gatewayCallResultSchema },
      async (request, context) => {
        if (request.name === 'search') {
          const startedAt = Date.now();
          const catalog = this.#catalog();
          const profile = this.#compactProfile(server, context);
          const result = catalog.search(request.arguments, (id) => {
            try {
              const resolved = catalog.resolve(id);
              const tool = this.#compactState.observed(
                this.#compactKey(profile, id),
                this.#compactRevision(resolved.entry),
              );
              return tool ? { serverId: resolved.entry.server.id, tool } : undefined;
            } catch {
              return undefined;
            }
          });
          this.#registry.store().appendEvent({
            level: 'debug',
            type: 'compact.search',
            serverId: null,
            message: 'Compact capability discovery',
            detail: {
              durationMs: Date.now() - startedAt,
              bytes: Buffer.byteLength(JSON.stringify(result)),
            },
          });
          return result;
        }
        if (request.name !== 'exec')
          return compactErrorResult(
            new CompactError('unknown_tool', 'Use search or exec in compact mode.'),
          );
        return this.#compactExec(server, request, context);
      },
    );
  }

  async #compactExec(
    server: Server,
    request: { name: string; arguments?: Record<string, unknown>; task?: unknown },
    context: ServerContext,
  ): Promise<z.infer<typeof gatewayCallResultSchema>> {
    const startedAt = new Date();
    let target: { entry: RegistryEntry; tool: Tool } | undefined;
    let invocation: CompactInvocation | undefined;
    let submitted = false;
    let ownsInvocation = false;
    const profile = this.#compactProfile(server, context);
    const state = context.mcpReq.requestState<GatewayRequestState>();
    try {
      const args = parseExecArgs(request.arguments);
      const catalog = this.#catalog();
      const key = this.#compactKey(profile, args.tool);
      if (!state && context.mcpReq.inputResponses !== undefined) {
        throw new CompactError(
          'continuation_rejected',
          'Continuation state is required; the invocation will not be restarted.',
        );
      }
      if (state) {
        if (!state.compactInvocation)
          throw new CompactError(
            'continuation_rejected',
            'This request state belongs to a different invocation.',
          );
        invocation = this.#compactState.invocation(state.compactInvocation);
        if (
          !invocation ||
          invocation.key !== key ||
          invocation.exposedTool !== args.tool ||
          state.serverId !== invocation.serverId ||
          !state.aggregate
        ) {
          throw new CompactError(
            'continuation_rejected',
            'Continuation target or profile mismatch.',
          );
        }
        if (invocation.busy)
          throw new CompactError('continuation_rejected', 'Continuation is already in progress.');
        try {
          target = catalog.resolve(invocation.exposedTool);
          if (
            target.entry.server.id !== invocation.serverId ||
            this.#compactRevision(target.entry) !== invocation.revision
          ) {
            throw new Error('Invocation configuration changed.');
          }
        } catch {
          await this.#terminateCompact(invocation);
          this.#compactState.release(invocation.id);
          throw new CompactError(
            'continuation_rejected',
            'Invocation is no longer enabled or visible.',
          );
        }
        if (invocation.upstreamRequestState === undefined) {
          // No upstream round to resume: re-sending the bound arguments would be
          // a new business invocation, so fail closed instead of replaying.
          await this.#terminateCompact(invocation);
          this.#compactState.release(invocation.id);
          throw new CompactError(
            'continuation_rejected',
            'The original invocation cannot be resumed; it will not be restarted.',
            {
              nextStep: { action: 'use_individual', guidance: this.#compactEndpoint(target.entry) },
            },
          );
        }
        if (
          (Object.keys(args.arguments).length > 0 &&
            fingerprint(args.arguments) !== fingerprint(invocation.arguments)) ||
          (args.definition !== undefined && args.definition !== invocation.definition)
        ) {
          throw new CompactError(
            'continuation_rejected',
            'Continuation must retain its original arguments and definition.',
          );
        }
        invocation.busy = true;
        ownsInvocation = true;
        target.tool = invocation.tool;
        submitted = true;
      } else {
        target = catalog.resolve(args.tool);
        const live = (await this.#listTools(server, target.entry, context, {})).find(
          (tool) => tool.name === target!.tool.name,
        );
        if (!live)
          throw new CompactError('unknown_tool', 'The target is absent from its live directory.');
        target.tool = live;
        if (executionBoundaryForTool(live) !== 'exec' || this.#compactAppServer(target.entry)) {
          throw new CompactError(
            'individual_endpoint_required',
            'Use the original endpoint for this server’s App tools.',
            {
              nextStep: { action: 'use_individual', guidance: this.#compactEndpoint(target.entry) },
            },
          );
        }
        const contractResult = catalog.search({ action: 'describe', tool: args.tool }, () => ({
          serverId: target!.entry.server.id,
          tool: live,
        }));
        const contractText = contractResult.content.find((item) => item.type === 'text');
        const contract =
          contractText?.type === 'text'
            ? (JSON.parse(contractText.text) as Record<string, unknown>)
            : {};
        if (contractResult.isError) return gatewayCallResultSchema.parse(contractResult);
        const definition = String(contract.definition);
        const revision = this.#compactRevision(target.entry);
        const saved = this.#compactState.observe(key, target.entry.server.id, revision, live);
        if (args.definition !== undefined && args.definition !== definition) {
          throw new CompactError(
            saved ? 'definition_changed' : 'definition_too_large',
            'The target contract changed before invocation. Obtain its current definition.',
            {
              nextStep: saved
                ? { action: 'describe', arguments: { action: 'describe', tool: args.tool } }
                : { action: 'use_individual', guidance: this.#compactEndpoint(target.entry) },
            },
          );
        }
        const validation = await fromJsonSchema(
          live.inputSchema as Parameters<typeof fromJsonSchema>[0],
        )['~standard'].validate(args.arguments);
        if (validation.issues)
          throw new CompactError(
            'invalid_arguments',
            validation.issues
              .map((issue) => issue.message)
              .join('; ')
              .slice(0, 1200),
          );
        const taskSupport = live.execution?.taskSupport;
        // Task semantics are carried on the request params (`CallToolRequestParams`
        // extends `TaskAugmentedRequestParams`), not the `_meta` envelope.
        const taskRequested = request.task !== undefined;
        if (taskSupport === 'required' || (taskRequested && taskSupport !== 'optional')) {
          throw new CompactError(
            'individual_endpoint_required',
            'Use the original endpoint for this Task/client combination.',
            {
              nextStep: { action: 'use_individual', guidance: this.#compactEndpoint(target.entry) },
            },
          );
        }
        invocation =
          this.#compactState.retain(
            {
              key,
              serverId: target.entry.server.id,
              exposedTool: args.tool,
              tool: live,
              arguments: args.arguments,
              definition,
              revision,
            },
            target.entry.server.settings.maxTotalTimeoutMs,
            (value) => this.#terminateCompact(value),
          ) ?? undefined;
        if (!invocation)
          throw new CompactError('continuation_rejected', 'Pending invocation capacity exceeded.', {
            callEffect: 'not_started',
            nextStep: { action: 'use_individual', guidance: this.#compactEndpoint(target.entry) },
          });
        invocation.busy = true;
        ownsInvocation = true;
      }
      const params = this.#restoreParams(
        {
          ...request,
          name: invocation.tool.name,
          arguments: invocation.arguments,
          ...(invocation.upstreamRequestState === undefined
            ? {}
            : { requestState: invocation.upstreamRequestState }),
          ...(context.mcpReq.inputResponses === undefined
            ? {}
            : { inputResponses: context.mcpReq.inputResponses }),
        },
        target.entry.server.slug,
      );
      const raw = await this.#execute(
        server,
        target.entry,
        { method: 'tools/call', params },
        context,
        {
          toolDefinition: invocation.tool,
          onDispatch: () => {
            submitted = true;
          },
        },
      );
      this.#recordCall(context, {
        endpointType: 'aggregate',
        serverId: target.entry.server.id,
        exposedToolName: 'exec',
        upstreamToolName: invocation.tool.name,
        status: 'success',
        startedAt,
        raw,
      });
      if (isInputRequiredResult(raw)) {
        invocation.upstreamRequestState = raw.requestState;
        invocation.busy = false;
        const rewritten = rewriteAggregateContent(raw, target.entry.server.slug);
        return gatewayCallResultSchema.parse({
          ...(rewritten as Record<string, unknown>),
          requestState: await this.#stateCodec.mint(
            { aggregate: true, serverId: target.entry.server.id, compactInvocation: invocation.id },
            context,
          ),
        });
      }
      this.#compactState.release(invocation.id);
      return this.#parseToolResult(raw, context, target.entry.server.id, target.entry.server.slug);
    } catch (error) {
      if (invocation && ownsInvocation) {
        invocation.busy = false;
        await this.#terminateCompact(invocation);
        this.#compactState.release(invocation.id);
      }
      if (target)
        this.#recordCallError(context, {
          endpointType: 'aggregate',
          serverId: target.entry.server.id,
          exposedToolName: 'exec',
          upstreamToolName: target.tool.name,
          startedAt,
          error,
        });
      if (CompactError.isInstance(error))
        return compactErrorResult(
          state && error.callEffect === 'not_started'
            ? new CompactError('continuation_rejected', error.message, {
                callEffect: 'may_have_run',
                nextStep: error.nextStep,
              })
            : error,
        );
      if (ProtocolError.isInstance(error) && error.code === -32020 && target) {
        let recovered = false;
        try {
          const live = (await this.#listTools(server, target.entry, context, {})).find(
            (tool) => tool.name === target!.tool.name,
          );
          if (live)
            recovered = this.#compactState.observe(
              this.#compactKey(profile, aggregateToolName(target.entry.server.slug, live.name)),
              target.entry.server.id,
              this.#compactRevision(target.entry),
              live,
            );
        } catch {
          /* Recovery cannot resubmit the business invocation. */
        }
        return compactErrorResult(
          new CompactError('definition_changed', error.message, {
            source: 'upstream',
            callEffect: 'may_have_run',
            nextStep: {
              action: 'check_status',
              guidance: recovered
                ? 'Check the original invocation, then describe the target before explicitly retrying.'
                : this.#compactEndpoint(target.entry),
            },
            details: { upstreamCode: error.code },
          }),
        );
      }
      return compactErrorResult(
        new CompactError(
          state ? 'continuation_rejected' : 'upstream_failure',
          error instanceof Error ? error.message.slice(0, 1200) : 'Upstream invocation failed.',
          {
            source: submitted ? 'upstream' : 'gateway',
            callEffect: submitted || state ? 'may_have_run' : 'not_started',
          },
        ),
      );
    }
  }

  #compactAppServer(entry: RegistryEntry): boolean {
    return entry.snapshot.tools.some((tool) => executionBoundaryForTool(tool) !== 'exec');
  }

  #compactEndpoint(entry: RegistryEntry): string {
    return this.#options.scope === 'local'
      ? `Use toolhome mcp launch ${entry.server.slug} on this machine.`
      : `Use /mcp/${entry.server.slug}.`;
  }

  async #terminateCompact(invocation: CompactInvocation): Promise<void> {
    if (invocation.upstreamRequestState !== undefined) {
      const result = this.#upstreams.terminateContinuation(
        invocation.serverId,
        invocation.upstreamRequestState,
      );
      if (result.limitation) {
        this.#registry.store().appendEvent({
          level: 'warn',
          type: 'compact.continuation.termination_limited',
          serverId: invocation.serverId,
          message: 'Upstream suspended state cannot be terminated by this gateway',
          detail: { kind: result.kind },
        });
      }
    }
  }

  async #execute(
    server: Server,
    entry: RegistryEntry,
    request: { method: string; params?: Record<string, unknown> | undefined },
    context: ServerContext,
    executionOptions?: ExecutionOptions,
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
        executionOptions,
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

  #aggregateListMeta(listed: AggregateList<unknown>): Record<string, unknown> {
    return listed.failedServers.length === 0
      ? {}
      : { 'toolhome/failed-servers': listed.failedServers };
  }

  async #aggregateList<T>(
    entries: RegistryEntry[],
    context: ServerContext,
    list: (entry: RegistryEntry) => Promise<T[]>,
  ): Promise<AggregateList<T>> {
    context.mcpReq.signal.throwIfAborted();
    const results = await Promise.allSettled(entries.map(list));
    context.mcpReq.signal.throwIfAborted();
    const items: T[] = [];
    const failedServers: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') items.push(...result.value);
      else failedServers.push(entries[index]!.server.slug);
    }
    failedServers.sort();
    if (results.length > 0 && failedServers.length === results.length) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        'Every upstream failed to list capabilities',
        {
          'toolhome/failed-servers': failedServers,
        },
      );
    }
    return { items, failedServers };
  }

  async #aggregateTools(
    server: Server,
    entries: RegistryEntry[],
    context: ServerContext,
    params: unknown,
  ): Promise<AggregateList<Tool>> {
    const listed = await this.#aggregateList(
      entries.filter(({ snapshot }) => snapshot.capabilities.tools),
      context,
      async (entry) => {
        const tools = await this.#listTools(server, entry, context, params);
        // Tool visibility applies only to the aggregate endpoint.
        const visible = this.#projections.apply(entry.server.id, tools);
        return visible.map((tool) => ({
          ...rewriteAggregateTool(tool, entry.server.slug),
          name: aggregateToolName(entry.server.slug, tool.name),
        }));
      },
    );
    listed.items.sort((left, right) => left.name.localeCompare(right.name));
    return listed;
  }

  async #aggregatePrompts(
    server: Server,
    entries: RegistryEntry[],
    context: ServerContext,
    params: unknown,
  ): Promise<AggregateList<Prompt>> {
    const listed = await this.#aggregateList(
      entries.filter(({ snapshot }) => snapshot.capabilities.prompts),
      context,
      async (entry) =>
        (await this.#listPrompts(server, entry, context, params)).map((prompt) => ({
          ...prompt,
          name: aggregateName(entry.server.slug, prompt.name),
        })),
    );
    listed.items.sort((left, right) => left.name.localeCompare(right.name));
    return listed;
  }

  async #aggregateResources(
    server: Server,
    entries: RegistryEntry[],
    context: ServerContext,
    params: unknown,
  ): Promise<AggregateList<Resource>> {
    const listed = await this.#aggregateList(
      entries.filter(({ snapshot }) => snapshot.capabilities.resources),
      context,
      async (entry) =>
        (await this.#listResources(server, entry, context, params)).map((resource) => ({
          ...resource,
          uri: virtualResourceUri(entry.server.slug, resource.uri),
        })),
    );
    listed.items.sort((left, right) => left.uri.localeCompare(right.uri));
    return listed;
  }

  async #aggregateResourceTemplates(
    server: Server,
    entries: RegistryEntry[],
    context: ServerContext,
    params: unknown,
  ): Promise<AggregateList<ResourceTemplateType>> {
    const listed = await this.#aggregateList(
      entries.filter(({ snapshot }) => snapshot.capabilities.resources),
      context,
      async (entry) =>
        (await this.#listResourceTemplates(server, entry, context, params)).map((template) => ({
          ...template,
          uriTemplate: virtualResourceTemplate(entry.server.slug, template.uriTemplate),
        })),
    );
    listed.items.sort((left, right) => left.uriTemplate.localeCompare(right.uriTemplate));
    return listed;
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
          candidate.name === name || aggregateToolName(entry.server.slug, candidate.name) === name,
      );
      if (tool && this.#projections.isVisible(entry.server.id, tool.name)) {
        return { entry, originalName: tool.name };
      }
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    const slug = splitAggregateToolName(name);
    if (slug) {
      const entry = this.#registry.entryBySlug(slug);
      const tool = (await this.#listTools(server, entry, context, {})).find(
        (candidate) => aggregateToolName(entry.server.slug, candidate.name) === name,
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
              candidate.name === name &&
              this.#projections.isVisible(entry.server.id, candidate.name),
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
    let offset = 0;
    if (cursor !== undefined) {
      try {
        offset = this.#cursors.decode(cursor, key).offset;
      } catch (error) {
        if (error instanceof AppError) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
        }
        throw error;
      }
    }
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
