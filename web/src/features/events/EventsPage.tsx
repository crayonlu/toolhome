import { ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useEvents } from '../../app/queries';
import { useI18n } from '../../i18n';
import { usePlane, type Plane } from '../../app/plane';
import { Badge, EmptyState, type Tone } from '../../components/ui/Badge';
import { SelectField } from '../../components/ui/SelectField';
import type { EventLevel } from '../../api/types';

const levelTone: Record<EventLevel, Tone> = {
  info: 'neutral',
  warn: 'warning',
  error: 'danger',
};

type EventPlane = Plane | 'all';

export function EventsPage() {
  const { t } = useI18n();
  const { plane: globalPlane } = usePlane();
  const [level, setLevel] = useState<string>('');
  const [plane, setPlane] = useState<EventPlane>(globalPlane);
  const { data: events, isLoading } = useEvents(
    200,
    level === '' ? undefined : (level as EventLevel),
    plane === 'all' ? undefined : plane,
  );

  // Follow the sidebar switch unless the user picked an explicit filter.
  useEffect(() => {
    setPlane(globalPlane);
  }, [globalPlane]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">{t('nav.events')}</h1>
        <div className="grid grid-cols-2 gap-2 sm:w-72">
          <SelectField
            label={t('common.type')}
            value={plane}
            onChange={(value) => setPlane(value as EventPlane)}
            options={[
              { value: 'all', label: t('common.all') },
              { value: 'mcp', label: 'MCP' },
              { value: 'cli', label: 'CLI' },
            ]}
          />
          <SelectField
            label={t('common.level')}
            value={level}
            onChange={setLevel}
            options={[
              { value: '', label: t('common.all') },
              { value: 'info', label: 'info' },
              { value: 'warn', label: 'warn' },
              { value: 'error', label: 'error' },
            ]}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-ink-3">{t('common.loading')}</div>
      ) : events && events.length > 0 ? (
        <div className="flex flex-col divide-y divide-ink-3/10">
          {events.map((event) => (
            <div key={event.id} className="flex items-start gap-3 px-1 py-2">
              <Badge tone={levelTone[event.level]}>{event.level}</Badge>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink">{event.message}</div>
                <div className="font-mono text-xs text-ink-3">{event.type}</div>
              </div>
              <span className="shrink-0 text-xs tabular-nums text-ink-3">
                {new Date(event.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={<ScrollText className="size-8" />} title={t('common.empty')} />
      )}
    </div>
  );
}
