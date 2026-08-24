import { CallToolRequestParamsSchema } from '@modelcontextprotocol/core';
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  createMcpHandler,
  type McpHttpHandler,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { ToolCallDraft } from '../domain/models.js';
import type { AuthService } from '../security/auth-service.js';
import { bearerToken } from '../security/auth-service.js';
import type { Store } from '../storage/store.js';
import type { ControlService } from '../control/control-service.js';
import type { MarketService } from '../market/market-service.js';
import type { CallRecorder } from '../observability/call-recorder.js';

const serverIdSchema = z.object({ server_id: z.uuid() });
const enableSchema = serverIdSchema.extend({ enabled: z.boolean() });
const marketInstallSchema = z.object({
  entry_id: z.string().min(1),
  values: z.record(z.string(), z.string()).optional().default({}),
});
const visibilitySchema = z.object({
  server_id: z.uuid(),
  tool: z.string().min(1),
  visibility: z.enum(['inherit', 'visible', 'hidden']),
});
const searchSchema = z.object({ query: z.string().optional() });
const callsSchema = z.object({
  limit: z.number().int().min(1).max(500).optional().default(50),
  server_id: z.uuid().optional(),
  status: z.string().optional(),
});

interface ManagementOptions {
  service: ControlService;
  market: MarketService;
  store: Store;
  auth: AuthService;
  recorder: CallRecorder;
  publicUrl: URL;
}

function ok(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: { ok: true, ...value },
  };
}

function fail(error: unknown) {
  const appError = error instanceof AppError ? error : null;
  const message = error instanceof Error ? error.message : String(error);
  const code = appError?.code ?? 'internal_error';
  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { ok: false, error: code, message },
  };
}

/**
 * The Management MCP is the control plane's MCP surface. It reuses the shared
 * domain services directly (never internal HTTP) and is served at /manage/mcp,
 * outside the /mcp aggregate. Only control keys are accepted; the aggregate
 * endpoint never contains these tools.
 */
export class ManagementMCP {
  readonly #service: ControlService;
  readonly #market: MarketService;
  readonly #store: Store;
  readonly #auth: AuthService;
  readonly #recorder: CallRecorder;
  readonly #publicUrl: URL;
  readonly #handler: McpHttpHandler;
  readonly #server: Server;

  constructor(options: ManagementOptions) {
    this.#service = options.service;
    this.#market = options.market;
    this.#store = options.store;
    this.#auth = options.auth;
    this.#recorder = options.recorder;
    this.#publicUrl = options.publicUrl;
    this.#server = this.#createServer();
    this.#handler = createMcpHandler(() => this.#server, { legacy: 'reject' });
  }

  async serve(request: Request): Promise<Response> {
    const token = bearerToken(request);
    if (!token) {
      return jsonResponse({ error: { code: 'unauthorized', message: 'Control credential required' } }, 401);
    }
    let principal;
    try {
      principal = this.#auth.authenticate('control', token);
    } catch {
      // Both invalid credentials and MCP access keys land here: access keys
      // must never reach the management surface.
      return jsonResponse({ error: { code: 'unauthorized', message: 'Control credential required' } }, 401);
    }
    const contentType = request.headers.get('content-type') ?? '';
    let parsedBody: unknown;
    if (contentType.includes('application/json')) {
      parsedBody = await request.clone().json();
    }
    const authInfo = this.#auth.toMcpAuthInfo(
      principal,
      token,
      new URL('/manage/mcp', this.#publicUrl),
    );
    return this.#handler.fetch(request, { authInfo, parsedBody });
  }

  async close(): Promise<void> {
    await this.#handler.close();
  }

  #createServer(): Server {
    const server = new Server(
      { name: 'toolhome-management', version: '0.1.0', title: 'ToolHome Management' },
      {
        capabilities: { tools: {} },
        instructions:
          'Manage a ToolHome instance: inspect servers, search the market, read tool visibility and call history, and run reversible operations (enable/disable/refresh/restart, market install, tool visibility). Secrets are never accepted through tool arguments — installs that need them return a one-time action URL to complete in the web console.',
      },
    );
    server.setRequestHandler('tools/list', async () => ({ tools: this.#tools() }));
    server.setRequestHandler(
      'tools/call',
      { params: CallToolRequestParamsSchema, result: z.any() },
      async (request, context) => this.#dispatch(request.name, request.arguments ?? {}, context),
    );
    return server;
  }

  #tools(): Tool[] {
    return [
      {
        name: 'home_status',
        description: 'Instance, server, credential and health summary plus management endpoint',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'server_list',
        description: 'List servers with runtime status',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'server_get',
        description: 'Get a single server, runtime status, tool count and last error',
        inputSchema: {
          type: 'object',
          properties: { server_id: { type: 'string' } },
          required: ['server_id'],
        },
      },
      {
        name: 'market_search',
        description: 'Search the curated market catalog with install state',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
      {
        name: 'tool_list',
        description: 'List a server\'s tools with effective aggregate visibility',
        inputSchema: {
          type: 'object',
          properties: { server_id: { type: 'string' } },
          required: ['server_id'],
        },
      },
      {
        name: 'calls_query',
        description: 'Query metadata-only tool call records',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'integer' },
            server_id: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
      {
        name: 'server_set_enabled',
        description: 'Enable or disable a server (idempotent)',
        inputSchema: {
          type: 'object',
          properties: { server_id: { type: 'string' }, enabled: { type: 'boolean' } },
          required: ['server_id', 'enabled'],
        },
      },
      {
        name: 'server_refresh',
        description: 'Re-discover a server\'s capabilities',
        inputSchema: {
          type: 'object',
          properties: { server_id: { type: 'string' } },
          required: ['server_id'],
        },
      },
      {
        name: 'server_restart',
        description: 'Restart a home-hosted server or reconnect a remote one',
        inputSchema: {
          type: 'object',
          properties: { server_id: { type: 'string' } },
          required: ['server_id'],
        },
      },
      {
        name: 'market_install',
        description: 'Install a curated market entry; returns a one-time action URL when a secret is required',
        inputSchema: {
          type: 'object',
          properties: {
            entry_id: { type: 'string' },
            values: { type: 'object', additionalProperties: { type: 'string' } },
          },
          required: ['entry_id'],
        },
      },
      {
        name: 'tool_set_visibility',
        description: 'Set a tool\'s aggregate visibility (inherit/visible/hidden)',
        inputSchema: {
          type: 'object',
          properties: {
            server_id: { type: 'string' },
            tool: { type: 'string' },
            visibility: { type: 'string', enum: ['inherit', 'visible', 'hidden'] },
          },
          required: ['server_id', 'tool', 'visibility'],
        },
      },
    ];
  }

  async #dispatch(name: string, arguments_: Record<string, unknown>, context: ServerContext) {
    switch (name) {
      case 'home_status':
        return this.#homeStatus();
      case 'server_list':
        return this.#serverList();
      case 'server_get':
        return this.#serverGet(serverIdSchema.parse(arguments_));
      case 'market_search':
        return this.#marketSearch(searchSchema.parse(arguments_));
      case 'tool_list':
        return this.#toolList(serverIdSchema.parse(arguments_));
      case 'calls_query':
        return this.#calls(callsSchema.parse(arguments_));
      case 'server_set_enabled':
        return this.#serverSetEnabled(enableSchema.parse(arguments_), context);
      case 'server_refresh':
        return this.#serverRefresh(serverIdSchema.parse(arguments_), context);
      case 'server_restart':
        return this.#serverRestart(serverIdSchema.parse(arguments_), context);
      case 'market_install':
        return this.#marketInstall(marketInstallSchema.parse(arguments_), context);
      case 'tool_set_visibility':
        return this.#toolSetVisibility(visibilitySchema.parse(arguments_), context);
      default:
        throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  }

  #homeStatus() {
    try {
      const overview = this.#service.overview();
      return ok({
        overview,
        managementEndpoint: new URL('/manage/mcp', this.#publicUrl).toString(),
      });
    } catch (error) {
      return fail(error);
    }
  }

  #serverList() {
    try {
      const servers = this.#service.listServers().map((server) => ({
        id: server.id,
        slug: server.slug,
        name: server.name,
        kind: server.kind,
        enabled: server.enabled,
        status: server.runtime?.status ?? 'unknown',
        lastError: server.runtime?.lastError ?? null,
      }));
      return ok({ servers });
    } catch (error) {
      return fail(error);
    }
  }

  #serverGet({ server_id }: { server_id: string }) {
    try {
      const server = this.#service.getServer(server_id);
      const snapshot = this.#store.getSnapshot(server_id);
      return ok({
        server: {
          id: server.id,
          slug: server.slug,
          name: server.name,
          kind: server.kind,
          enabled: server.enabled,
          status: server.runtime?.status ?? 'unknown',
          lastError: server.runtime?.lastError ?? null,
          toolCount: snapshot?.tools.length ?? 0,
        },
      });
    } catch (error) {
      return fail(error);
    }
  }

  #marketSearch({ query }: { query?: string }) {
    try {
      const needle = query?.trim().toLowerCase() ?? '';
      const entries = this.#market
        .list()
        .filter(
          (entry) =>
            needle === '' ||
            entry.name.toLowerCase().includes(needle) ||
            entry.id.includes(needle) ||
            entry.category.includes(needle),
        )
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          category: entry.category,
          kind: entry.kind,
          installed: entry.installed,
          version: entry.version ?? null,
          requiresSecrets: entry.requires.some((requirement) => requirement.secret),
        }));
      return ok({ entries });
    } catch (error) {
      return fail(error);
    }
  }

  #toolList({ server_id }: { server_id: string }) {
    try {
      const projection = this.#service.getProjection(server_id);
      return ok({ tools: projection.tools });
    } catch (error) {
      return fail(error);
    }
  }

  #calls(params: { limit: number; server_id?: string; status?: string }) {
    try {
      const result = this.#store.listToolCalls({
        limit: params.limit,
        offset: 0,
        serverId: params.server_id,
        status: params.status as never,
      });
      return ok({ calls: result });
    } catch (error) {
      return fail(error);
    }
  }

  async #serverSetEnabled(params: { server_id: string; enabled: boolean }, context: ServerContext) {
    const startedAt = new Date();
    try {
      const server = this.#service.getServer(params.server_id);
      const result =
        server.enabled === params.enabled
          ? { id: server.id, enabled: server.enabled, unchanged: true }
          : params.enabled
            ? await this.#service.enableServer(params.server_id)
            : await this.#service.disableServer(params.server_id);
      this.#record(context, 'server_set_enabled', params.server_id, startedAt, true);
      return ok({ serverId: params.server_id, enabled: params.enabled, result });
    } catch (error) {
      this.#record(context, 'server_set_enabled', params.server_id, startedAt, false, error);
      return fail(error);
    }
  }

  async #serverRefresh(params: { server_id: string }, context: ServerContext) {
    const startedAt = new Date();
    try {
      await this.#service.refreshServer(params.server_id);
      this.#record(context, 'server_refresh', params.server_id, startedAt, true);
      return ok({ serverId: params.server_id, refreshed: true });
    } catch (error) {
      this.#record(context, 'server_refresh', params.server_id, startedAt, false, error);
      return fail(error);
    }
  }

  async #serverRestart(params: { server_id: string }, context: ServerContext) {
    const startedAt = new Date();
    try {
      await this.#service.restartServer(params.server_id);
      this.#record(context, 'server_restart', params.server_id, startedAt, true);
      return ok({ serverId: params.server_id, restarted: true });
    } catch (error) {
      this.#record(context, 'server_restart', params.server_id, startedAt, false, error);
      return fail(error);
    }
  }

  async #marketInstall(
    params: { entry_id: string; values: Record<string, string> },
    context: ServerContext,
  ) {
    const startedAt = new Date();
    const principalId = context.http?.authInfo?.clientId ?? 'anonymous';
    try {
      const result = await this.#market.install(params.entry_id, params.values, principalId);
      this.#record(context, 'market_install', null, startedAt, true);
      return ok({ jobId: result.jobId, status: result.status, actionUrl: result.actionUrl });
    } catch (error) {
      this.#record(context, 'market_install', null, startedAt, false, error);
      return fail(error);
    }
  }

  async #toolSetVisibility(
    params: { server_id: string; tool: string; visibility: 'inherit' | 'visible' | 'hidden' },
    context: ServerContext,
  ) {
    const startedAt = new Date();
    try {
      const current = this.#service.getProjection(params.server_id);
      const effective = params.visibility === 'inherit'
        ? null
        : params.visibility;
      const override = current.overrides[params.tool] ?? null;
      const unchanged = override === effective;
      if (!unchanged) {
        this.#service.setProjection(params.server_id, {
          overrides: [{ tool: params.tool, visibility: params.visibility }],
        });
      }
      this.#record(context, 'tool_set_visibility', params.server_id, startedAt, true);
      return ok({
        serverId: params.server_id,
        tool: params.tool,
        visibility: params.visibility,
        unchanged,
      });
    } catch (error) {
      this.#record(context, 'tool_set_visibility', params.server_id, startedAt, false, error);
      return fail(error);
    }
  }

  #record(
    context: ServerContext,
    toolName: string,
    serverId: string | null,
    startedAt: Date,
    success: boolean,
    error?: unknown,
  ) {
    const completedAt = new Date();
    const draft: ToolCallDraft = {
      endpointType: 'management',
      principalKind: 'control_key',
      principalId: context.http?.authInfo?.clientId ?? 'anonymous',
      serverId,
      exposedToolName: toolName,
      upstreamToolName: toolName,
      status: success ? 'success' : 'protocol_error',
      errorType: success ? null : (error instanceof AppError ? error.code : 'management_error'),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    };
    this.#recorder.record(draft);
  }
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
