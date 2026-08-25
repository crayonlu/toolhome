import { Activity } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCallSeries, useCallStats, useCalls, useServers } from '../../app/queries';
import { useI18n } from '../../i18n';
import { Badge, EmptyState } from '../../components/ui/Badge';
import { SelectField, type SelectOption } from '../../components/ui/SelectField';
import { CallChart } from '../../components/ui/CallChart';
import type { ToolCallStatus } from '../../api/types';

const statusOptions: SelectOption[] = [
  { value: '', label: 'all' },
  { value: 'success', label: 'success' },
  { value: 'tool_error', label: 'tool error' },
  { value: 'protocol_error', label: 'protocol error' },
  { value: 'timeout', label: 'timeout' },
  { value: 'cancelled', label: 'cancelled' },
  { value: 'rejected', label: 'rejected' },
];

const timeOptions: SelectOption[] = [
  { value: '86400000', label: '24h' },
  { value: '604800000', label: '7d' },
  { value: '2592000000', label: '30d' },
  { value: '', label: 'all' },
];

const statusTone: Record<ToolCallStatus, 'success' | 'danger' | 'warning' | 'neutral'> = {
  success: 'success',
  tool_error: 'warning',
  protocol_error: 'danger',
  timeout: 'danger',
  cancelled: 'neutral',
  rejected: 'neutral',
};

function summaryCard(label: string, value: string, sub?: string) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="text-xs text-ink-3">{label}</div>
      <div className="font-mono text-lg text-ink">{value}</div>
      {sub !== undefined && <div className="text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

export function CallsPage() {
  const { t, locale } = useI18n();
  const { data: servers } = useServers();
  const [serverId, setServerId] = useState('');
  const [endpointType, setEndpointType] = useState('');
  const [tool, setTool] = useState('');
  const [status, setStatus] = useState('');
  const [windowMs, setWindowMs] = useState('86400000');

  const serverOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: 'all' },
      ...(servers ?? []).map((server) => ({ value: server.id, label: server.slug })),
    ],
    [servers],
  );

  const from = useMemo(() => {
    if (!windowMs) return undefined;
    return new Date(Date.now() - Number(windowMs)).toISOString();
  }, [windowMs]);

  const filter = {
    server_id: serverId || undefined,
    tool: tool || undefined,
    status: status || undefined,
    endpoint_type: endpointType || undefined,
    from,
  };
  const calls = useCalls({ limit: '50', ...filter });
  const stats = useCallStats(filter);
  const bucket = windowMs === '604800000' ? '6h' : windowMs === '2592000000' ? '1d' : '1h';
  const series = useCallSeries(filter, bucket);

  const recent = calls.data?.items ?? [];
  const s = stats.data;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">{t('nav.calls')}</h1>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        {summaryCard(t('calls.total'), String(s?.total ?? '—'))}
        {summaryCard(
          t('calls.successRate'),
          s === undefined ? '—' : `${s.successRate}%`,
          `${s?.success ?? 0} / ${s?.error ?? 0}`,
        )}
        {summaryCard(t('calls.avgDuration'), s === undefined ? '—' : `${s.avgDurationMs}ms`)}
        {summaryCard(t('calls.p50'), s === undefined ? '—' : `${s.p50Ms}ms`)}
        {summaryCard(t('calls.p95'), s === undefined ? '—' : `${s.p95Ms}ms`)}
      </div>

      <div className="bg-surface px-4 py-3">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-ink">{t('calls.trend')}</span>
          <span className="flex items-center gap-3 font-mono text-[10px] text-ink-3">
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-2 bg-[var(--mch-accent)]" />
              {t('calls.calls')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-2 bg-[var(--mch-danger)]" />
              {t('calls.errors')}
            </span>
          </span>
        </div>
        <CallChart
          points={series.data?.points ?? []}
          bucketSeconds={series.data?.bucketSeconds ?? 3600}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <SelectField
          label={t('calls.server')}
          value={serverId}
          onChange={setServerId}
          options={serverOptions}
        />
        <SelectField
          label={t('calls.type')}
          value={endpointType}
          onChange={setEndpointType}
          options={[
            { value: '', label: 'all' },
            { value: 'aggregate', label: `MCP · ${t('calls.aggregate')}` },
            { value: 'individual', label: `MCP · ${t('calls.individual')}` },
            { value: 'management', label: 'MCP · management' },
            { value: 'cli', label: 'CLI exec' },
          ]}
        />
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink-2">{t('calls.tool')}</span>
          <input
            value={tool}
            onChange={(event) => setTool(event.target.value)}
            placeholder="fetch"
            className="h-9 bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-3 focus:ring-2 focus:ring-accent/50"
          />
        </label>
        <SelectField
          label={t('calls.status')}
          value={status}
          onChange={setStatus}
          options={statusOptions}
        />
        <SelectField
          label={t('calls.window')}
          value={windowMs}
          onChange={setWindowMs}
          options={timeOptions}
        />
      </div>

      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        <div className="bg-surface px-4 py-3">
          <div className="mb-2 text-sm font-medium text-ink">{t('calls.topTools')}</div>
          {(s?.topTools ?? []).length === 0 ? (
            <div className="text-xs text-ink-3">—</div>
          ) : (
            <div className="flex flex-col divide-y divide-ink-3/10">
              {s!.topTools.map((item) => (
                <div key={item.tool} className="flex items-center justify-between py-1.5">
                  <span className="truncate font-mono text-xs text-ink">{item.tool}</span>
                  <span className="font-mono text-xs text-ink-2">{item.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="bg-surface px-4 py-3">
          <div className="mb-2 text-sm font-medium text-ink">{t('calls.topFailing')}</div>
          {(s?.topFailing ?? []).length === 0 ? (
            <div className="text-xs text-ink-3">—</div>
          ) : (
            <div className="flex flex-col divide-y divide-ink-3/10">
              {s!.topFailing.map((item, index) => (
                <div key={index} className="flex items-center justify-between py-1.5">
                  <span className="truncate font-mono text-xs text-ink">
                    {item.tool}
                    <span className="ml-2 text-ink-3">{item.errorType ?? 'error'}</span>
                  </span>
                  <span className="font-mono text-xs text-ink-2">{item.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="mb-2 text-sm font-medium text-ink">{t('calls.recent')}</div>
        {recent.length === 0 ? (
          <EmptyState icon={<Activity className="size-8" />} title={t('calls.empty')} />
        ) : (
          <div className="flex flex-col divide-y divide-ink-3/10">
            {recent.map((call) => (
              <div key={call.id} className="flex min-h-[44px] items-center gap-3 px-1 py-1.5">
                <Badge tone={statusTone[call.status]}>{call.status}</Badge>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-[13px] text-ink">
                    {call.endpointType === 'cli' ? (
                      <span className="mr-2 text-ink-3">CLI</span>
                    ) : null}
                    {call.upstreamToolName}
                    {call.endpointType === 'aggregate' &&
                      call.exposedToolName !== call.upstreamToolName && (
                        <span className="ml-2 text-ink-3">{call.exposedToolName}</span>
                      )}
                  </span>
                  <span className="truncate text-xs text-ink-3">
                    {call.serverId
                      ? serverSlug(servers ?? [], call.serverId)
                      : call.endpointType === 'cli'
                        ? call.exposedToolName
                        : '—'}{' '}
                    · {new Date(call.startedAt).toLocaleString(locale)} · {call.durationMs}ms
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function serverSlug(servers: { id: string; slug: string }[], id: string): string {
  return servers.find((server) => server.id === id)?.slug ?? id.slice(0, 8);
}
