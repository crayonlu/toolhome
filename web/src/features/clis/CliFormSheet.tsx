import { useEffect, useState } from 'react';
import { useCredentials } from '../../app/queries';
import { useI18n } from '../../i18n';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { FieldGroup, TextareaField, TextField } from '../../components/ui/Field';
import { SelectField } from '../../components/ui/SelectField';
import { Toggle } from '../../components/ui/Toggle';
import type { CliRecord } from '../../api/types';
import { parseArgvText } from './argv';

export interface CliFormValue {
  slug: string;
  name: string;
  command: string;
  executionMode: 'host' | 'docker';
  entrypoint: string | null;
  authStrategy: 'none' | 'azure-service-principal' | 'tailscale-auth-key';
  containerVolumes: { source: string; target: string; readOnly: boolean }[];
  allowList: { allow: string[][]; deny: string[][] };
  interactive: boolean;
  credentialId: string | null;
  probe: { command: string; args: string[] } | null;
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

const parseRules = (text: string): string[][] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.split(/\s+/));

const formatRules = (rules: string[][]): string => rules.map((rule) => rule.join(' ')).join('\n');

export function CliFormSheet({
  open,
  onOpenChange,
  initial,
  onSubmit,
  submitting,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: CliRecord;
  onSubmit: (value: CliFormValue) => void;
  submitting: boolean;
  title: string;
}) {
  const { t } = useI18n();
  const { data: credentials } = useCredentials();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [executionMode, setExecutionMode] = useState<'host' | 'docker'>('host');
  const [entrypoint, setEntrypoint] = useState('');
  const [authStrategy, setAuthStrategy] = useState<
    'none' | 'azure-service-principal' | 'tailscale-auth-key'
  >('none');
  const [volumeSource, setVolumeSource] = useState('');
  const [volumeTarget, setVolumeTarget] = useState('');
  const [allowText, setAllowText] = useState('');
  const [denyText, setDenyText] = useState('');
  const [interactive, setInteractive] = useState(false);
  const [credentialId, setCredentialId] = useState('');
  const [probeEnabled, setProbeEnabled] = useState(false);
  const [probeCommand, setProbeCommand] = useState('');
  const [probeArgs, setProbeArgs] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [timeoutMs, setTimeoutMs] = useState('60000');
  const [maxOutputBytes, setMaxOutputBytes] = useState(String(64 * 1024));

  useEffect(() => {
    if (!open) return;
    setSlug(initial?.slug ?? '');
    setName(initial?.name ?? '');
    setCommand(initial?.command ?? '');
    setExecutionMode(initial?.executionMode ?? 'host');
    setEntrypoint(initial?.entrypoint ?? '');
    setAuthStrategy(initial?.authStrategy ?? 'none');
    setVolumeSource(initial?.containerVolumes[0]?.source ?? '');
    setVolumeTarget(initial?.containerVolumes[0]?.target ?? '');
    setAllowText(formatRules(initial?.allowList.allow ?? []));
    setDenyText(formatRules(initial?.allowList.deny ?? []));
    setInteractive(initial?.interactive ?? false);
    setCredentialId(initial?.credentialId ?? '');
    setProbeEnabled(initial?.probe !== null && initial?.probe !== undefined);
    setProbeCommand(initial?.probe?.command ?? '');
    setProbeArgs(initial?.probe ? initial.probe.args.join(' ') : '');
    setEnabled(initial?.enabled ?? true);
    setTimeoutMs(String(initial?.timeoutMs ?? 60_000));
    setMaxOutputBytes(String(initial?.maxOutputBytes ?? 64 * 1024));
  }, [open, initial]);

  const submit = () => {
    onSubmit({
      slug,
      name,
      command,
      executionMode,
      entrypoint: entrypoint || null,
      authStrategy,
      containerVolumes:
        volumeSource && volumeTarget
          ? [{ source: volumeSource, target: volumeTarget, readOnly: false }]
          : [],
      allowList: { allow: parseRules(allowText), deny: parseRules(denyText) },
      interactive,
      credentialId: credentialId || null,
      probe:
        probeEnabled && probeCommand
          ? { command: probeCommand, args: parseArgvText(probeArgs) }
          : null,
      enabled,
      timeoutMs: Number(timeoutMs) || 60_000,
      maxOutputBytes: Number(maxOutputBytes) || 64 * 1024,
    });
  };

  const credentialOptions = [
    { value: '', label: t('common.empty') },
    ...(credentials ?? []).map((credential) => ({
      value: credential.id,
      label: `${credential.name} (${credential.type})`,
    })),
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title}>
      <FieldGroup>
        <TextField label={t('common.name')} value={name} onChange={setName} required />
        <TextField
          label={t('common.slug')}
          value={slug}
          onChange={setSlug}
          mono
          disabled={initial !== undefined}
          required
        />
        <TextField label={t('cli.command')} value={command} onChange={setCommand} mono required />
        <SelectField
          label={t('cli.executionMode')}
          value={executionMode}
          onChange={(value) => setExecutionMode(value as 'host' | 'docker')}
          options={[
            { value: 'host', label: t('cli.modeHost') },
            { value: 'docker', label: t('cli.modeDocker') },
          ]}
        />
        {executionMode === 'docker' && (
          <>
            <TextField
              label={t('cli.entrypoint')}
              value={entrypoint}
              onChange={setEntrypoint}
              mono
              placeholder="gh"
            />
            <SelectField
              label="Authentication bootstrap"
              value={authStrategy}
              onChange={(value) =>
                setAuthStrategy(value as 'none' | 'azure-service-principal' | 'tailscale-auth-key')
              }
              options={[
                { value: 'none', label: 'None' },
                { value: 'azure-service-principal', label: 'Azure service principal' },
                { value: 'tailscale-auth-key', label: 'Tailscale auth key' },
              ]}
            />
            <TextField
              label="Docker named volume source"
              value={volumeSource}
              onChange={setVolumeSource}
              mono
              placeholder="toolhome-cli-state"
            />
            <TextField
              label="State volume target"
              value={volumeTarget}
              onChange={setVolumeTarget}
              mono
              placeholder="/root/.config/tool"
            />
          </>
        )}
        <TextareaField
          label={t('cli.allowRules')}
          value={allowText}
          onChange={setAllowText}
          mono
          placeholder={'account show\nvm *'}
        />
        <TextareaField
          label={t('cli.denyRules')}
          value={denyText}
          onChange={setDenyText}
          mono
          placeholder={'login'}
        />
        <SelectField
          label={t('cli.credential')}
          value={credentialId}
          onChange={setCredentialId}
          options={credentialOptions}
        />
        <TextField label="timeoutMs" value={timeoutMs} onChange={setTimeoutMs} type="number" />
        <TextField
          label="maxOutputBytes"
          value={maxOutputBytes}
          onChange={setMaxOutputBytes}
          type="number"
        />
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-2">{t('cli.interactive')}</span>
          <Toggle checked={interactive} onChange={setInteractive} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-2">{t('cli.enable')}</span>
          <Toggle checked={enabled} onChange={setEnabled} />
        </div>
      </FieldGroup>

      <div className="mt-4 border-t border-ink-3/10 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-ink-2">{t('cli.probe')}</span>
          <Toggle checked={probeEnabled} onChange={setProbeEnabled} />
        </div>
        {probeEnabled && (
          <FieldGroup>
            <TextField
              label={t('cli.probeCommand')}
              value={probeCommand}
              onChange={setProbeCommand}
              mono
            />
            <TextField label={t('cli.probeArgs')} value={probeArgs} onChange={setProbeArgs} mono />
            <p className="text-xs text-ink-3">{t('cli.probeHint')}</p>
          </FieldGroup>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          loading={submitting}
          disabled={!name || !slug || !command}
          onClick={submit}
        >
          {t('common.save')}
        </Button>
      </div>
    </Sheet>
  );
}
