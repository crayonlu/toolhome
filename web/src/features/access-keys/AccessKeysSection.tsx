import { Link2, Plus } from 'lucide-react';
import { useState } from 'react';
import { useAccessKeys, useCreateAccessKey, useRevokeAccessKey } from '../../app/queries';
import { useI18n } from '../../i18n';
import { useToast } from '../../components/ui/Toast';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { EmptyState } from '../../components/ui/Badge';
import { Dialog } from '../../components/ui/Dialog';
import { TextField } from '../../components/ui/Field';

/**
 * Access keys (tch_mcp_*) authenticate the MCP data plane. They live next to
 * control keys in Settings so both key families are managed in one place.
 */
export function AccessKeysSection() {
  const { t } = useI18n();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { data: keys, isLoading } = useAccessKeys();
  const createKey = useCreateAccessKey();
  const revokeKey = useRevokeAccessKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);

  const submit = () => {
    createKey.mutate(name, {
      onSuccess: (result) => {
        setCreateOpen(false);
        setName('');
        setSecret(result.secret ?? null);
      },
      onError: (error) => toast(error.message, 'error'),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-[13px] font-medium text-ink-3">{t('settings.accessKeys')}</span>
          <span className="text-xs text-ink-3">{t('settings.accessKeyHint')}</span>
        </div>
        <Button variant="secondary" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {t('common.create')}
        </Button>
      </div>

      {isLoading ? (
        <div className="text-sm text-ink-3">{t('common.loading')}</div>
      ) : keys && keys.length > 0 ? (
        <div className="flex flex-col divide-y divide-ink-3/10">
          {keys.map((key) => (
            <div key={key.id} className="flex min-h-[52px] items-center gap-3 px-1 py-2">
              <Link2 className="size-4 shrink-0 text-ink-3" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-ink">{key.name}</span>
                <span className="font-mono text-xs text-ink-3">{key.prefix}</span>
              </div>
              <span className="text-xs text-ink-3">
                {new Date(key.createdAt).toLocaleDateString()}
              </span>
              <Button
                variant="ghost"
                loading={revokeKey.isPending && revokeKey.variables?.id === key.id}
                disabled={revokeKey.isPending && revokeKey.variables?.id === key.id}
                onClick={async () => {
                  const ok = await confirm({
                    title: t('common.delete'),
                    description: `${t('common.delete')} ${key.name}?`,
                    confirmLabel: t('common.delete'),
                    danger: true,
                  });
                  if (!ok) return;
                  revokeKey.mutate(
                    { id: key.id },
                    { onError: (error) => toast(error.message, 'error') },
                  );
                }}
              >
                {t('common.delete')}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Link2 className="size-8" />}
          title={t('common.empty')}
          action={
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('common.create')}
            </Button>
          }
        />
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen} title={t('common.create')}>
        <TextField label={t('common.name')} value={name} onChange={setName} required autoFocus />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setCreateOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={createKey.isPending} disabled={!name} onClick={submit}>
            {t('common.create')}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(secret)}
        onOpenChange={(open) => !open && setSecret(null)}
        title={t('settings.accessKeys')}
      >
        <p className="text-sm text-ink-2">{t('common.copyNow')}</p>
        <div className="mt-3 flex items-center gap-2 bg-surface-2 px-3 py-2.5">
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-ink">{secret}</code>
          <CopyButton text={secret ?? ''} />
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={() => setSecret(null)}>
            {t('common.close')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
