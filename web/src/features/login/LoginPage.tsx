import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, storeKey } from '../../api/client';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui/Button';

export function LoginPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    storeKey(key.trim(), remember);
    try {
      await api.get('/api/v1/overview');
      const returnTo =
        typeof location.state?.returnTo === 'string'
          ? location.state.returnTo
          : new URLSearchParams(location.search).get('returnTo');
      navigate(returnTo || '/', { replace: true });
    } catch (err) {
      setError(t('login.error'));
      setLoading(false);
    }
  };

  return (
    <div className="flex h-dvh items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2">
          <span className="size-2.5 bg-accent" />
          <span className="text-xl font-semibold tracking-[-0.02em]">{t('app.title')}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">{t('login.title')}</h1>
        <p className="mt-1.5 text-sm text-ink-3">{t('login.subtitle')}</p>

        <div className="mt-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-ink-2" htmlFor="control-key">
              {t('login.controlKey')}
            </label>
            <input
              id="control-key"
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              autoFocus
              spellCheck={false}
              className="h-10 bg-surface-2 px-3 font-mono text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-accent/50"
              placeholder="tch_ctl_…"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="size-4 accent-[var(--mch-accent)]"
            />
            {t('login.remember')}
          </label>

          {error && <div className="text-sm text-danger">{error}</div>}

          <Button type="submit" variant="primary" size="md" loading={loading}>
            {t('login.submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}
