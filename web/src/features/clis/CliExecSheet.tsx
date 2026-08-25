import { useEffect, useRef, useState } from 'react';
import { streamNdjson } from '../../api/client';
import { useI18n } from '../../i18n';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { FieldGroup, TextareaField } from '../../components/ui/Field';
import type { CliRecord } from '../../api/types';
import { parseArgvText } from './argv';

interface Frame {
  type: 'stdout' | 'stderr' | 'exit';
  data?: string;
  code?: number | null;
  durationMs?: number;
  result?: 'ok' | 'error' | 'timeout';
  truncated?: boolean;
}

const frameTone: Record<'stdout' | 'stderr', string> = {
  stdout: 'text-ink',
  stderr: 'text-danger',
};

export function CliExecSheet({
  open,
  onOpenChange,
  cli,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cli: CliRecord;
}) {
  const { t } = useI18n();
  const [argvText, setArgvText] = useState('');
  const [frames, setFrames] = useState<Frame[]>([]);
  const [running, setRunning] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setArgvText('');
      setFrames([]);
      setRunning(false);
      return;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  }, [open]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [frames]);

  const run = async () => {
    const argv = parseArgvText(argvText);
    if (argv.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setFrames([]);
    try {
      await streamNdjson<Frame>(`/cli/${cli.slug}/exec`, { argv }, (frame) => {
        setFrames((current) => [...current, frame]);
      }, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      setFrames([
        { type: 'stderr', data: error instanceof Error ? error.message : String(error) },
        { type: 'exit', code: null, result: 'error', durationMs: 0 },
      ]);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };

  const exit = frames.find((frame) => frame.type === 'exit');

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`${cli.name} · exec`}>
      <FieldGroup>
        <TextareaField
          label={t('cli.argv')}
          value={argvText}
          onChange={setArgvText}
          mono
          placeholder={'account show\n-o\ntable'}
        />
        <p className="text-xs text-ink-3">{t('cli.execHint')}</p>
        <div>
          <Button variant="primary" loading={running} disabled={!argvText.trim()} onClick={run}>
            {t('cli.run')}
          </Button>
        </div>
      </FieldGroup>

      {(frames.length > 0 || running) && (
        <div className="mt-4">
          <div
            ref={logRef}
            className="max-h-72 overflow-y-auto bg-surface-2 p-3 font-mono text-xs leading-relaxed"
          >
            {running && frames.length === 0 ? (
              <span className="text-ink-3">{t('common.loading')}</span>
            ) : (
              frames.map((frame, index) =>
                frame.type === 'exit' ? (
                  <div key={index} className="mt-2 border-t border-ink-3/10 pt-2 text-ink-2">
                    exit · code {String(frame.code)} · {frame.result ?? ''} ·{' '}
                    {frame.durationMs ?? 0}ms
                    {frame.truncated ? ` · ${t('cli.truncated')}` : ''}
                  </div>
                ) : (
                  <pre key={index} className={`whitespace-pre-wrap ${frameTone[frame.type]}`}>
                    {frame.data}
                  </pre>
                ),
              )
            )}
          </div>
          {exit !== undefined && (
            <div className="mt-1 text-right text-xs text-ink-3">
              {t('cli.exitCode')}: {String(exit.code ?? '')} ({exit.result}) ·{' '}
              {exit.durationMs ?? 0}ms
              {exit?.truncated ? ` · ${t('cli.truncated')}` : ''}
            </div>
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {t('common.close')}
        </Button>
      </div>
    </Sheet>
  );
}
