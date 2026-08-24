import { Download, FileJson, KeySquare, ShieldAlert, Terminal, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '../../api/client'
import {
  useControlKeys,
  useCreateControlKey,
  useRevokeControlKey,
} from '../../app/queries'
import { useI18n } from '../../i18n'
import { useTheme } from '../../app/theme'
import { useToast } from '../../components/ui/Toast'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { TextField, TextareaField } from '../../components/ui/Field'
import { CopyButton } from '../../components/ui/CopyButton'
import { SelectField } from '../../components/ui/SelectField'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13px] font-medium text-ink-3">{title}</div>
      {children}
    </div>
  )
}

interface HarnessPreviewEntry {
  name: string
  slug: string
  kind: 'remote' | 'home'
  transportSummary: string
  credential: { name: string; type: string; fields: { name: string; masked: boolean }[] } | null
  warnings: string[]
}

interface HarnessImportResult {
  preview: boolean
  entries: (HarnessPreviewEntry & {
    status?: string
    message?: string
  })[]
}

export function SettingsPage() {
  const { t } = useI18n()
  const { locale, setLocale } = useI18n()
  const { theme, setTheme } = useTheme()
  const { toast } = useToast()
  const confirm = useConfirm()
  const { data: controlKeys } = useControlKeys()
  const createKey = useCreateControlKey()
  const revokeKey = useRevokeControlKey()
  const [keyName, setKeyName] = useState('')
  const [keyScope, setKeyScope] = useState<'admin' | 'agent'>('admin')
  const [keyOpen, setKeyOpen] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [running, setRunning] = useState(false)
  const [harnessText, setHarnessText] = useState('')
  const [harnessBusy, setHarnessBusy] = useState(false)
  const [harnessResult, setHarnessResult] = useState<HarnessImportResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState('/api/v1/overview')
  const [bodyText, setBodyText] = useState('{}')
  const [rawResult, setRawResult] = useState<string>('')

  const exportConfig = async (includeSecrets: boolean) => {
    try {
      const response = await fetch(
        `/api/v1/config/export${includeSecrets ? '?includeSecrets=true' : ''}`,
        {
          headers: { Authorization: `Bearer ${localStorage.getItem('mch.controlKey') ?? ''}` },
        },
      )
      if (!response.ok) throw new Error(String(response.status))
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `toolhome-backup-${new Date().toISOString().slice(0, 10)}.json`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }

  const importConfig = async (file: File) => {
    setImporting(true)
    try {
      const text = await file.text()
      await api.post('/api/v1/config/import', JSON.parse(text))
      toast('imported', 'success')
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const importHarness = async (preview: boolean) => {
    setHarnessBusy(true)
    setHarnessResult(null)
    try {
      const config = JSON.parse(harnessText)
      const result = await api.post('/api/v1/config/import-harness', { config, preview })
      setHarnessResult(result as HarnessImportResult)
      if (!preview) toast('imported', 'success')
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setHarnessBusy(false)
    }
  }

  const runRaw = async () => {
    setRunning(true)
    try {
      let result: unknown
      if (method === 'GET') result = await api.get(path)
      else if (method === 'DELETE') result = await api.delete(path)
      else result = await api.post(path, JSON.parse(bodyText))
      setRawResult(JSON.stringify(result, null, 2))
    } catch (error) {
      setRawResult(`error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-[-0.02em]">{t('nav.settings')}</h1>

      <Section title={t('common.language')}>
        <div className="flex gap-2">
          {(['zh', 'en'] as const).map((item) => (
            <Button
              key={item}
              variant={locale === item ? 'primary' : 'secondary'}
              onClick={() => setLocale(item)}
            >
              {t(`lang.${item}`)}
            </Button>
          ))}
        </div>
      </Section>

      <Section title={t('common.theme')}>
        <div className="flex gap-2">
          {(['dark', 'light', 'auto'] as const).map((item) => (
            <Button
              key={item}
              variant={theme === item ? 'primary' : 'secondary'}
              onClick={() => setTheme(item)}
            >
              {t(`theme.${item}`)}
            </Button>
          ))}
        </div>
      </Section>

      <Section title={t('settings.config')}>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => exportConfig(false)}>
            <Download className="size-4" />
            {t('settings.export')}
          </Button>
          <Button onClick={() => exportConfig(true)}>
            <Download className="size-4" />
            {t('settings.exportSecrets')}
          </Button>
          <Button onClick={() => fileRef.current?.click()} loading={importing}>
            <Upload className="size-4" />
            {t('settings.import')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) importConfig(file)
            }}
          />
        </div>
      </Section>

      <Section title={t('settings.harnessImport')}>
        <p className="text-xs text-ink-3">{t('settings.harnessHint')}</p>
        <TextareaField
          value={harnessText}
          onChange={setHarnessText}
          mono
          rows={6}
          placeholder={t('settings.harnessPlaceholder')}
        />
        <div className="flex gap-2">
          <Button
            variant="secondary"
            loading={harnessBusy}
            disabled={!harnessText.trim()}
            onClick={() => importHarness(true)}
          >
            <FileJson className="size-4" />
            {t('settings.harnessPreview')}
          </Button>
          <Button
            loading={harnessBusy}
            disabled={!harnessText.trim()}
            onClick={() => importHarness(false)}
          >
            <Upload className="size-4" />
            {t('settings.harnessImportButton')}
          </Button>
        </div>
        {harnessResult && (
          <div className="flex flex-col divide-y divide-ink-3/10 bg-surface">
            {harnessResult.entries.map((entry) => (
              <div key={entry.slug} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink">{entry.name}</span>
                  <Badge tone={entry.kind === 'remote' ? 'accent' : 'neutral'}>{entry.kind}</Badge>
                  {entry.status && (
                    <Badge tone={entry.status === 'created' ? 'accent' : 'warning'}>
                      {t(`settings.harnessStatus.${entry.status}`)}
                    </Badge>
                  )}
                </div>
                <code className="truncate font-mono text-xs text-ink-3">
                  {entry.transportSummary}
                </code>
                {entry.credential && (
                  <span className="text-xs text-ink-3">
                    {t('settings.harnessCredential')}: {entry.credential.type} (
                    {entry.credential.fields.map((field) => field.name).join(', ')})
                  </span>
                )}
                {entry.message && <span className="text-xs text-warning">{entry.message}</span>}
                {entry.warnings.map((warning) => (
                  <span key={warning} className="text-xs text-warning">
                    {warning}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('settings.controlKeys')}>
        <div className="flex flex-col divide-y divide-ink-3/10">
          {(controlKeys ?? []).map((key) => (
            <div key={key.id} className="flex items-center gap-3 px-1 py-2">
              <KeySquare className="size-4 shrink-0 text-ink-3" />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-ink">{key.name}</span>
                  <Badge tone={key.scope === 'agent' ? 'accent' : 'neutral'}>
                    {key.scope === 'agent' ? t('settings.scopeAgent') : t('settings.scopeAdmin')}
                  </Badge>
                </div>
                <span className="font-mono text-xs text-ink-3">{key.prefix}</span>
              </div>
              <Button
                variant="ghost"
                loading={revokeKey.isPending && revokeKey.variables?.id === key.id}
                disabled={revokeKey.isPending && revokeKey.variables?.id === key.id}
                onClick={async () => {
                  const ok = await confirm({
                    title: t('credential.revoke'),
                    description: `${t('credential.revoke')} ${key.name}?`,
                    confirmLabel: t('credential.revoke'),
                    danger: true,
                  })
                  if (!ok) return
                  revokeKey.mutate(
                    { id: key.id },
                    { onError: (error) => toast(error.message, 'error') },
                  )
                }}
              >
                {t('common.delete')}
              </Button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setKeyOpen(true)}>
            <ShieldAlert className="size-4" />
            {t('settings.createControlKey')}
          </Button>
        </div>
      </Section>

      <Section title={t('settings.management')}>
        <div className="flex items-center justify-between bg-surface px-4 py-3">
          <div className="flex min-w-0 flex-col">
            <span className="text-sm text-ink-2">{t('settings.managementEndpoint')}</span>
            <code className="truncate font-mono text-xs text-ink-3">
              {window.location.origin}/manage/mcp
            </code>
          </div>
          <CopyButton text={`${window.location.origin}/manage/mcp`} />
        </div>
        <p className="text-xs text-ink-3">{t('settings.managementHint')}</p>
      </Section>

      <Section title={t('settings.rawApi')}>
        <div className="flex flex-col gap-3 bg-surface p-4">
          <div className="flex gap-2">
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value)}
              className="h-9 w-24 bg-surface-2 px-2 font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              <option>GET</option>
              <option>POST</option>
              <option>DELETE</option>
            </select>
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              spellCheck={false}
              className="h-9 min-w-0 flex-1 bg-surface-2 px-3 font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
            <Button loading={running} onClick={runRaw}>
              <Terminal className="size-4" />
              {t('settings.run')}
            </Button>
          </div>
          {method !== 'GET' && method !== 'DELETE' && (
            <TextareaField
              value={bodyText}
              onChange={setBodyText}
              mono
              rows={3}
              placeholder="{}"
            />
          )}
          {rawResult && (
            <pre className="max-h-64 overflow-auto bg-surface-2 p-3 font-mono text-xs text-ink">
              {rawResult}
            </pre>
          )}
        </div>
      </Section>

      <Dialog open={keyOpen} onOpenChange={setKeyOpen} title={t('settings.createControlKey')}>
        <div className="flex flex-col gap-3">
          <TextField
            label={t('common.name')}
            value={keyName}
            onChange={setKeyName}
            required
            autoFocus
          />
          <SelectField
            label={t('settings.keyScope')}
            value={keyScope}
            onChange={(value) => setKeyScope(value as 'admin' | 'agent')}
            options={[
              { value: 'admin', label: t('settings.scopeAdmin') },
              { value: 'agent', label: t('settings.scopeAgent') },
            ]}
          />
          {keyScope === 'agent' && (
            <p className="text-xs text-ink-3">{t('settings.scopeAgentHint')}</p>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setKeyOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={createKey.isPending}
            disabled={!keyName}
            onClick={() =>
              createKey.mutate(
                { name: keyName, scope: keyScope },
                {
                  onSuccess: (result) => {
                    setKeyOpen(false)
                    setKeyName('')
                    setKeyScope('admin')
                    setSecret(result.secret ?? null)
                  },
                  onError: (error) => toast(error.message, 'error'),
                },
              )
            }
          >
            {t('common.create')}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(secret)}
        onOpenChange={(open) => !open && setSecret(null)}
        title="control key"
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
  )
}
