import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useToast } from '../../components/ui/Toast';
import { Sheet } from '../../components/ui/Sheet';
import { Button, Spinner } from '../../components/ui/Button';
import { FieldGroup, TextField } from '../../components/ui/Field';
import { CopyButton } from '../../components/ui/CopyButton';
import type { MarketEntry } from '../../api/types';
import { toConsoleActionUrl } from './secure-action-url';
import {
  isInstallPending,
  isInstallRunning,
  SECURE_ACTION_EXPIRED,
  type InstallStatus,
} from './install-job';

interface InstallJob {
  status: InstallStatus;
  step: string;
  output: string;
  result?: unknown;
  error?: string;
}
export function InstallSheet({
  entry,
  onOpenChange,
  onInstalled,
}: {
  entry: MarketEntry | null;
  onOpenChange: (open: boolean) => void;
  onInstalled: (slug: string) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [job, setJob] = useState<InstallJob | null>(null);
  const [installing, setInstalling] = useState(false);
  const [actionUrl, setActionUrl] = useState<string | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = entry !== null;
    return () => {
      activeRef.current = false;
    };
  }, [entry]);

  useEffect(() => {
    if (entry) {
      setValues({});
      setJob(null);
      setInstalling(false);
      setActionUrl(null);
    }
  }, [entry]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [job?.output]);

  if (!entry) return null;

  const missing = entry.requires.some(
    (requirement) => requirement.required && !requirement.secret && !values[requirement.name],
  );

  const submit = async () => {
    setInstalling(true);
    setJob({ status: 'installing', step: 'starting', output: '' });
    try {
      const started = (await api.post(`/api/v1/market/${entry.id}/install`, {
        values,
      })) as { jobId: string | null; status: string; actionUrl?: string };
      setActionUrl(
        started.actionUrl === undefined
          ? null
          : toConsoleActionUrl(started.actionUrl, window.location.origin),
      );
      if (started.jobId === null || started.status === 'already_installed') {
        setInstalling(false);
        onOpenChange(false);
        toast(`✓ ${entry.name} ${t('market.install')}`, 'success');
        onInstalled(entry.id);
        return;
      }
      for (;;) {
        const current = await api.get<InstallJob>(`/api/v1/market/install/${started.jobId}`);
        if (!activeRef.current) return;
        setJob(current);
        if (current.status === 'interrupted') {
          setInstalling(false);
          return;
        }
        if (current.status === 'awaiting_secret') {
          setInstalling(false);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        if (!isInstallPending(current.status)) {
          setInstalling(false);
          if (current.status === 'failed') {
            toast(current.error ?? 'install failed', 'error');
            return;
          }
          onOpenChange(false);
          if (entry.credential.type === 'oauth') {
            toast(t('market.installedAuthorize', { name: entry.name }), 'success');
          } else {
            toast(`✓ ${entry.name} ${t('market.install')}`, 'success');
          }
          onInstalled(entry.id);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch (error) {
      setInstalling(false);
      toast((error as Error).message, 'error');
    }
  };

  const installingNow = installing && job !== null && isInstallRunning(job.status);
  const awaitingSecret = job?.status === 'awaiting_secret' && actionUrl !== null;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) activeRef.current = false;
        onOpenChange(open);
      }}
      title={`${t('market.install')} · ${entry.name}`}
    >
      <p className="mb-4 text-sm text-ink-2">{entry.description}</p>
      {entry.plane === 'cli' && (
        <div className="mb-4 bg-surface-2 px-3 py-2 text-xs text-ink-3">
          Hosted CLI for {entry.platform ?? 'a platform'}; installation details are managed by
          ToolHome.
        </div>
      )}
      <FieldGroup>
        {entry.requires.map((requirement) => (
          <TextField
            key={requirement.name}
            label={requirement.description || requirement.name}
            value={values[requirement.name] ?? ''}
            onChange={(value) =>
              setValues((current) => ({ ...current, [requirement.name]: value }))
            }
            type={requirement.secret ? 'password' : 'text'}
            mono
            required={requirement.required}
            disabled={installingNow || awaitingSecret}
          />
        ))}
        {entry.requires.length === 0 && (
          <div className="text-sm text-ink-3">
            {entry.credential.type === 'oauth' ? t('market.authorizeAfter') : t('market.noConfig')}
          </div>
        )}
      </FieldGroup>

      {awaitingSecret && (
        <div className="mt-4 flex flex-col gap-3 bg-surface-2 p-3">
          <div className="text-sm text-ink">{t('market.secretRequired')}</div>
          <p className="text-xs text-ink-3">{t('market.secretRequiredHint')}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">
              {actionUrl}
            </code>
            <CopyButton text={actionUrl} />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(actionUrl, '_blank', 'noopener,noreferrer')}
            >
              {t('market.openSecretAction')}
            </Button>
          </div>
        </div>
      )}

      {installingNow && (
        <div className="mt-4 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm text-ink">
            <Spinner className="size-3.5" />
            <span className="truncate">{job?.step}</span>
          </div>
          <div className="h-1 w-full bg-surface-2">
            <div className="h-full w-1/3 animate-pulse bg-accent" />
          </div>
          <pre
            ref={outputRef}
            className="max-h-40 overflow-auto bg-surface-2 p-3 font-mono text-xs leading-relaxed text-ink-2"
          >
            {job?.output || '…'}
          </pre>
        </div>
      )}

      {job?.status === 'interrupted' && (
        <div className="mt-4 text-sm text-danger">{t('market.installInterrupted')}</div>
      )}

      {job?.status === 'failed' && (
        <div className="mt-4 flex flex-col gap-3">
          <div className="text-sm text-danger">
            {job.error === SECURE_ACTION_EXPIRED
              ? t('market.secretLinkExpired')
              : (job.error ?? '')}
          </div>
          {job.error !== SECURE_ACTION_EXPIRED && (
            <pre className="max-h-40 overflow-auto bg-surface-2 p-3 font-mono text-xs text-ink-2">
              {job.output}
            </pre>
          )}
          <div>
            <Button variant="primary" onClick={submit}>
              {t('common.retry')}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={installingNow}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          loading={installingNow}
          disabled={missing || installingNow || awaitingSecret}
          onClick={submit}
        >
          {installingNow ? t('market.installing') : t('common.create')}
        </Button>
      </div>
    </Sheet>
  );
}
