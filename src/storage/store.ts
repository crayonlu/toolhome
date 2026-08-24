import type {
  ApiKeyKind,
  ApiKeyRecord,
  CapabilitySnapshot,
  ControlScope,
  CreateCredentialInput,
  CreateServerInput,
  CredentialPayload,
  CredentialRecord,
  EventRecord,
  InstallJobRecord,
  MarketInstallation,
  RuntimeState,
  SecureActionRecord,
  ServerProjection,
  ServerRecord,
  ToolCallDraft,
  ToolCallFilter,
  ToolCallRecord,
  ToolCallSeriesBucket,
  ToolCallSeriesQuery,
  ToolCallStats,
  ToolProjection,
  UpdateCredentialInput,
  UpdateServerInput,
  Visibility,
} from '../domain/models.js';
import type { CliRecord, CreateCliInput, UpdateCliInput } from '../cli-plane/models.js';

export interface CreateKeyInput {
  kind: ApiKeyKind;
  name: string;
  prefix: string;
  digest: string;
  scope?: ControlScope | null;
}

export interface StoredApiKey extends ApiKeyRecord {
  digest: string;
}

/** Compact per-server projection view for the data-plane hot path. */
export interface ProjectionIndexEntry {
  defaultVisibility: Visibility;
  overrides: Map<string, Visibility>;
}
export type ProjectionIndex = Map<string, ProjectionIndexEntry>;

export interface Store {
  close(): void;
  transaction<T>(operation: () => T): T;
  listServers(): ServerRecord[];
  getServer(id: string): ServerRecord | null;
  getServerBySlug(slug: string): ServerRecord | null;
  createServer(input: CreateServerInput): ServerRecord;
  updateServer(id: string, input: UpdateServerInput): ServerRecord;
  deleteServer(id: string): void;

  // ── CLI registry (Form A CLI plane) ─────────────────────────────────────
  listClis(): CliRecord[];
  getCli(id: string): CliRecord | null;
  getCliBySlug(slug: string): CliRecord | null;
  createCli(input: CreateCliInput): CliRecord;
  updateCli(id: string, input: UpdateCliInput): CliRecord;
  deleteCli(id: string): void;
  listCredentials(): CredentialRecord[];
  getCredential(id: string): CredentialRecord | null;
  getCredentialPayload(id: string): CredentialPayload | null;
  createCredential(input: CreateCredentialInput): CredentialRecord;
  updateCredential(id: string, input: UpdateCredentialInput): CredentialRecord;
  deleteCredential(id: string): void;
  listApiKeys(kind: ApiKeyKind): ApiKeyRecord[];
  createApiKey(input: CreateKeyInput): ApiKeyRecord;
  getApiKey(id: string, kind: ApiKeyKind): ApiKeyRecord | null;
  getApiKeyByDigest(kind: ApiKeyKind, digest: string): StoredApiKey | null;
  revokeApiKey(id: string, kind: ApiKeyKind): void;
  touchApiKey(id: string): void;
  getSnapshot(serverId: string): CapabilitySnapshot | null;
  saveSnapshot(snapshot: CapabilitySnapshot): CapabilitySnapshot;
  deleteSnapshot(serverId: string): void;
  getRuntimeState(serverId: string): RuntimeState | null;
  saveRuntimeState(state: RuntimeState): RuntimeState;
  appendEvent(event: Omit<EventRecord, 'id' | 'createdAt'>): EventRecord;
  listEvents(options?: { serverId?: string; limit?: number }): EventRecord[];

  // ── Tool visibility projection ──────────────────────────────────────────
  getServerProjection(serverId: string): ServerProjection | null;
  setServerProjection(serverId: string, defaultVisibility: Visibility): ServerProjection;
  listToolProjections(serverId?: string): ToolProjection[];
  setToolProjection(
    serverId: string,
    toolName: string,
    visibility: ToolProjection['visibility'],
  ): void;
  getProjectionIndex(): ProjectionIndex;

  // ── Tool call observability ─────────────────────────────────────────────
  insertToolCalls(calls: ToolCallDraft[]): number;
  listToolCalls(filter: ToolCallFilter): ToolCallRecord[];
  countToolCalls(filter: ToolCallFilter): number;
  toolCallStats(filter: Omit<ToolCallFilter, 'limit' | 'offset'>): ToolCallStats;
  toolCallSeries(query: ToolCallSeriesQuery): ToolCallSeriesBucket[];
  deleteOldToolCalls(before: string): number;

  // ── Market install records & persistent jobs ───────────────────────────
  listInstallations(): MarketInstallation[];
  getInstallation(entryId: string): MarketInstallation | null;
  createInstallation(input: Omit<MarketInstallation, 'id' | 'installedAt'>): MarketInstallation;
  updateInstallation(
    id: string,
    patch: Partial<Pick<MarketInstallation, 'entryVersion' | 'recipeRevision'>>,
  ): MarketInstallation;
  deleteInstallation(id: string): void;
  createInstallJob(
    input: Omit<InstallJobRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): InstallJobRecord;
  getInstallJob(id: string): InstallJobRecord | null;
  updateInstallJob(id: string, patch: Partial<InstallJobRecord>): InstallJobRecord;
  markInterruptedInstallJobs(): number;

  // ── Secure actions (URL-mode secret elicitation) ───────────────────────
  createSecureAction(input: Omit<SecureActionRecord, 'id' | 'createdAt'>): SecureActionRecord;
  getSecureAction(id: string): SecureActionRecord | null;
  updateSecureAction(id: string, patch: Partial<SecureActionRecord>): SecureActionRecord;
}
