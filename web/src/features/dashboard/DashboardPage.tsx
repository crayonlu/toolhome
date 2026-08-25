import { Activity, KeyRound, Link2, Server, SquareTerminal } from 'lucide-react';
import { Link } from 'react-router';
import { useOverview } from '../../app/queries';
import { useI18n } from '../../i18n';
import { usePlane } from '../../app/plane';
import { CopyButton } from '../../components/ui/CopyButton';
import { StatusDot } from '../../components/ui/Badge';

function StatCard({
  label,
  value,
  icon: Icon,
  to,
  tone,
}: {
  label: string;
  value: string | number;
  icon: typeof Server;
  to: string;
  tone?: 'success' | 'danger' | 'neutral';
}) {
  const toneDot = tone === 'success' ? 'bg-success' : tone === 'danger' ? 'bg-danger' : 'bg-ink-3';
  return (
    <Link
      to={to}
      className="group flex items-center gap-3 bg-surface px-4 py-3.5 transition-colors hover:bg-surface-2"
    >
      <Icon className="size-4 shrink-0 text-ink-3" />
      <div className="min-w-0 flex-1">
        <div className="text-xl font-semibold tracking-[-0.01em] tabular-nums">{value}</div>
        <div className="truncate text-[13px] text-ink-3">{label}</div>
      </div>
      <span className={`size-2 ${toneDot}`} />
    </Link>
  );
}

export function DashboardPage() {
  const { t } = useI18n();
  const { plane } = usePlane();
  const { data: overview, isLoading } = useOverview();

  if (isLoading || !overview) {
    return <div className="text-sm text-ink-3">{t('common.loading')}</div>;
  }

  const { servers, endpoints } = overview;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">{t('nav.overview')}</h1>
        <div className="mt-1.5 flex items-center gap-2 text-[13px] text-ink-3">
          <StatusDot tone={overview.ok ? 'success' : 'danger'} />
          {overview.ok ? t('common.operational') : t('common.degraded')}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {plane === 'mcp' ? (
          <>
            <StatCard
              label={t('nav.servers')}
              value={`${servers.ready}/${servers.total}`}
              icon={Server}
              to="/servers"
              tone={servers.unhealthy > 0 ? 'danger' : 'success'}
            />
            <StatCard
              label={t('nav.clis')}
              value={overview.clis.total}
              icon={SquareTerminal}
              to="/clis"
            />
          </>
        ) : (
          <>
            <StatCard
              label={t('nav.clis')}
              value={overview.clis.total}
              icon={SquareTerminal}
              to="/clis"
              tone={overview.clis.enabled === 0 ? 'neutral' : 'success'}
            />
            <StatCard
              label={t('nav.servers')}
              value={`${servers.ready}/${servers.total}`}
              icon={Server}
              to="/servers"
            />
          </>
        )}
        <StatCard
          label={t('nav.credentials')}
          value={overview.credentials}
          icon={KeyRound}
          to="/credentials"
        />
        <StatCard
          label={t('nav.accessKeys')}
          value={overview.accessKeys}
          icon={Link2}
          to="/access-keys"
        />
        <StatCard
          label={t('nav.diagnostics')}
          value={overview.ok ? t('common.operational') : t('common.degraded')}
          icon={Activity}
          to="/diagnostics"
          tone={overview.ok ? 'success' : 'danger'}
        />
      </div>

      <div className="flex flex-col gap-2 bg-surface px-4 py-4">
        <div className="text-[13px] font-medium text-ink-3">{t('dashboard.endpoint')}</div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-ink">
            {endpoints.aggregate}
          </code>
          <CopyButton text={endpoints.aggregate} />
        </div>
      </div>
    </div>
  );
}
