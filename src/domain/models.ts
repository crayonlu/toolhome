import type {
  Implementation,
  ListPromptsResult,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ListToolsResult,
  OAuthDiscoveryState,
  Prompt,
  Resource,
  ResourceTemplateType,
  ServerCapabilities,
  StoredOAuthClientInformation,
  Tool,
} from '@modelcontextprotocol/client';
import { z } from 'zod';

export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const protocolModeSchema = z.enum(['auto', 'legacy', 'modern']);

const httpUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    context.addIssue({ code: 'custom', message: 'URL must use HTTP or HTTPS' });
  }
});
const headerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
const headerValueSchema = z
  .string()
  .max(16_384)
  .refine((value) => !/[\0\r\n]/.test(value), 'Header value contains invalid characters');
const headersSchema = z
  .record(headerNameSchema, headerValueSchema)
  .refine((value) => Object.keys(value).length <= 128, 'Too many headers');

export const remoteTransportSchema = z.object({
  type: z.literal('streamable-http'),
  url: httpUrlSchema,
  protocolMode: protocolModeSchema.default('auto'),
  allowSseFallback: z.boolean().default(false),
  headers: headersSchema.default({}),
});

export const stdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).default({}),
  protocolMode: protocolModeSchema.default('auto'),
});

export const transportSchema = z.discriminatedUnion('type', [
  remoteTransportSchema,
  stdioTransportSchema,
]);

const serverSettingsObjectSchema = z.object({
  connectTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
  requestTimeoutMs: z.number().int().min(100).max(3_600_000).default(60_000),
  maxTotalTimeoutMs: z.number().int().min(100).max(86_400_000).default(600_000),
  maxConcurrency: z.number().int().min(1).max(32).default(1),
  restart: z.enum(['never', 'on-failure', 'always']).default('on-failure'),
  urlClientId: z.boolean().optional(),
});

export const serverSettingsSchema = serverSettingsObjectSchema.superRefine((value, context) => {
  if (value.requestTimeoutMs > value.maxTotalTimeoutMs) {
    context.addIssue({
      code: 'custom',
      path: ['requestTimeoutMs'],
      message: 'requestTimeoutMs cannot exceed maxTotalTimeoutMs',
    });
  }
});

export const serverRecordSchema = z.object({
  id: z.uuid(),
  slug: slugSchema,
  name: z.string().min(1).max(120),
  kind: z.enum(['remote', 'home']),
  transport: transportSchema,
  credentialId: z.uuid().nullable(),
  enabled: z.boolean(),
  settings: serverSettingsSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createServerInputObjectSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
  kind: z.enum(['remote', 'home']),
  transport: transportSchema,
  credentialId: z.uuid().nullable().default(null),
  enabled: z.boolean().default(true),
  settings: serverSettingsSchema.default({
    connectTimeoutMs: 15_000,
    requestTimeoutMs: 60_000,
    maxTotalTimeoutMs: 600_000,
    maxConcurrency: 1,
    restart: 'on-failure',
  }),
});

export const createServerInputSchema = createServerInputObjectSchema.superRefine(
  (value, context) => {
    const valid =
      (value.kind === 'remote' && value.transport.type === 'streamable-http') ||
      (value.kind === 'home' && value.transport.type === 'stdio');
    if (!valid) {
      context.addIssue({
        code: 'custom',
        path: ['transport'],
        message: 'Transport does not match server kind',
      });
    }
  },
);

export const updateServerInputSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  transport: transportSchema.optional(),
  credentialId: z.uuid().nullable().optional(),
  enabled: z.boolean().optional(),
  settings: serverSettingsObjectSchema.partial().optional(),
});

function isStoredOAuthClientInformation(value: unknown): value is StoredOAuthClientInformation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'client_id' in value &&
    typeof value.client_id === 'string'
  );
}

function isOAuthDiscoveryState(value: unknown): value is OAuthDiscoveryState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'authorizationServerUrl' in value &&
    typeof value.authorizationServerUrl === 'string'
  );
}

export const oauthCredentialPayloadSchema = z.object({
  type: z.literal('oauth'),
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  idToken: z.string().min(1).optional(),
  tokenType: z.string().default('Bearer'),
  expiresAt: z.iso.datetime().optional(),
  expiresIn: z.number().nonnegative().optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  issuer: z.string().min(1).optional(),
  resourceUrl: z.url().optional(),
  authorizationServerUrl: z.url().optional(),
  authorizationUrl: z.url().optional(),
  pendingExpiresAt: z.iso.datetime().optional(),
  state: z.string().min(1).optional(),
  codeVerifier: z.string().min(1).optional(),
  clientInformation: z
    .custom<StoredOAuthClientInformation>(isStoredOAuthClientInformation)
    .optional(),
  discoveryState: z.custom<OAuthDiscoveryState>(isOAuthDiscoveryState).optional(),
});

export const credentialPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer'), token: z.string().min(1) }),
  z.object({
    type: z.literal('api-key'),
    headerName: headerNameSchema,
    value: z.string().min(1),
  }),
  z.object({
    type: z.literal('headers'),
    headers: headersSchema,
  }),
  z.object({
    type: z.literal('env'),
    variables: z.record(z.string(), z.string()),
  }),
  oauthCredentialPayloadSchema,
]);

export const credentialTypeSchema = z.enum(['bearer', 'api-key', 'headers', 'env', 'oauth']);

export const credentialRecordSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(120),
  type: credentialTypeSchema,
  status: z.enum(['ready', 'expired', 'invalid', 'pending']),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createCredentialInputSchema = z.object({
  name: z.string().min(1).max(120),
  payload: credentialPayloadSchema,
});

export const updateCredentialInputSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  payload: credentialPayloadSchema.optional(),
});

export const apiKeyKindSchema = z.enum(['control', 'access']);

export const controlScopeSchema = z.enum(['admin', 'agent']);
export type ControlScope = z.infer<typeof controlScopeSchema>;

export const apiKeyRecordSchema = z.object({
  id: z.uuid(),
  kind: apiKeyKindSchema,
  name: z.string().min(1).max(120),
  prefix: z.string(),
  scope: controlScopeSchema.nullable().default(null),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

export const runtimeStatusSchema = z.enum([
  'disabled',
  'unknown',
  'connecting',
  'ready',
  'degraded',
  'unreachable',
  'auth-required',
  'start-failed',
]);

export const runtimeStateSchema = z.object({
  serverId: z.uuid(),
  status: runtimeStatusSchema,
  protocolVersion: z.string().nullable(),
  protocolEra: z.enum(['modern', 'legacy']).nullable(),
  processId: z.number().int().nullable(),
  restartCount: z.number().int().nonnegative(),
  lastSuccessAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export type ProtocolMode = z.infer<typeof protocolModeSchema>;
export type RemoteTransportConfig = z.infer<typeof remoteTransportSchema>;
export type StdioTransportConfig = z.infer<typeof stdioTransportSchema>;
export type TransportConfig = z.infer<typeof transportSchema>;
export type ServerSettings = z.infer<typeof serverSettingsSchema>;
export type ServerRecord = z.infer<typeof serverRecordSchema>;
export type CreateServerInput = z.infer<typeof createServerInputSchema>;
export type UpdateServerInput = z.infer<typeof updateServerInputSchema>;
export type CredentialPayload = z.infer<typeof credentialPayloadSchema>;
export type OAuthCredentialPayload = z.infer<typeof oauthCredentialPayloadSchema>;
export type CredentialRecord = z.infer<typeof credentialRecordSchema>;
export type CreateCredentialInput = z.infer<typeof createCredentialInputSchema>;
export type UpdateCredentialInput = z.infer<typeof updateCredentialInputSchema>;
export type ApiKeyKind = z.infer<typeof apiKeyKindSchema>;
export type ApiKeyRecord = z.infer<typeof apiKeyRecordSchema>;
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export interface CapabilitySnapshot {
  serverId: string;
  version: number;
  protocolVersion: string;
  protocolEra: 'modern' | 'legacy';
  serverInfo: Implementation | null;
  capabilities: ServerCapabilities;
  instructions: string | null;
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplateType[];
  prompts: Prompt[];
  listResults: {
    tools: ListToolsResult;
    resources: ListResourcesResult;
    resourceTemplates: ListResourceTemplatesResult;
    prompts: ListPromptsResult;
  };
  fingerprint: string;
  refreshedAt: string;
}

export interface EventRecord {
  id: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  type: string;
  serverId: string | null;
  message: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

// ── Tool visibility projection ────────────────────────────────────────────

export const visibilitySchema = z.enum(['visible', 'hidden']);
export type Visibility = z.infer<typeof visibilitySchema>;

export const overrideVisibilitySchema = z.enum(['inherit', 'visible', 'hidden']);
export type OverrideVisibility = z.infer<typeof overrideVisibilitySchema>;

export const serverProjectionSchema = z.object({
  serverId: z.string().uuid(),
  defaultVisibility: visibilitySchema.default('visible'),
  updatedAt: z.string(),
});
export type ServerProjection = z.infer<typeof serverProjectionSchema>;

export const toolProjectionSchema = z.object({
  serverId: z.string().uuid(),
  upstreamToolName: z.string(),
  visibility: overrideVisibilitySchema,
  updatedAt: z.string(),
});
export type ToolProjection = z.infer<typeof toolProjectionSchema>;

export const setProjectionInputSchema = z.object({
  defaultVisibility: visibilitySchema.optional(),
  overrides: z
    .array(
      z.object({
        tool: z.string().min(1),
        visibility: overrideVisibilitySchema,
      }),
    )
    .optional(),
});
export type SetProjectionInput = z.infer<typeof setProjectionInputSchema>;

// ── Tool call observability ───────────────────────────────────────────────

export const toolCallStatusSchema = z.enum([
  'success',
  'tool_error',
  'protocol_error',
  'timeout',
  'cancelled',
  'rejected',
]);
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>;

export const toolCallSchema = z.object({
  id: z.string().uuid(),
  endpointType: z.enum(['aggregate', 'individual', 'management', 'cli']),
  principalKind: z.enum(['access_key', 'control_key', 'oauth_client', 'cli']),
  principalId: z.string(),
  serverId: z.string().uuid().nullable(),
  exposedToolName: z.string(),
  upstreamToolName: z.string(),
  status: toolCallStatusSchema,
  errorType: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
});
export type ToolCallRecord = z.infer<typeof toolCallSchema>;

export type ToolCallDraft = Omit<ToolCallRecord, 'id'>;

export const toolCallFilterSchema = z.object({
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
  serverId: z.string().uuid().optional(),
  tool: z.string().optional(),
  endpointType: z.enum(['aggregate', 'individual', 'management', 'cli']).optional(),
  principalId: z.string().optional(),
  status: toolCallStatusSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type ToolCallFilter = z.infer<typeof toolCallFilterSchema>;

export interface ToolCallSeriesQuery {
  from?: string;
  to?: string;
  bucketSeconds: number;
  serverId?: string;
  tool?: string;
  endpointType?: 'aggregate' | 'individual' | 'management' | 'cli';
}

export interface ToolCallSeriesBucket {
  /** Bucket start as epoch seconds (UTC). */
  bucket: number;
  total: number;
  success: number;
}

const bucketUnits: Record<'s' | 'm' | 'h' | 'd', number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
};

/** Parses a human bucket like "30m", "1h", "6h", "1d"; defaults to 1h. */
export function parseBucketSeconds(value: string | undefined): number {
  const match = /^(\d+)([smhd])$/.exec(value ?? '');
  if (!match) return 3600;
  return Number(match[1]) * bucketUnits[match[2] as keyof typeof bucketUnits];
}

export interface ToolCallStats {
  total: number;
  byStatus: Partial<Record<ToolCallStatus, number>>;
  success: number;
  error: number;
  successRate: number;
  avgDurationMs: number;
  p50Ms: number;
  p95Ms: number;
  topTools: { tool: string; count: number }[];
  topFailing: { tool: string; errorType: string | null; count: number }[];
}

// ── Market install records & persistent jobs ──────────────────────────────

export const installJobStatusSchema = z.enum([
  'awaiting_secret',
  'installing',
  'updating',
  'completed',
  'failed',
  'interrupted',
]);
export type InstallJobStatus = z.infer<typeof installJobStatusSchema>;

export const installJobRecordSchema = z.object({
  id: z.uuid(),
  entryId: z.string().min(1),
  requestedVersion: z.string().nullable(),
  idempotencyKey: z.string().min(1),
  status: installJobStatusSchema,
  step: z.string(),
  boundedOutput: z.string(),
  resultReference: z.string().nullable(),
  actionId: z.uuid().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type InstallJobRecord = z.infer<typeof installJobRecordSchema>;

export const marketInstallationSchema = z.object({
  id: z.uuid(),
  source: z.enum(['curated', 'registry']),
  entryId: z.string().min(1),
  entryVersion: z.string(),
  recipeRevision: z.string(),
  targetType: z.enum(['server', 'cli']),
  targetId: z.uuid(),
  credentialId: z.uuid().nullable(),
  installedAt: z.iso.datetime(),
});
export type MarketInstallation = z.infer<typeof marketInstallationSchema>;

// ── Secure actions (URL-mode secret elicitation) ──────────────────────────

export const secureActionStatusSchema = z.enum(['pending', 'completed', 'expired']);
export type SecureActionStatus = z.infer<typeof secureActionStatusSchema>;

export const secureActionRecordSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['market_install']),
  target: z.string().min(1),
  principalId: z.string().min(1),
  status: secureActionStatusSchema,
  valuesJson: z.string().default('{}'),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type SecureActionRecord = z.infer<typeof secureActionRecordSchema>;
