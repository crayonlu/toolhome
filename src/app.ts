import { loadConfig, type RuntimeConfig } from './config.js';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountControlApi } from './control/control-api.js';
import { ControlService } from './control/control-service.js';
import { DataPlane } from './data-plane/data-plane.js';
import { GatewayServerFactory } from './data-plane/gateway-server.js';
import { CapabilityRegistry } from './data-plane/registry.js';
import { ToolProjectionService } from './data-plane/projection.js';
import { ManagementMCP } from './manage/management-mcp.js';
import { createLogger, type Logger } from './observability/logger.js';
import { CallRecorder } from './observability/call-recorder.js';
import { MarketService } from './market/market-service.js';
import { ApiKeyHasher } from './security/api-keys.js';
import { AuthService } from './security/auth-service.js';
import { ControlSessionService } from './security/control-session.js';
import { CursorCodec } from './security/cursor-codec.js';
import { mountOAuthRoutes } from './security/oauth-routes.js';
import { OAuthServer } from './security/oauth-server.js';
import { SecretBox } from './security/secret-box.js';
import { SecureActionService } from './security/secure-action.js';
import { SqliteStore } from './storage/sqlite-store.js';
import type { Store } from './storage/store.js';
import { CredentialResolver } from './upstream/credential-resolver.js';
import { UpstreamManager } from './upstream/manager.js';
import { OAuthRefreshSweeper } from './upstream/oauth-refresh.js';
import { UpstreamOAuthService } from './upstream/oauth-service.js';
import { mountUpstreamOAuthRoutes } from './upstream/oauth-routes.js';

export interface ApplicationRuntime {
  app: ReturnType<DataPlane['createApp']>;
  config: RuntimeConfig;
  logger: Logger;
  store: Store;
  upstreams: UpstreamManager;
  dataPlane: DataPlane;
  close(): Promise<void>;
}

/** Version of this package, read from package.json so it can never drift. */
function packageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      return (
        JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as { version: string }
      ).version;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return '0.0.0';
      directory = parent;
    }
  }
}

export function createApplication(config: RuntimeConfig = loadConfig()): ApplicationRuntime {
  const logger = createLogger(config.logLevel);
  const secrets = new SecretBox(config.masterKey);
  const store = new SqliteStore(config.databasePath, secrets);
  const hasher = new ApiKeyHasher(config.masterKey);
  const auth = new AuthService(store, hasher);
  auth.ensureBootstrapControlKey(config.bootstrapControlKey);
  const oauth = new OAuthServer(config.publicUrl, config.masterKey, auth);
  const sessions = new ControlSessionService(config.masterKey);
  const credentials = new CredentialResolver(store, config.publicUrl, config.oauthUrlClientId);
  const upstreams = new UpstreamManager(store, credentials, logger);
  const upstreamOAuth = new UpstreamOAuthService(
    store,
    config.publicUrl,
    upstreams,
    logger,
    config.oauthUrlClientId,
  );
  const registry = new CapabilityRegistry(store);
  const cursors = new CursorCodec(config.masterKey);
  const projections = new ToolProjectionService(store);
  const callRecorder = new CallRecorder(store, logger, config.callsRetentionDays);
  const gatewayFactory = new GatewayServerFactory(
    registry,
    upstreams,
    cursors,
    config.masterKey,
    projections,
    callRecorder,
  );
  const dataPlane = new DataPlane(gatewayFactory, registry, upstreams, auth, oauth, store, logger);
  const app = dataPlane.createApp({
    host: config.host,
    allowedHosts: config.allowedHosts,
    secure: config.publicUrl.protocol === 'https:',
  });
  const control = new ControlService(
    store,
    upstreams,
    auth,
    config.publicUrl,
    (slug) => dataPlane.remove(slug),
    () => dataPlane.registryChanged(),
    upstreamOAuth,
  );
  const secureActions = new SecureActionService(store, config.masterKey, config.publicUrl);
  const market = new MarketService(
    control,
    store,
    secureActions,
    config.marketDir,
    config.dataDir,
    config.uvIndexUrl,
  );
  mountControlApi(app, {
    service: control,
    auth,
    sessions,
    store,
    publicUrl: config.publicUrl,
    secureCookies: config.publicUrl.protocol === 'https:',
    logger,
    market,
  });
  const management = new ManagementMCP({
    service: control,
    market,
    store,
    auth,
    recorder: callRecorder,
    publicUrl: config.publicUrl,
  });
  app.all('/manage/mcp', (context) => management.serve(context.req.raw));
  mountOAuthRoutes(app, {
    oauth,
    registry,
    logger,
  });
  mountUpstreamOAuthRoutes(app, { oauth: upstreamOAuth, logger });

  app.get('/healthz', (context) => context.json({ status: 'ok' }));
  app.get('/readyz', (context) => {
    if (control.diagnostics().ok) return context.json({ status: 'ready' });
    return context.json({ status: 'degraded' }, 503);
  });

  if (config.webDir) {
    app.get('/assets/*', serveStatic({ root: config.webDir }));
    app.get('*', async (context, next) => {
      const path = context.req.path;
      if (
        path.startsWith('/api') ||
        path.startsWith('/mcp') ||
        path.startsWith('/manage') ||
        path.startsWith('/oauth') ||
        path === '/healthz' ||
        path === '/readyz'
      ) {
        return next();
      }
      const accept = context.req.header('Accept') ?? '';
      if (!accept.includes('text/html')) {
        return serveStatic({ root: config.webDir })(context, next);
      }
      return serveStatic({ path: 'index.html', root: config.webDir })(context, next);
    });
  } else {
    app.get('/', (context) =>
      context.json({
        name: 'ToolHome',
        version: packageVersion(),
        message: 'ToolHome is running. Manage it with the toolhome CLI.',
        endpoints: { mcp: '/mcp', controlApi: '/api/v1', openapi: '/api/v1/openapi.json' },
      }),
    );
  }

  for (const server of store.listServers().filter((item) => item.enabled)) {
    if (store.getSnapshot(server.id)) continue;
    void upstreams.refresh(server.id).catch((error) => {
      logger.warn('Initial server refresh failed', {
        serverId: server.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  const oauthSweeper = new OAuthRefreshSweeper(store, upstreamOAuth, logger);
  oauthSweeper.start(config.oauthRefreshIntervalSeconds);

  return {
    app,
    config,
    logger,
    store,
    upstreams,
    dataPlane,
    async close() {
      await oauthSweeper.stop();
      await management.close();
      await dataPlane.close();
      await upstreams.close();
      await callRecorder.close();
      store.close();
    },
  };
}
