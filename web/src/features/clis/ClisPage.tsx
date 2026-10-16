import { Plus, RefreshCw, TerminalSquare } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client';
import { useClis, useCreateCli, useDeleteCli, useUpdateCli } from '../../app/queries';
import { ProbeStateLabel } from './ProbeStateLabel';
import { probeState, probeTone } from './probe';
import { useI18n } from '../../i18n';
import { useToast } from '../../components/ui/Toast';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { Button } from '../../components/ui/Button';
import { Badge, EmptyState, StatusDot } from '../../components/ui/Badge';
import { Toggle } from '../../components/ui/Toggle';
import { ActionsMenu } from '../../components/ui/Menu';
import { CliFormSheet, type CliFormValue } from './CliFormSheet';
import { CliExecSheet } from './CliExecSheet';
import type { CliRecord, CliStatus } from '../../api/types';

/** Record state, shown until a probe answers for that CLI. */
function recordMeta(enabled: boolean) {
  return enabled ? { tone: 'success' as const } : { tone: 'neutral' as const };
}

export function ClisPage() {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { data: clis, isLoading } = useClis();
  const createCli = useCreateCli();
  const updateCli = useUpdateCli();
  const deleteCli = useDeleteCli();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CliRecord | undefined>(undefined);
  const [execTarget, setExecTarget] = useState<CliRecord | undefined>(undefined);
  const [statuses, setStatuses] = useState<Record<string, CliStatus>>({});
  const [checking, setChecking] = useState<string[]>([]);

  // A probe executes the CLI, so it runs on request rather than on page load.
  const check = async (cli: CliRecord): Promise<void> => {
    setChecking((current) => [...current, cli.slug]);
    try {
      const status = await api.get<CliStatus>(`/cli/${encodeURIComponent(cli.slug)}/status`);
      setStatuses((current) => ({ ...current, [cli.slug]: status }));
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setChecking((current) => current.filter((slug) => slug !== cli.slug));
    }
  };

  const checkAll = async (): Promise<void> => {
    for (const cli of clis ?? []) await check(cli);
  };

  const deletePending = (id: string) => deleteCli.isPending && deleteCli.variables?.id === id;

  const openCreate = () => {
    setEditing(undefined);
    setFormOpen(true);
  };

  const openEdit = (cli: CliRecord) => {
    setEditing(cli);
    setFormOpen(true);
  };

  const handleSubmit = (value: CliFormValue) => {
    const done = () => {
      setFormOpen(false);
      toast(editing ? t('common.save') : t('common.create'), 'success');
    };
    if (editing) {
      updateCli.mutate(
        { id: editing.id, input: value },
        { onSuccess: done, onError: (error) => toast(error.message, 'error') },
      );
    } else {
      createCli.mutate(value, {
        onSuccess: done,
        onError: (error) => toast(error.message, 'error'),
      });
    }
  };

  const removeCli = async (cli: CliRecord) => {
    const ok = await confirm({
      title: `${t('common.delete')} ${cli.name}?`,
      description: t('cli.deleteHint'),
      danger: true,
    });
    if (!ok) return;
    deleteCli.mutate(
      { id: cli.id },
      {
        onSuccess: () => toast(t('common.delete'), 'success'),
        onError: (error) => toast(error.message, 'error'),
      },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">{t('nav.clis')}</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            loading={checking.length > 0}
            onClick={() => void checkAll()}
          >
            <RefreshCw className="size-4" />
            {t('cli.checkAll')}
          </Button>
          <Button variant="primary" onClick={openCreate}>
            <Plus className="size-4" />
            {t('common.add')}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-ink-3">{t('common.loading')}</div>
      ) : clis && clis.length > 0 ? (
        <div className="flex flex-col divide-y divide-ink-3/10">
          {clis.map((cli) => {
            const status = statuses[cli.slug];
            const state = probeState(status);
            const meta = status === undefined ? recordMeta(cli.enabled) : { tone: probeTone(state) };
            const removing = deletePending(cli.id);
            return (
              <div
                key={cli.id}
                className={`flex min-h-[52px] items-center gap-3 px-1 py-2 transition-opacity ${
                  removing ? 'opacity-50' : ''
                }`}
              >
                <StatusDot tone={meta.tone} />
                <button
                  type="button"
                  onClick={() => setExecTarget(cli)}
                  className="flex min-w-0 flex-1 flex-col text-left"
                >
                  <span className="truncate text-sm font-medium text-ink">{cli.name}</span>
                  <span className="truncate font-mono text-xs text-ink-3">
                    {cli.slug} · {cli.command}
                  </span>
                </button>
                <Badge tone={cli.executionMode === 'docker' ? 'accent' : 'neutral'}>
                  {cli.executionMode}
                </Badge>
                <span
                  className="hidden w-32 text-right text-xs text-ink-2 sm:block"
                  title={status?.version ?? undefined}
                >
                  {status === undefined ? (
                    cli.enabled ? (
                      t('cli.configured')
                    ) : (
                      t('status.disabled')
                    )
                  ) : (
                    <ProbeStateLabel state={state} version={status.version} />
                  )}
                </span>
                <Toggle
                  checked={cli.enabled}
                  disabled={updateCli.isPending}
                  onChange={(enabled) =>
                    updateCli.mutate(
                      { id: cli.id, input: { enabled } },
                      { onError: (error) => toast(error.message, 'error') },
                    )
                  }
                />
                <ActionsMenu
                  actions={[
                    {
                      label: t('cli.check'),
                      disabled: checking.includes(cli.slug),
                      onSelect: () => void check(cli),
                    },
                    { label: t('cli.run'), onSelect: () => setExecTarget(cli) },
                    { label: t('common.edit'), onSelect: () => openEdit(cli) },
                    {
                      label: t('common.delete'),
                      danger: true,
                      onSelect: () => {
                        void removeCli(cli);
                      },
                    },
                  ]}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<TerminalSquare className="size-10" />}
          title={t('cli.emptyTitle')}
          description={t('cli.emptyDescription')}
          action={
            <Button variant="primary" onClick={openCreate}>
              <Plus className="size-4" />
              {t('common.add')}
            </Button>
          }
        />
      )}

      <p className="hidden items-center gap-2 text-xs text-ink-3 sm:flex">
        {locale === 'zh' ? 'CLI 与 MCP 平行托管' : 'CLIs are hosted in parallel with MCP servers'}
      </p>

      <CliFormSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        initial={editing}
        onSubmit={handleSubmit}
        submitting={createCli.isPending || updateCli.isPending}
        title={editing ? `${t('common.edit')} · ${editing.name}` : t('cli.addTitle')}
      />

      {execTarget !== undefined && (
        <CliExecSheet
          open
          onOpenChange={(open) => !open && setExecTarget(undefined)}
          cli={execTarget}
        />
      )}
    </div>
  );
}
