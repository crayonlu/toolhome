import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, postNdjson } from '../api/client'
import type {
  ApiKeyRecord,
  AuthorizeResult,
  CallStats,
  CallSeries,
  CapabilitySnapshot,
  CliRecord,
  CliStatus,
  CredentialRecord,
  CredentialTestResult,
  Diagnostics,
  EventRecord,
  EventLevel,
  MarketEntry,
  Overview,
  OverrideVisibility,
  ServerLogEntry,
  ServerProjection,
  ServerRecord,
  ServerWithRuntime,
  ToolCallRecord,
  Visibility,
} from '../api/types'

export function useOverview() {
  return useQuery({ queryKey: ['overview'], queryFn: () => api.get<Overview>('/api/v1/overview') })
}

// ── CLI plane ─────────────────────────────────────────────────────────────

export function useClis() {
  return useQuery({
    queryKey: ['clis'],
    queryFn: () => api.get<CliRecord[]>('/api/v1/clis'),
    refetchInterval: 8000,
  })
}

export function useCreateCli() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: unknown) => api.post<CliRecord>('/api/v1/clis', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['clis'] })
    },
  })
}

export function useUpdateCli() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: unknown }) =>
      api.patch<CliRecord>(`/api/v1/clis/${id}`, input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['clis'] })
    },
  })
}

export function useDeleteCli() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.delete(`/api/v1/clis/${id}`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['clis'] })
    },
  })
}

export function useCliExec() {
  return useMutation({
    mutationFn: ({ slug, input }: { slug: string; input: unknown }) =>
      postNdjson(`/cli/${slug}/exec`, input),
  })
}

export function useCliStatus(slug: string | undefined) {
  return useQuery({
    queryKey: ['cli-status', slug],
    queryFn: () => api.get<CliStatus>(`/cli/${slug}/status`),
    enabled: Boolean(slug),
  })
}

export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: () => api.get<ServerWithRuntime[]>('/api/v1/servers'),
    refetchInterval: 8000,
  })
}

export function useServer(id: string) {
  return useQuery({
    queryKey: ['servers', id],
    queryFn: () => api.get<ServerWithRuntime>(`/api/v1/servers/${id}`),
    enabled: Boolean(id),
    refetchInterval: 8000,
  })
}

export function useCredentials() {
  return useQuery({
    queryKey: ['credentials'],
    queryFn: () => api.get<CredentialRecord[]>('/api/v1/credentials'),
    refetchInterval: 8000,
  })
}

export function useCredential(id: string) {
  return useQuery({
    queryKey: ['credentials', id],
    queryFn: () => api.get<CredentialRecord>(`/api/v1/credentials/${id}`),
    enabled: Boolean(id),
  })
}

export function useAccessKeys() {
  return useQuery({
    queryKey: ['access-keys'],
    queryFn: () => api.get<ApiKeyRecord[]>('/api/v1/access-keys'),
  })
}

export function useControlKeys() {
  return useQuery({
    queryKey: ['control-keys'],
    queryFn: () => api.get<ApiKeyRecord[]>('/api/v1/control-keys'),
  })
}

export function useDiagnostics() {
  return useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => api.get<Diagnostics>('/api/v1/diagnostics'),
    refetchInterval: 10000,
  })
}

export function useEvents(limit = 100, level?: EventLevel) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (level) params.set('level', level)
  return useQuery({
    queryKey: ['events', limit, level],
    queryFn: () => api.get<EventRecord[]>(`/api/v1/events?${params}`),
    refetchInterval: 8000,
  })
}

export function useServerCapabilities(id: string) {
  return useQuery({
    queryKey: ['servers', id, 'capabilities'],
    queryFn: () => api.get<CapabilitySnapshot>(`/api/v1/servers/${id}/capabilities`),
    enabled: Boolean(id),
  })
}

export function useServerLogs(id: string) {
  return useQuery({
    queryKey: ['servers', id, 'logs'],
    queryFn: () => api.get<ServerLogEntry[]>(`/api/v1/servers/${id}/logs`),
    enabled: Boolean(id),
    refetchInterval: 8000,
  })
}

export function useCreateServer() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: unknown) => api.post<ServerRecord>('/api/v1/servers', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['servers'] })
      client.invalidateQueries({ queryKey: ['overview'] })
    },
  })
}

export function useUpdateServer() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: unknown }) =>
      api.patch<ServerRecord>(`/api/v1/servers/${id}`, input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['servers'] })
      client.invalidateQueries({ queryKey: ['overview'] })
    },
  })
}

export function useDeleteServer() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.delete(`/api/v1/servers/${id}`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['servers'] })
      client.invalidateQueries({ queryKey: ['overview'] })
    },
  })
}

export function useServerAction() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'enable' | 'disable' | 'refresh' | 'restart' }) =>
      api.post(`/api/v1/servers/${id}/${action}`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['servers'] })
    },
  })
}

export function useCreateCredential() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: unknown) => api.post<CredentialRecord>('/api/v1/credentials', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['credentials'] })
      client.invalidateQueries({ queryKey: ['overview'] })
    },
  })
}

export function useUpdateCredential() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: unknown }) =>
      api.patch<CredentialRecord>(`/api/v1/credentials/${id}`, input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['credentials'] })
    },
  })
}

export function useDeleteCredential() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.delete(`/api/v1/credentials/${id}`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['credentials'] })
      client.invalidateQueries({ queryKey: ['overview'] })
    },
  })
}

export function useTestCredential() {
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.post<CredentialTestResult>(`/api/v1/credentials/${id}/test`),
  })
}

export function useAuthorizeCredential() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      api.post<AuthorizeResult>(`/api/v1/credentials/${id}/authorize`, { force: force ?? false }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['credentials'] })
    },
  })
}

export function useRevokeCredential() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/credentials/${id}/revoke`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['credentials'] })
    },
  })
}

export function useCreateAccessKey() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.post<ApiKeyRecord & { secret?: string }>('/api/v1/access-keys', { name }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['access-keys'] })
    },
  })
}

export function useRevokeAccessKey() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.delete(`/api/v1/access-keys/${id}`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['access-keys'] })
    },
  })
}

export function useCreateControlKey() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; scope?: 'admin' | 'agent' }) =>
      api.post<ApiKeyRecord & { secret?: string }>('/api/v1/control-keys', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['control-keys'] })
    },
  })
}

export function useRevokeControlKey() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.delete(`/api/v1/control-keys/${id}`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['control-keys'] })
    },
  })
}

export function useMarket() {
  return useQuery({
    queryKey: ['market'],
    queryFn: () => api.get<MarketEntry[]>('/api/v1/market'),
  })
}

export function useMarketInstall() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: Record<string, string> }) =>
      api.post(`/api/v1/market/${id}/install`, { values }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['market'] })
      client.invalidateQueries({ queryKey: ['servers'] })
      client.invalidateQueries({ queryKey: ['overview'] })
    },
  })
}

export function useMarketUninstall() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.post(`/api/v1/market/${id}/uninstall`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['market'] })
      client.invalidateQueries({ queryKey: ['servers'] })
      client.invalidateQueries({ queryKey: ['overview'] })
    },
  })
}

export function useMarketUpdate() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.post(`/api/v1/market/${id}/update`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['market'] })
      client.invalidateQueries({ queryKey: ['servers'] })
    },
  })
}

export function useServerProjection(id: string) {
  return useQuery({
    queryKey: ['servers', id, 'projection'],
    queryFn: () => api.get<ServerProjection>(`/api/v1/servers/${id}/projection`),
    enabled: Boolean(id),
  })
}

export function useSetProjection(id: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { defaultVisibility?: Visibility; overrides?: { tool: string; visibility: OverrideVisibility }[] }) =>
      api.patch<ServerProjection>(`/api/v1/servers/${id}/projection`, input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['servers', id, 'projection'] })
    },
  })
}

export function useCalls(filter: Record<string, string | undefined>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') query.set(key, value)
  }
  const queryString = query.toString()
  return useQuery({
    queryKey: ['calls', queryString],
    queryFn: () =>
      api.get<{ items: ToolCallRecord[]; total: number }>(`/api/v1/calls?${queryString}`),
    refetchInterval: 8000,
  })
}

export function useCallStats(filter: Record<string, string | undefined>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') query.set(key, value)
  }
  const queryString = query.toString()
  return useQuery({
    queryKey: ['calls-stats', queryString],
    queryFn: () => api.get<CallStats>(`/api/v1/calls/stats?${queryString}`),
    refetchInterval: 8000,
  })
}

export function useCallSeries(
  filter: Record<string, string | undefined>,
  bucket: string,
) {
  const query = new URLSearchParams({ bucket })
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') query.set(key, value)
  }
  const queryString = query.toString()
  return useQuery({
    queryKey: ['calls-series', queryString],
    queryFn: () => api.get<CallSeries>(`/api/v1/calls/series?${queryString}`),
    refetchInterval: 8000,
  })
}
