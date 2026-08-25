import { KeySquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useToast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/Field';

interface ActionInfo {
  actionId: string;
  status: string;
  entryId: string | null;
  entryName: string | null;
  fields: { name: string; description: string }[];
}

export function SecureActionPage() {
  const { actionId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const { t } = useI18n();
  const { toast } = useToast();
  const [info, setInfo] = useState<ActionInfo | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api
      .get<ActionInfo>(`/api/v1/secure-actions/${actionId}?token=${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((error) => toast((error as Error).message, 'error'));
  }, [actionId, token, toast]);

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.post(`/api/v1/secure-actions/${actionId}/complete`, { token, values });
      setDone(true);
      toast(t('secureAction.completed'), 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <KeySquare className="size-5 text-ink-3" />
          <h1 className="text-lg font-semibold tracking-[-0.02em]">{t('secureAction.title')}</h1>
        </div>

        {done ? (
          <div className="bg-surface px-4 py-6 text-center text-sm text-ink-2">
            {t('secureAction.done')}
          </div>
        ) : !info ? (
          <div className="text-sm text-ink-3">{t('common.loading')}</div>
        ) : info.status !== 'pending' ? (
          <div className="bg-surface px-4 py-6 text-center text-sm text-ink-3">
            {t('secureAction.expired')}
          </div>
        ) : (
          <>
            <p className="text-sm text-ink-2">
              {t('secureAction.entryLabel')}
              {info.entryName ?? info.entryId ?? '—'}
            </p>
            <p className="text-xs text-ink-3">{t('secureAction.hint')}</p>
            <div className="flex flex-col gap-4">
              {info.fields.map((field) => (
                <TextField
                  key={field.name}
                  label={`${field.name} — ${field.description}`}
                  type="password"
                  mono
                  value={values[field.name] ?? ''}
                  onChange={(value) =>
                    setValues((current) => ({ ...current, [field.name]: value }))
                  }
                />
              ))}
              {info.fields.length === 0 && (
                <p className="text-sm text-ink-3">{t('secureAction.noFields')}</p>
              )}
            </div>
            <Button
              variant="primary"
              loading={submitting}
              disabled={info.fields.some((field) => !values[field.name])}
              onClick={submit}
            >
              {t('secureAction.complete')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
