import { SquareTerminal } from 'lucide-react';
import { useDiagnostics } from '../../app/queries';
import { useI18n } from '../../i18n';
import { useToast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { StatusDot } from '../../components/ui/Badge';
import { runtimeStatusLabel, runtimeStatusMeta } from '../../app/status';

export function DiagnosticsPage() {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const { data: diagnostics, isLoading, refetch, isRefetching } = useDiagnostics();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">{t('nav.diagnostics')}</h1>
        <Button
          loading={isRefetching}
          onClick={() => refetch().catch((error) => toast(error.message, 'error'))}
        >
          {t('common.refresh')}
        </Button>
      </div>

      {isLoading ? (
        <div className="text-sm text-ink-3">{t('common.loading')}</div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm">
            <StatusDot tone={diagnostics?.ok ? 'success' : 'danger'} />
            <span className="text-ink">
              {diagnostics?.ok ? t('common.operational') : t('common.degraded')}
            </span>
          </div>
          <div className="flex flex-col divide-y divide-ink-3/10">
            {(diagnostics?.servers ?? []).map((server) => {
              const meta = runtimeStatusMeta(server.status);
              return (
                <div key={server.slug} className="flex items-center gap-3 px-1 py-2.5">
                  <StatusDot tone={meta.tone} pulse={meta.pulse} />
                  <span className="w-32 shrink-0 font-mono text-sm text-ink">{server.slug}</span>
                  <span className="text-xs text-ink-2">
                    {runtimeStatusLabel(server.status as never, locale)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-3">
                    {server.lastError ?? ''}
                  </span>
                  <span className="text-xs text-ink-3">
                    {server.hasSnapshot ? t('diagnostics.snapshot') : ''}
                  </span>
                </div>
              );
            })}
          </div>
          {(diagnostics?.clis ?? []).length > 0 && (
            <div className="mt-5">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-ink">
                <SquareTerminal className="size-4 text-ink-3" />
                {t('nav.clis')}
              </div>
              <div className="flex flex-col divide-y divide-ink-3/10">
                {(diagnostics?.clis ?? []).map((cli) => (
                  <div key={cli.id} className="flex items-center gap-3 px-1 py-2.5">
                    <StatusDot tone={cli.enabled ? 'success' : 'neutral'} />
                    <span className="w-32 shrink-0 font-mono text-sm text-ink">{cli.slug}</span>
                    <span className="text-xs text-ink-2">
                      {cli.enabled ? t('status.configured') : t('status.disabled')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
