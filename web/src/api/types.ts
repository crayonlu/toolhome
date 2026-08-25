export type ServerKind = 'remote' | 'home';
export type Transport =
  { type: 'streamable-http'; url: string } | { type: 'stdio'; command: string; args?: string[] };

// ── CLI plane (Form A) ────────────────────────────────────────────────────

export type CliExecutionMode = 'host' | 'docker';

export interface CliAllowList {
  allow: string[][];
  deny: string[][];
}

export interface CliProbe {
  command: string;
  args: string[];
}

export interface CliRecord {
  id: string;
  slug: string;
  name: string;
  command: string;
  executionMode: CliExecutionMode;
  entrypoint: string | null;
  allowList: CliAllowList;
  interactive: boolean;
  credentialId: string | null;
  probe: CliProbe | null;
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface CliStatus {
  installed: boolean | null;
  version: string | null;
  loggedIn: boolean;
  lastCheckedAt: string;
}

export interface ServerSettings {
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  maxTotalTimeoutMs: number;
  maxConcurrency: number;
  restart: 'on-failure' | 'always' | 'never';
  urlClientId?: boolean;
}

export interface ServerRecord {
  id: string;
  slug: string;
  name: string;
  kind: ServerKind;
  transport: Transport;
  credentialId: string | null;
  enabled: boolean;
  settings: ServerSettings;
  createdAt: string;
  updatedAt: string;
}

export type RuntimeStatus =
  | 'ready'
  | 'connecting'
  | 'disabled'
  | 'unknown'
  | 'unreachable'
  | 'auth-required'
  | 'error'
  | 'stopping';

export interface RuntimeState {
  status: RuntimeStatus;
  lastError: string | null;
  lastSuccessAt: string | null;
  updatedAt: string;
  protocolVersion?: string;
  protocolEra?: string;
  serverInfo?: { name?: string; version?: string };
}

export type ServerWithRuntime = ServerRecord & { runtime: RuntimeState | null };

export type CredentialType = 'bearer' | 'api-key' | 'headers' | 'env' | 'oauth';
export type CredentialStatus = 'ready' | 'pending' | 'expired' | 'invalid';

export interface CredentialRecord {
  id: string;
  name: string;
  type: CredentialType;
  status: CredentialStatus;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  kind: 'control' | 'access';
  name: string;
  prefix: string;
  scope: 'admin' | 'agent' | null;
  createdAt: string;
}

export interface Overview {
  servers: {
    total: number;
    enabled: number;
    remote: number;
    home: number;
    ready: number;
    unhealthy: number;
  };
  clis: {
    total: number;
    enabled: number;
  };
  credentials: number;
  accessKeys: number;
  controlKeys: number;
  endpoints: {
    aggregate: string;
    individual: Record<string, string>;
  };
  ok: boolean;
}

export interface DiagnosticServer {
  slug: string;
  status: RuntimeStatus;
  hasSnapshot: boolean;
  lastError?: string | null;
}

export interface DiagnosticCli {
  id: string;
  slug: string;
  enabled: boolean;
  status: 'configured' | 'disabled';
}

export interface Diagnostics {
  ok: boolean;
  servers: DiagnosticServer[];
  clis: DiagnosticCli[];
}

export type EventLevel = 'info' | 'warn' | 'error';

export interface EventRecord {
  id: string;
  level: EventLevel;
  type: string;
  message: string;
  detail: Record<string, unknown>;
  createdAt: string;
  serverId: string | null;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface PromptInfo {
  name: string;
  description?: string;
}

export interface ResourceInfo {
  uri: string;
  name?: string;
}

export interface CapabilitySnapshot {
  serverId: string;
  version: number;
  protocolVersion: string;
  protocolEra: 'modern' | 'legacy';
  serverInfo: { name?: string; version?: string } | null;
  capabilities: {
    tools?: { listChanged?: boolean };
    prompts?: { listChanged?: boolean };
    resources?: { listChanged?: boolean; subscribe?: boolean };
    completions?: unknown;
    logging?: unknown;
  };
  instructions: string | null;
  tools: ToolInfo[];
  prompts: PromptInfo[];
  resources: ResourceInfo[];
  resourceTemplates: unknown[];
  updatedAt: string;
}

export interface ServerLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface AuthorizeResult {
  status: 'authorized' | 'authorization-required';
  authorizationUrl?: string;
  callbackUrl?: string;
  credential?: CredentialRecord;
}

export interface CredentialTestResult {
  valid: boolean;
  requiresAuthorization?: boolean;
  verifiedAgainstUpstream?: boolean;
  servers: { id: string; slug: string; ok: boolean; error?: string }[];
  error?: string;
}

export interface MarketRequirement {
  name: string;
  description: string;
  secret?: boolean;
  required?: boolean;
}

export type CredentialSpec =
  | { type: 'oauth' }
  | { type: 'env' }
  | { type: 'bearer'; tokenKey: string }
  | { type: 'api-key'; headerName: string; valueKey: string }
  | { type: 'headers'; headers: { name: string; valueKey?: string; value?: string }[] };

export interface MarketEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  plane: 'mcp' | 'cli';
  kind: 'home-stdio' | 'remote' | 'uvx' | 'docker' | 'cli-binary' | 'cli-image';
  package?: string;
  bin?: string;
  image?: string;
  url?: string;
  credential: CredentialSpec;
  requires: MarketRequirement[];
  argsTemplate?: string[];
  installed: boolean;
  installedVersion: string | null;
  updateAvailable: boolean;
}

export type Visibility = 'visible' | 'hidden';
export type OverrideVisibility = 'inherit' | 'visible' | 'hidden';

export interface ServerProjection {
  serverId: string;
  defaultVisibility: Visibility;
  overrides: Record<string, OverrideVisibility>;
  tools: { name: string; description: string; visible: boolean }[];
}

export type ToolCallStatus =
  'success' | 'tool_error' | 'protocol_error' | 'timeout' | 'cancelled' | 'rejected';

export interface ToolCallRecord {
  id: string;
  endpointType: 'aggregate' | 'individual' | 'management' | 'cli';
  principalKind: 'access_key' | 'control_key' | 'oauth_client' | 'cli';
  principalId: string;
  serverId: string | null;
  exposedToolName: string;
  upstreamToolName: string;
  status: ToolCallStatus;
  errorType: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface CallStats {
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

export interface CallSeriesPoint {
  bucket: string;
  total: number;
  success: number;
  error: number;
}

export interface CallSeries {
  bucketSeconds: number;
  points: CallSeriesPoint[];
}
