import { ClientCapabilitiesSchema } from '@modelcontextprotocol/core';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import {
  createMcpHandler,
  isLegacyRequest,
  type ClientCapabilities,
  type AuthInfo,
  type McpHttpHandler,
  type Server,
} from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import { AppError } from '../domain/errors.js';
import type { Logger } from '../observability/logger.js';
import { bearerToken, type AuthService } from '../security/auth-service.js';
import type { OAuthServer } from '../security/oauth-server.js';
import type { Store } from '../storage/store.js';
import type { UpstreamEvent } from '../upstream/adapter.js';
import type { UpstreamManager } from '../upstream/manager.js';
import type { GatewayServerFactory } from './gateway-server.js';
import { LegacySessionHandler } from './legacy-session.js';
import type { CapabilityRegistry } from './registry.js';
import { adaptModernTaskRequest, canonicalTaskMethod } from './task-extension.js';
import {
  expandVirtualResourceTemplate,
  parseVirtualResourceUri,
  virtualResourceUri,
} from './virtualization.js';

interface EndpointHandlers {
  modern: McpHttpHandler;
  legacy: LegacySessionHandler;
}

export class DataPlane {
  readonly #aggregate: EndpointHandlers;
  readonly #individual = new Map<string, EndpointHandlers>();
  readonly #unsubscribe: () => void;
  readonly #factory: GatewayServerFactory;
  readonly #registry: CapabilityRegistry;
  readonly #upstreams: UpstreamManager;
  readonly #auth: AuthService;
  readonly #oauth: OAuthServer;
  readonly #store: Store;
  readonly #logger: Logger;

  constructor(
    factory: GatewayServerFactory,
    registry: CapabilityRegistry,
    upstreams: UpstreamManager,
    auth: AuthService,
    oauth: OAuthServer,
    store: Store,
    logger: Logger,
  ) {
    this.#factory = factory;
    this.#registry = registry;
    this.#upstreams = upstreams;
    this.#auth = auth;
    this.#oauth = oauth;
    this.#store = store;
    this.#logger = logger;
    this.#aggregate = this.#createEndpoint(() => this.#factory.aggregate());
    this.#unsubscribe = this.#upstreams.subscribe((event) => this.#publish(event));
  }

  createApp(options: { host: string; allowedHosts: string[]; secure: boolean }) {
    const app = createMcpHonoApp({
      host: options.host,
      allowedHosts: options.allowedHosts,
    });
    app.use('*', async (context, next) => {
      await next();
      context.header('x-content-type-options', 'nosniff');
      context.header('x-frame-options', 'DENY');
      context.header('referrer-policy', 'no-referrer');
      context.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
      if (options.secure) {
        context.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
      }
      const contentType = context.res.headers.get('content-type') ?? '';
      if (
        contentType.includes('text/html') &&
        !context.res.headers.has('content-security-policy')
      ) {
        context.header(
          'content-security-policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
        );
      }
    });
    app.all('/mcp', (context: Context) => this.#serve(context, this.#aggregate, null));
    app.all('/mcp/:slug', (context: Context) => {
      const slug = context.req.param('slug');
      if (!slug) {
        return this.#httpError(
          context,
          new AppError('server_not_found', 'Server slug is required', 404),
        );
      }
      try {
        this.#registry.entryBySlug(slug);
      } catch (error) {
        return this.#httpError(context, error);
      }
      return this.#serve(context, this.#handlerFor(slug), slug);
    });
    return app;
  }

  async remove(slug: string): Promise<void> {
    const handler = this.#individual.get(slug);
    this.#individual.delete(slug);
    if (handler) await this.#closeEndpoint(handler);
    this.registryChanged();
  }

  registryChanged(): void {
    this.#aggregate.modern.notify.toolsChanged();
    this.#aggregate.modern.notify.promptsChanged();
    this.#aggregate.modern.notify.resourcesChanged();
    this.#aggregate.legacy.toolsChanged();
    this.#aggregate.legacy.promptsChanged();
    this.#aggregate.legacy.resourcesChanged();
  }

  async close(): Promise<void> {
    this.#unsubscribe();
    await Promise.allSettled([
      this.#closeEndpoint(this.#aggregate),
      ...[...this.#individual.values()].map((handler) => this.#closeEndpoint(handler)),
    ]);
    this.#individual.clear();
  }

  #handlerFor(slug: string): EndpointHandlers {
    const current = this.#individual.get(slug);
    if (current) return current;
    const handler = this.#createEndpoint(() => this.#factory.individual(slug));
    this.#individual.set(slug, handler);
    return handler;
  }

  #createEndpoint(factory: () => Server): EndpointHandlers {
    return {
      modern: createMcpHandler(factory, { legacy: 'reject' }),
      legacy: new LegacySessionHandler(factory, this.#logger),
    };
  }

  async #closeEndpoint(handler: EndpointHandlers): Promise<void> {
    await Promise.allSettled([handler.modern.close(), handler.legacy.close()]);
  }

  async #serve(
    context: Context,
    handler: EndpointHandlers,
    slug: string | null,
  ): Promise<Response> {
    try {
      const token = bearerToken(context.req.raw);
      if (!token) throw new AppError('unauthorized', 'Bearer credential required', 401);
      const resource = this.#oauth.mcpResource(slug);
      const authInfo = await this.#authenticate(token, resource);
      const parsedBody = await this.#parsedBody(context);
      const legacy = await isLegacyRequest(context.req.raw);
      if (!legacy) this.#validateTaskHeader(context.req.raw, parsedBody);
      const closeSubscriptions = legacy
        ? null
        : await this.#openResourceSubscriptions(parsedBody, slug);
      try {
        const response = legacy
          ? await handler.legacy.fetch(context.req.raw, { authInfo, parsedBody })
          : await this.#serveModern(handler.modern, context.req.raw, authInfo, parsedBody);
        return closeSubscriptions === null
          ? response
          : this.#closeWithResponse(response, closeSubscriptions, context.req.raw.signal);
      } catch (error) {
        await closeSubscriptions?.();
        throw error;
      }
    } catch (error) {
      this.#logger.warn('MCP request rejected', {
        endpoint: slug === null ? 'aggregate' : slug,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.#httpError(context, error, slug);
    }
  }

  async #serveModern(
    handler: McpHttpHandler,
    request: Request,
    authInfo: AuthInfo,
    parsedBody: unknown,
  ): Promise<Response> {
    const adapted = adaptModernTaskRequest(request, parsedBody);
    return handler.fetch(adapted.request, { authInfo, parsedBody: adapted.body });
  }

  #validateTaskHeader(request: Request, body: unknown): void {
    if (!isRecord(body) || typeof body.method !== 'string') return;
    if (!canonicalTaskMethod(body.method)) return;
    if (!isRecord(body.params) || typeof body.params.taskId !== 'string') {
      throw new AppError('invalid_task_request', 'Task ID is required', 400);
    }
    const encoded = request.headers.get('mcp-name');
    if (!encoded || decodeHeaderValue(encoded) !== body.params.taskId) {
      throw new AppError('invalid_task_header', 'Mcp-Name must match the task ID', 400);
    }
  }

  async #authenticate(token: string, resource: URL) {
    try {
      const principal = this.#auth.authenticate('access', token);
      return this.#auth.toMcpAuthInfo(principal, token, resource);
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 401) throw error;
      return this.#oauth.verifyAccessToken(token, resource);
    }
  }

  async #parsedBody(context: Context): Promise<unknown> {
    const parsed = context.get('parsedBody');
    if (parsed !== undefined) return parsed;
    const contentType = context.req.raw.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return undefined;
    return context.req.raw.clone().json();
  }

  async #openResourceSubscriptions(
    body: unknown,
    slug: string | null,
  ): Promise<(() => Promise<void>) | null> {
    if (!isRecord(body) || body.method !== 'subscriptions/listen') return null;
    if (!isRecord(body.params) || !isRecord(body.params.notifications)) return null;
    const requested = body.params.notifications.resourceSubscriptions;
    if (!Array.isArray(requested)) return null;
    const uris = requested.filter((value): value is string => typeof value === 'string');
    if (uris.length === 0) return null;
    const capabilities = clientCapabilities(body.params);
    const grouped = new Map<string, string[]>();
    if (slug === null) {
      for (const uri of uris) {
        const route = parseVirtualResourceUri(uri) ?? expandVirtualResourceTemplate(uri);
        if (!route) continue;
        const entry = this.#registry.entryBySlug(route.slug);
        const current = grouped.get(entry.server.id) ?? [];
        current.push(route.upstreamUri);
        grouped.set(entry.server.id, current);
      }
    } else {
      const entry = this.#registry.entryBySlug(slug);
      grouped.set(entry.server.id, uris);
    }
    const close = await Promise.all(
      [...grouped].map(([serverId, resourceUris]) =>
        this.#upstreams.subscribeResources(serverId, resourceUris, capabilities),
      ),
    );
    return async () => {
      await Promise.allSettled(close.map((release) => release()));
    };
  }

  #closeWithResponse(
    response: Response,
    close: () => Promise<void>,
    signal: AbortSignal,
  ): Response {
    const body = response.body;
    if (!body) {
      void close();
      return response;
    }
    const reader = body.getReader();
    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', onAbort);
      await close();
    };
    const onAbort = (): void => {
      void closeOnce();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            await closeOnce();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(error);
          await closeOnce();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await closeOnce();
        }
      },
    });
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  #httpError(_context: Context, error: unknown, slug: string | null = null): Response {
    const appError =
      error instanceof AppError
        ? error
        : new AppError('internal_error', 'Internal server error', 500);
    const headers =
      appError.status === 401
        ? {
            'WWW-Authenticate': `Bearer realm="toolhome", resource_metadata="${this.#oauth.resourceMetadataUrl(this.#oauth.mcpResource(slug))}", scope="mcp:use"`,
          }
        : undefined;
    return new Response(
      JSON.stringify({ error: { code: appError.code, message: appError.message } }),
      {
        status: appError.status,
        headers: {
          ...headers,
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=UTF-8',
        },
      },
    );
  }

  #publish(event: UpstreamEvent): void {
    const server = this.#store.getServer(event.serverId);
    if (!server) return;
    const individual = this.#individual.get(server.slug);
    switch (event.type) {
      case 'tools_changed':
        this.#aggregate.modern.notify.toolsChanged();
        this.#aggregate.legacy.toolsChanged();
        individual?.modern.notify.toolsChanged();
        individual?.legacy.toolsChanged();
        break;
      case 'prompts_changed':
        this.#aggregate.modern.notify.promptsChanged();
        this.#aggregate.legacy.promptsChanged();
        individual?.modern.notify.promptsChanged();
        individual?.legacy.promptsChanged();
        break;
      case 'resources_changed':
        this.#aggregate.modern.notify.resourcesChanged();
        this.#aggregate.legacy.resourcesChanged();
        individual?.modern.notify.resourcesChanged();
        individual?.legacy.resourcesChanged();
        break;
      case 'resource_updated':
        this.#aggregate.modern.notify.resourceUpdated(virtualResourceUri(server.slug, event.uri));
        this.#aggregate.legacy.resourceUpdated(virtualResourceUri(server.slug, event.uri));
        individual?.modern.notify.resourceUpdated(event.uri);
        individual?.legacy.resourceUpdated(event.uri);
        break;
    }
  }
}

function clientCapabilities(params: Record<string, unknown>): ClientCapabilities {
  if (!isRecord(params._meta)) return {};
  const parsed = ClientCapabilitiesSchema.safeParse(
    params._meta['io.modelcontextprotocol/clientCapabilities'],
  );
  return parsed.success ? parsed.data : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeHeaderValue(value: string): string {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  try {
    return Buffer.from(value.slice('=?base64?'.length, -2), 'base64').toString('utf8');
  } catch {
    return '';
  }
}
