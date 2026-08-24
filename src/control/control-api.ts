import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { Logger } from '../observability/logger.js';
import type { AuthService } from '../security/auth-service.js';
import { bearerToken } from '../security/auth-service.js';
import { ControlSessionService, cookieValue } from '../security/control-session.js';
import type { Store } from '../storage/store.js';
import type { ControlService } from './control-service.js';
import type { MarketService } from '../market/market-service.js';
import type { CliService } from '../cli-plane/cli-service.js';
import { controlOpenApi } from './openapi.js';

const keyInputSchema = z.object({ name: z.string().min(1).max(120) });
const controlKeyInputSchema = z.object({
  name: z.string().min(1).max(120),
  scope: z.enum(['admin', 'agent']).optional(),
});

interface HonoLike {
  use(
    path: string,
    handler: (context: HonoContext, next: () => Promise<void>) => Promise<Response | void>,
  ): void;
  get(path: string, handler: (context: HonoContext) => Response | Promise<Response>): void;
  post(path: string, handler: (context: HonoContext) => Response | Promise<Response>): void;
  patch(path: string, handler: (context: HonoContext) => Response | Promise<Response>): void;
  delete(path: string, handler: (context: HonoContext) => Response | Promise<Response>): void;
}

interface HonoContext {
  req: {
    raw: Request;
    path: string;
    param(name: string): string;
    query(name: string): string | undefined;
    json(): Promise<unknown>;
  };
  set(key: string, value: unknown): void;
  get<T>(key: string): T | undefined;
}

export function mountControlApi(
  app: HonoLike,
  options: {
    service: ControlService;
    auth: AuthService;
    sessions: ControlSessionService;
    store: Store;
    publicUrl: URL;
    secureCookies: boolean;
    logger: Logger;
    market?: MarketService;
    cli?: CliService;
  },
): void {
  const route =
    (handler: (context: HonoContext) => unknown | Promise<unknown>, status = 200) =>
    async (context: HonoContext): Promise<Response> => {
      try {
        return jsonResponse(await handler(context), status);
      } catch (error) {
        return errorResponse(error, options.logger);
      }
    };

  /** Reject agent-scoped control keys; the principal is set by the auth middleware. */
  const requireAdmin = (context: HonoContext): void => {
    const principal = context.get<{ scope: string | null }>('principal');
    if (principal?.scope !== 'admin') {
      throw new AppError('forbidden', 'This operation requires an admin control key', 403);
    }
  };
  const adminRoute =
    (handler: (context: HonoContext) => unknown | Promise<unknown>, status = 200) =>
    async (context: HonoContext): Promise<Response> => {
      try {
        requireAdmin(context);
        return jsonResponse(await handler(context), status);
      } catch (error) {
        return errorResponse(error, options.logger);
      }
    };

  app.post(
    '/api/v1/session',
    route(async (context) => {
      const principal = options.auth.authenticateBearer('control', context.req.raw);
      const token = await options.sessions.issue(principal);
      return responseWithCookie(
        { authenticated: true, principal: { id: principal.id, name: principal.name } },
        token,
        options.secureCookies,
      );
    }),
  );

  app.use('/api/v1/*', async (context, next) => {
    if (
      context.req.path === '/api/v1/session' &&
      (context.req.raw.method === 'POST' || context.req.raw.method === 'DELETE')
    ) {
      await next();
      return;
    }
    try {
      const token = bearerToken(context.req.raw);
      if (token) {
        context.set('principal', options.auth.authenticate('control', token));
      } else {
        const session = cookieValue(context.req.raw, 'mcp_home_session');
        if (!session) throw new AppError('unauthorized', 'Control credential required', 401);
        const sessionPrincipal = await options.sessions.verify(session);
        const key = options.store.getApiKey(sessionPrincipal.id, 'control');
        if (!key || key.revokedAt !== null) {
          throw new AppError('unauthorized', 'Control session credential was revoked', 401);
        }
        context.set('principal', {
          id: key.id,
          kind: 'control' as const,
          name: key.name,
          scope: key.scope,
        });
      }
      await next();
    } catch (error) {
      return errorResponse(error, options.logger);
    }
  });

  app.delete(
    '/api/v1/session',
    () =>
      new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'set-cookie': 'mcp_home_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
        },
      }),
  );

  app.get(
    '/api/v1/openapi.json',
    route(() => controlOpenApi(options.publicUrl)),
  );
  app.get(
    '/api/v1/servers',
    route(() => options.service.listServers()),
  );
  app.post(
    '/api/v1/servers',
    route((context) => context.req.json().then((body) => options.service.createServer(body)), 201),
  );
  app.get(
    '/api/v1/servers/:id',
    route((context) => options.service.getServer(context.req.param('id'))),
  );
  app.patch(
    '/api/v1/servers/:id',
    route(async (context) =>
      options.service.updateServer(context.req.param('id'), await context.req.json()),
    ),
  );
  app.delete(
    '/api/v1/servers/:id',
    adminRoute(async (context) => {
      await options.service.deleteServer(context.req.param('id'));
      return { deleted: true };
    }),
  );

  app.post(
    '/api/v1/servers/:id/test',
    route((context) => options.service.testServer(context.req.param('id'))),
  );
  app.post(
    '/api/v1/servers/:id/enable',
    route((context) => options.service.enableServer(context.req.param('id'))),
  );
  app.post(
    '/api/v1/servers/:id/disable',
    route((context) => options.service.disableServer(context.req.param('id'))),
  );
  app.post(
    '/api/v1/servers/:id/refresh',
    route((context) => options.service.refreshServer(context.req.param('id'))),
  );
  app.post(
    '/api/v1/servers/:id/restart',
    route((context) => options.service.restartServer(context.req.param('id'))),
  );
  app.get(
    '/api/v1/servers/:id/capabilities',
    route((context) => options.service.serverCapabilities(context.req.param('id'))),
  );
  app.get(
    '/api/v1/servers/:id/status',
    route((context) => options.service.serverStatus(context.req.param('id'))),
  );
  app.get(
    '/api/v1/servers/:id/logs',
    route((context) =>
      options.service.serverLogs(
        context.req.param('id'),
        numberQuery(context.req.query('limit'), 100),
      ),
    ),
  );
  app.get(
    '/api/v1/servers/:id/endpoint',
    route((context) => options.service.serverEndpoint(context.req.param('id'))),
  );
  app.get(
    '/api/v1/servers/:id/projection',
    route((context) => options.service.getProjection(context.req.param('id'))),
  );
  app.patch(
    '/api/v1/servers/:id/projection',
    route(async (context) =>
      options.service.setProjection(context.req.param('id'), await context.req.json()),
    ),
  );

  // ── CLI registry (Form A CLI plane) ────────────────────────────────────
  app.get('/api/v1/clis', route(() => options.cli?.list() ?? []));
  app.post(
    '/api/v1/clis',
    adminRoute(async (context) => {
      if (!options.cli) throw new AppError('cli_plane_disabled', 'CLI plane is not configured', 503);
      return options.cli.create(await context.req.json());
    }, 201),
  );
  app.get(
    '/api/v1/clis/:id',
    route((context) => {
      if (!options.cli) throw new AppError('cli_plane_disabled', 'CLI plane is not configured', 503);
      return options.cli.get(context.req.param('id'));
    }),
  );
  app.patch(
    '/api/v1/clis/:id',
    adminRoute(async (context) => {
      if (!options.cli) throw new AppError('cli_plane_disabled', 'CLI plane is not configured', 503);
      return options.cli.update(context.req.param('id'), await context.req.json());
    }),
  );
  app.delete(
    '/api/v1/clis/:id',
    adminRoute(async (context) => {
      if (!options.cli) throw new AppError('cli_plane_disabled', 'CLI plane is not configured', 503);
      await options.cli.delete(context.req.param('id'));
      return { deleted: true };
    }),
  );

  app.get(
    '/api/v1/credentials',
    adminRoute(() => options.service.listCredentials()),
  );
  app.post(
    '/api/v1/credentials',
    adminRoute(async (context) => options.service.createCredential(await context.req.json()), 201),
  );
  app.get(
    '/api/v1/credentials/:id',
    adminRoute((context) => options.service.getCredential(context.req.param('id'))),
  );
  app.patch(
    '/api/v1/credentials/:id',
    adminRoute(async (context) =>
      options.service.updateCredential(context.req.param('id'), await context.req.json()),
    ),
  );
  app.delete(
    '/api/v1/credentials/:id',
    adminRoute(async (context) => {
      await options.service.deleteCredential(context.req.param('id'));
      return { deleted: true };
    }),
  );
  app.post(
    '/api/v1/credentials/:id/test',
    adminRoute((context) => options.service.testCredential(context.req.param('id'))),
  );
  app.post(
    '/api/v1/credentials/:id/authorize',
    adminRoute(async (context) =>
      options.service.authorizeCredential(
        context.req.param('id'),
        await readOptionalJson(context.req.raw),
      ),
    ),
  );
  app.post(
    '/api/v1/credentials/:id/revoke',
    adminRoute((context) => options.service.revokeCredential(context.req.param('id'))),
  );

  mountKeyRoutes(app, adminRoute, options.service, 'control');
  mountKeyRoutes(app, adminRoute, options.service, 'access');

  app.get(
    '/api/v1/overview',
    route(() => options.service.overview()),
  );
  app.get(
    '/api/v1/events',
    route((context) =>
      options.store.listEvents({ limit: numberQuery(context.req.query('limit'), 100) }),
    ),
  );
  app.get(
    '/api/v1/calls',
    route((context) => options.service.listCalls(queryObject(context))),
  );
  app.get(
    '/api/v1/calls/stats',
    route((context) => options.service.callStats(queryObject(context))),
  );
  app.get(
    '/api/v1/calls/series',
    route((context) => options.service.callSeries(queryObject(context))),
  );
  app.get(
    '/api/v1/diagnostics',
    route(() => options.service.diagnostics()),
  );
  app.get(
    '/api/v1/config/export',
    route((context) => {
      const includeSecrets = booleanQuery(context.req.query('includeSecrets'), false);
      if (includeSecrets) requireAdmin(context);
      return options.service.exportConfig(includeSecrets);
    }),
  );
  app.post(
    '/api/v1/config/import-harness',
    adminRoute(async (context) => {
      const body = (await context.req.json()) as {
        config?: unknown;
        preview?: boolean;
        mode?: 'create' | 'upsert';
      };
      if (body.config === undefined) {
        throw new AppError('invalid_input', 'Missing "config" (the mcpServers object)', 400);
      }
      return options.service.importHarnessConfig(
        body.config,
        body.preview === true,
        body.mode === 'upsert' ? 'upsert' : 'create',
      );
    }),
  );
  app.post(
    '/api/v1/config/import',
    adminRoute(async (context) => options.service.importConfig(await context.req.json())),
  );
  app.get(
    '/api/v1/endpoints/aggregate',
    route(() => options.service.aggregateEndpoint()),
  );

  const market = options.market;
  if (market) {
    app.get('/api/v1/market', route(() => market.list()));
    app.get('/api/v1/market/installations', route(() => market.installations()));
    app.get('/api/v1/market/updates', route(() => market.updates()));
    app.get(
      '/api/v1/market/install/:jobId',
      route((context) => market.getJob(context.req.param('jobId'))),
    );
    app.post('/api/v1/market/:id/update', route((context) => market.update(context.req.param('id'))));
    app.post(
      '/api/v1/market/:id/install',
      route(async (context) => {
        const body = (await context.req.json()) as { values?: Record<string, string> };
        const principal = context.get<{ id: string }>('principal');
        return market.install(context.req.param('id'), body.values ?? {}, principal?.id ?? 'cli');
      }),
    );
    app.post(
      '/api/v1/market/:id/uninstall',
      adminRoute(async (context) => {
        await market.uninstall(context.req.param('id'));
        return { uninstalled: true };
      }),
    );
  }

  app.get(
    '/api/v1/secure-actions/:id',
    route(async (context) => {
      if (!options.market) {
        throw new AppError('secure_action_unavailable', 'Secure actions are unavailable', 404);
      }
      const principal = context.get<{ id: string }>('principal');
      if (!principal) throw new AppError('unauthorized', 'Control credential required', 401);
      return options.market.secureActionInfo(context.req.param('id'), principal.id);
    }),
  );
  app.post(
    '/api/v1/secure-actions/:id/complete',
    route(async (context) => {
      if (!options.market) {
        throw new AppError('secure_action_unavailable', 'Secure actions are unavailable', 404);
      }
      const principal = context.get<{ id: string }>('principal');
      if (!principal) throw new AppError('unauthorized', 'Control credential required', 401);
      const body = (await context.req.json()) as {
        token: string;
        values: Record<string, string>;
      };
      return options.market.completeAction(
        context.req.param('id'),
        body.token,
        principal.id,
        body.values ?? {},
      );
    }),
  );
}

function mountKeyRoutes(
  app: HonoLike,
  adminRoute: (
    handler: (context: HonoContext) => unknown | Promise<unknown>,
    status?: number,
  ) => (context: HonoContext) => Promise<Response>,
  service: ControlService,
  kind: 'control' | 'access',
): void {
  const path = kind === 'control' ? 'control-keys' : 'access-keys';
  app.get(
    `/api/v1/${path}`,
    adminRoute(() => service.listKeys(kind)),
  );
  app.post(
    `/api/v1/${path}`,
    adminRoute(async (context) => {
      if (kind === 'control') {
        const input = controlKeyInputSchema.parse(await context.req.json());
        return service.createKey(kind, input.name, input.scope ?? 'admin');
      }
      const input = keyInputSchema.parse(await context.req.json());
      return service.createKey(kind, input.name);
    }, 201),
  );
  app.delete(
    `/api/v1/${path}/:id`,
    adminRoute((context) => {
      service.revokeKey(kind, context.req.param('id'));
      return { revoked: true };
    }),
  );
}

function responseWithCookie(value: unknown, token: string, secure: boolean): Response {
  const attributes = ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=28800'];
  if (secure) attributes.push('Secure');
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'set-cookie': `mcp_home_session=${encodeURIComponent(token)}; ${attributes.join('; ')}`,
    },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  if (value instanceof Response) return value;
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function errorResponse(error: unknown, logger: Logger): Response {
  const appError =
    error instanceof AppError
      ? error
      : error instanceof z.ZodError
        ? new AppError('validation_error', 'Request validation failed', 400, {
            issues: error.issues,
          })
        : new AppError('internal_error', 'Internal server error', 500);
  if (appError.status >= 500) {
    logger.error('Control API error', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return new Response(
    JSON.stringify({
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.detail === undefined ? {} : { detail: appError.detail }),
      },
    }),
    {
      status: appError.status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...(appError.status === 401
          ? { 'www-authenticate': 'Bearer realm="toolhome-control"' }
          : {}),
      },
    },
  );
}

function numberQuery(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanQuery(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return z.enum(['true', 'false']).parse(value) === 'true';
}

function queryObject(context: HonoContext): Record<string, string> {
  return Object.fromEntries(new URL(context.req.raw.url).searchParams.entries());
}

async function readOptionalJson(request: Request): Promise<unknown> {
  const text = await request.text();
  return text.trim() === '' ? {} : JSON.parse(text);
}
