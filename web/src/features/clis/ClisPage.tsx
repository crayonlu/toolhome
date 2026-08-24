import { Plus, TerminalSquare } from 'lucide-react';
import { useState } from 'react';
import { useClis, useCreateCli, useCliExec, useDeleteCli, useUpdateCli } from '../../app/queries';
import { useI18n } from '../../i18n';
import { useToast } from '../../components/ui/Toast';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { Button } from '../../components/ui/Button';
import { Badge, EmptyState, StatusDot } from '../../components/ui/Badge';
import { Toggle } from '../../components/ui/Toggle';
import { ActionsMenu } from '../../components/ui/Menu';
import { CliFormSheet, type CliFormValue } from './CliFormSheet';
import { CliExecSheet } from './CliExecSheet';
import type { CliRecord } from '../../api/types';

function statusMeta(status: CliRecord['enabled']) {
  return status ? { tone: 'success' as const } : { tone: 'neutral' as const };
}

export function ClisPage() {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { data: clis, isLoading } = useClis();
  const createCli = useCreateCli();
  const updateCli = useUpdateCli();
  const deleteCli = useDeleteCli();
  const execCli = useCliExec();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CliRecord | undefined>(undefined);
  const [execTarget, setExecTarget] = useState<CliRecord | undefined>(undefined);

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

  const handleExec = async (slug: string, argvText: string) => {
    try {
      await execCli.mutateAsync({ slug, input: { argv: argvText.split(/\s+/).filter(Boolean) } });
    } catch {
      // handled inside exec sheet
    }
  };

  void handleExec;

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
        <Button variant="primary" onClick={openCreate}>
          <Plus className="size-4" />
          {t('common.add')}
        </Button>
      </div>

      {isLoading ? (
        <div className="text-sm text-ink-3">{t('common.loading')}</div>
      ) : clis && clis.length > 0 ? (
        <div className="flex flex-col divide-y divide-ink-3/10">
          {clis.map((cli) => {
            const meta = statusMeta(cli.enabled);
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
                <span className="hidden w-24 text-right text-xs text-ink-2 sm:block">
                  {cli.enabled ? t('status.ready') : t('status.disabled')}
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
