import { Boxes, Plug, RefreshCw, SquareTerminal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMarket, useMarketUninstall } from '../../app/queries';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useToast } from '../../components/ui/Toast';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { Badge, EmptyState, StatusDot } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { TabsView } from '../../components/ui/Tabs';
import { InstallSheet } from './InstallSheet';
import { isInstallSuccessful, type InstallStatus } from './install-job';
import type { MarketEntry } from '../../api/types';

const categoryLabel: Record<string, string> = {
  devtools: 'devtools',
  productivity: 'productivity',
  comms: 'comms',
  finance: 'finance',
  design: 'design',
  infra: 'infra',
  data: 'data',
  search: 'search',
  email: 'email',
  ai: 'ai',
  browser: 'browser',
};

export function MarketPage() {
  const { t } = useI18n();
  const { toast } = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data: entries, isLoading, refetch } = useMarket();
  const uninstall = useMarketUninstall();
  const [plane, setPlane] = useState<'mcp' | 'cli'>('mcp');
  const [installTarget, setInstallTarget] = useState<MarketEntry | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const planeEntries = (entries ?? []).filter((entry) => (entry.plane ?? 'mcp') === plane);

  const update = async (entry: MarketEntry) => {
    setUpdatingId(entry.id);
    try {
      const started = (await api.post(`/api/v1/market/${entry.id}/update`)) as {
        jobId: string | null;
        status: string;
      };
      if (started.status === 'up_to_date' || started.jobId === null) {
        toast(t('market.upToDate'), 'success');
        return;
      }
      for (;;) {
        const job = await api.get<{ status: string; error?: string }>(
          `/api/v1/market/install/${started.jobId}`,
        );
        if (job.status !== 'updating') {
          const status = job.status as InstallStatus;
          if (!isInstallSuccessful(status)) {
            toast(
              job.error ??
                (status === 'interrupted' ? t('market.installInterrupted') : 'update failed'),
              'error',
            );
          } else {
            toast(`✓ ${entry.name} ${t('market.updated')}`, 'success');
          }
          refetch();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setUpdatingId(null);
    }
  };

  const remove = async (entry: MarketEntry) => {
    const ok = await confirm({
      title: t('market.uninstall'),
      description: t('market.uninstallConfirm', { name: entry.name }),
      confirmLabel: t('market.uninstall'),
      danger: true,
    });
    if (!ok) return;
    uninstall.mutate(
      { id: entry.id },
      {
        onSuccess: () => toast(`✗ ${entry.name} ${t('market.uninstall')}`, 'success'),
        onError: (error) => toast(error.message, 'error'),
      },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">{t('market.title')}</h1>
      </div>

      <TabsView
        tabs={[
          {
            value: 'mcp',
            label: `MCP (${(entries ?? []).filter((entry) => (entry.plane ?? 'mcp') === 'mcp').length})`,
          },
          {
            value: 'cli',
            label: `CLI (${(entries ?? []).filter((entry) => entry.plane === 'cli').length})`,
          },
        ]}
        value={plane}
        onChange={(next) => setPlane(next as 'mcp' | 'cli')}
        render={() => null}
      />

      {isLoading ? (
        <div className="text-sm text-ink-3">{t('common.loading')}</div>
      ) : planeEntries.length > 0 ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {planeEntries.map((entry) => (
            <div
              key={entry.id}
              className="flex flex-col gap-3 bg-surface p-4 transition-colors hover:bg-surface-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{entry.name}</span>
                    {(entry.plane ?? 'mcp') === 'cli' ? (
                      <Badge tone="accent">{entry.kind === 'cli-image' ? 'image' : 'binary'}</Badge>
                    ) : entry.kind === 'remote' ? (
                      <Badge tone="accent">{t('market.remote')}</Badge>
                    ) : (
                      <Badge tone="neutral">{t('market.stdio')}</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    {categoryLabel[entry.category] ?? entry.category}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {entry.installed && entry.updateAvailable && (
                    <Badge tone="warning">{t('market.updateAvailable')}</Badge>
                  )}
                  {entry.installed ? <StatusDot tone="success" /> : <StatusDot tone="neutral" />}
                </div>
              </div>
              <p className="line-clamp-2 min-h-[32px] text-[13px] text-ink-2">
                {entry.description}
              </p>
              <div className="flex items-center justify-between">
                {entry.installed && entry.updateAvailable && (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={updatingId === entry.id}
                    disabled={updatingId !== null}
                    onClick={() => update(entry)}
                  >
                    <RefreshCw className="size-3.5" />
                    {t('market.update')}
                  </Button>
                )}
                {entry.installed ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={uninstall.isPending && uninstall.variables?.id === entry.id}
                    disabled={uninstall.isPending && uninstall.variables?.id === entry.id}
                    onClick={() => remove(entry)}
                  >
                    <Trash2 className="size-3.5" />
                    {t('market.uninstall')}
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" onClick={() => setInstallTarget(entry)}>
                    <Plug className="size-3.5" />
                    {t('market.install')}
                  </Button>
                )}
                {entry.installed && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      navigate(
                        (entry.plane ?? 'mcp') === 'cli' ? `/clis` : `/servers?slug=${entry.id}`,
                      )
                    }
                  >
                    {t('market.open')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={
            plane === 'cli' ? <SquareTerminal className="size-8" /> : <Boxes className="size-8" />
          }
          title={t('common.empty')}
        />
      )}

      {installTarget && (
        <InstallSheet
          entry={installTarget}
          onOpenChange={(open) => !open && setInstallTarget(null)}
          onInstalled={() => {
            void refetch();
            if (installTarget.credential.type === 'oauth') {
              navigate('/credentials');
            }
          }}
        />
      )}
    </div>
  );
}
