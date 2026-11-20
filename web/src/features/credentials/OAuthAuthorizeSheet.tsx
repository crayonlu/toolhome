import { ExternalLink, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAuthorizeCredential, useCredential } from '../../app/queries'
import { useI18n } from '../../i18n'
import { Sheet } from '../../components/ui/Sheet'
import { Button } from '../../components/ui/Button'
import { StatusDot } from '../../components/ui/Badge'
import { credentialStatusLabel, credentialStatusMeta } from '../../app/status'
import type { AuthorizeResult } from '../../api/types'

export function OAuthAuthorizeSheet({
  open,
  onOpenChange,
  credentialId,
  credentialName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  credentialId: string
  credentialName: string
}) {
  const { t, locale } = useI18n()
  const authorize = useAuthorizeCredential()
  const { data: credential } = useCredential(open ? credentialId : '', { pollMs: 3000 })
  const [result, setResult] = useState<AuthorizeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const startedRef = useRef(false)
  const pollRef = useRef<number | null>(null)

  useEffect(() => {
    if (open && !startedRef.current) {
      startedRef.current = true
      setResult(null)
      setError(null)
      setElapsed(0)
      start(false)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    if (result?.status === 'authorization-required' && result.authorizationUrl) {
      pollRef.current = window.setInterval(() => {
        setElapsed((value) => value + 2)
      }, 2000)
      return () => {
        if (pollRef.current) window.clearInterval(pollRef.current)
      }
    }
  }, [open, result?.status, result?.authorizationUrl])

  const start = (force: boolean) => {
    setError(null)
    authorize.mutate(
      { id: credentialId, force },
      {
        onSuccess: (data) => {
          setResult(data)
          if (data.status === 'authorization-required' && data.authorizationUrl) {
            window.open(data.authorizationUrl, '_blank')
          }
        },
        onError: (err) => setError(err.message),
      },
    )
  }

  const authorized = credential?.status === 'ready'
  const waiting = result?.status === 'authorization-required' && !authorized && !error
  const timedOut = waiting && elapsed >= 600

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`OAuth · ${credentialName}`}>
      <div className="flex flex-col gap-4">
        {authorize.isPending && (
          <div className="flex items-center gap-2 text-sm text-ink">
            <StatusDot tone="accent" pulse />
            <span>{t('oauth.authorizing')}</span>
          </div>
        )}

        {waiting && result?.authorizationUrl && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-ink">
              <StatusDot tone="accent" pulse />
              <span>{t('oauth.authorizing')}</span>
            </div>
            <div className="flex items-center gap-2 bg-surface-2 px-3 py-2.5">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">
                {result.authorizationUrl}
              </code>
              <Button size="sm" onClick={() => window.open(result.authorizationUrl, '_blank')}>
                <ExternalLink className="size-3.5" />
                {t('oauth.open')}
              </Button>
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-3">
              <RefreshCw className="size-3 animate-spin" />
              {timedOut
                ? t('oauth.timedOut')
                : t('oauth.waiting', { seconds: Math.max(0, 600 - elapsed) })}
            </div>
            {timedOut && (
              <Button onClick={() => start(true)}>
                <RefreshCw className="size-4" />
                {t('oauth.retry')}
              </Button>
            )}
          </div>
        )}

        {error && (
          <div className="flex flex-col gap-3">
            <div className="text-sm text-danger">{error}</div>
            <Button onClick={() => start(true)}>
              <RefreshCw className="size-4" />
              {t('oauth.retry')}
            </Button>
          </div>
        )}

        {authorized && (
          <div className="flex items-center gap-2 text-sm text-ink">
            <StatusDot tone="success" />
            <span>{t('oauth.authorized')}</span>
          </div>
        )}

        {credential && (
          <div className="flex items-center gap-2 text-sm text-ink-2">
            <StatusDot tone={credentialStatusMeta(credential.status).tone} />
            {credentialStatusLabel(credential.status, locale)}
          </div>
        )}

        <div className="mt-2 flex gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
