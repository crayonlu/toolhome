import { chmodSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';

const publicUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    context.addIssue({ code: 'custom', message: 'Public URL must use HTTP or HTTPS' });
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    context.addIssue({
      code: 'custom',
      message: 'Public URL must be an origin without a path, query, or fragment',
    });
  }
  if (url.username !== '' || url.password !== '') {
    context.addIssue({ code: 'custom', message: 'Public URL must not contain credentials' });
  }
});

const envSchema = z
  .object({
    TOOLHOME_HOST: z.string().default('127.0.0.1'),
    TOOLHOME_PORT: z.coerce.number().int().min(1).max(65_535).default(3344),
    TOOLHOME_PUBLIC_URL: publicUrlSchema.default('http://127.0.0.1:3344'),
    TOOLHOME_DATA_DIR: z.string().default('./data'),
    TOOLHOME_MASTER_KEY: z.string().min(32),
    TOOLHOME_BOOTSTRAP_CONTROL_KEY: z.string().min(32).optional(),
    TOOLHOME_ALLOWED_HOSTS: z.string().optional(),
    TOOLHOME_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    TOOLHOME_OAUTH_URL_CLIENT_ID: z.enum(['true', 'false']).default('true'),
    TOOLHOME_WEB_DIR: z.string().optional(),
    TOOLHOME_MARKET_DIR: z.string().optional(),
    TOOLHOME_UV_INDEX_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.url().optional(),
    ),
    TOOLHOME_CALLS_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
    TOOLHOME_OAUTH_REFRESH_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(300),
  })
  .superRefine((value, context) => {
    if (value.TOOLHOME_BOOTSTRAP_CONTROL_KEY === value.TOOLHOME_MASTER_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['TOOLHOME_BOOTSTRAP_CONTROL_KEY'],
        message: 'Bootstrap Control Key must differ from the master key',
      });
    }
  });

export interface RuntimeConfig {
  host: string;
  port: number;
  publicUrl: URL;
  dataDir: string;
  databasePath: string;
  masterKey: string;
  bootstrapControlKey?: string;
  allowedHosts: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  oauthUrlClientId: boolean;
  webDir?: string;
  marketDir: string;
  uvIndexUrl?: string;
  callsRetentionDays: number;
  /** Seconds between automatic sweeps that refresh expiring OAuth credentials. */
  oauthRefreshIntervalSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = envSchema.parse(env);
  const dataDir = resolve(parsed.TOOLHOME_DATA_DIR);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const bootstrap = parsed.TOOLHOME_BOOTSTRAP_CONTROL_KEY;
  const publicUrl = new URL(parsed.TOOLHOME_PUBLIC_URL);
  const configuredHosts =
    parsed.TOOLHOME_ALLOWED_HOSTS?.split(',')
      .map((host) => host.trim())
      .filter(Boolean) ?? [];
  return {
    host: parsed.TOOLHOME_HOST,
    port: parsed.TOOLHOME_PORT,
    publicUrl,
    dataDir,
    databasePath: resolve(dataDir, 'toolhome.sqlite'),
    masterKey: parsed.TOOLHOME_MASTER_KEY,
    ...(bootstrap === undefined ? {} : { bootstrapControlKey: bootstrap }),
    allowedHosts: configuredHosts.length === 0 ? [publicUrl.hostname] : configuredHosts,
    logLevel: parsed.TOOLHOME_LOG_LEVEL,
    oauthUrlClientId: parsed.TOOLHOME_OAUTH_URL_CLIENT_ID === 'true',
    ...(parsed.TOOLHOME_WEB_DIR === undefined ? {} : { webDir: resolve(parsed.TOOLHOME_WEB_DIR) }),
    marketDir: resolve(parsed.TOOLHOME_MARKET_DIR ?? join(dataDir, 'market')),
    ...(parsed.TOOLHOME_UV_INDEX_URL === undefined
      ? {}
      : { uvIndexUrl: parsed.TOOLHOME_UV_INDEX_URL.toString() }),
    callsRetentionDays: parsed.TOOLHOME_CALLS_RETENTION_DAYS,
    oauthRefreshIntervalSeconds: parsed.TOOLHOME_OAUTH_REFRESH_INTERVAL_SECONDS,
  };
}
