import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';

export interface CallSeriesPoint {
  bucket: string;
  total: number;
  success: number;
  error: number;
}

const VIEW_W = 100;
const VIEW_H = 40;

function formatTime(value: string, locale: string, bucketSeconds: number): string {
  const date = new Date(value);
  if (bucketSeconds >= 86_400) {
    return date.toLocaleString(locale, { month: 'numeric', day: 'numeric' });
  }
  return date.toLocaleString(locale, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Minimal dependency-free line chart: area under the total line (accent) with
 * an error line (danger), y-axis counts, time ticks and a hover crosshair.
 * Text lives in HTML overlays so it never distorts with the stretched SVG.
 */
export function CallChart({
  points,
  bucketSeconds,
}: {
  points: CallSeriesPoint[];
  bucketSeconds: number;
}) {
  const { t, locale } = useI18n();
  const [hover, setHover] = useState<number | null>(null);

  const max = useMemo(() => Math.max(1, ...points.map((point) => point.total)), [points]);
  const y = (value: number) => VIEW_H - (value / max) * VIEW_H;
  const x = (index: number) =>
    points.length <= 1 ? VIEW_W / 2 : (index / (points.length - 1)) * VIEW_W;

  const { areaPoints, totalPoints, errorPoints } = useMemo(() => {
    if (points.length === 0) return { areaPoints: '', totalPoints: '', errorPoints: '' };
    const line = (key: 'total' | 'error') =>
      points.map((point, index) => `${x(index)},${y(point[key])}`).join(' ');
    const total = line('total');
    const area = `${total} ${x(points.length - 1)},${VIEW_H} ${x(0)},${VIEW_H}`;
    return { areaPoints: area, totalPoints: total, errorPoints: line('error') };
  }, [points, max]);

  if (points.length === 0) {
    return <div className="text-xs text-ink-3">—</div>;
  }

  const xTicks = [
    ...new Set(
      [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round((points.length - 1) * fraction)),
    ),
  ];
  const hoverPoint = hover === null ? null : points[hover];
  const hoverX = hover === null ? null : x(hover);

  return (
    <div>
      <div className="flex">
        <div className="flex w-10 shrink-0 flex-col justify-between pr-2 text-right font-mono text-[10px] leading-none text-ink-3">
          <span>{max}</span>
          <span>{Math.round(max / 2)}</span>
          <span>0</span>
        </div>
        <div
          className="relative h-44 flex-1 cursor-crosshair select-none"
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            setHover(Math.round(fraction * (points.length - 1)));
          }}
          onPointerLeave={() => setHover(null)}
        >
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            {[0, 0.5, 1].map((fraction) => (
              <line
                key={fraction}
                x1="0"
                x2={VIEW_W}
                y1={VIEW_H * fraction}
                y2={VIEW_H * fraction}
                className="stroke-ink-3/20"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {areaPoints && (
              <polygon points={areaPoints} className="fill-[var(--mch-accent)] opacity-[0.08]" />
            )}
            <polyline
              points={totalPoints}
              className="fill-none stroke-[var(--mch-accent)] stroke-2"
              vectorEffect="non-scaling-stroke"
            />
            <polyline
              points={errorPoints}
              className="fill-none stroke-[var(--mch-danger)] stroke-[1.5]"
              vectorEffect="non-scaling-stroke"
            />
            {hoverX !== null && (
              <line
                x1={hoverX}
                x2={hoverX}
                y1="0"
                y2={VIEW_H}
                className="stroke-ink-3/40"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {hoverPoint && hoverX !== null && (
            <div
              className="pointer-events-none absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${(hoverX / VIEW_W) * 100}%` }}
            >
              <div className="bg-surface px-2.5 py-1.5 shadow-lg shadow-black/20">
                <div className="whitespace-nowrap font-mono text-[10px] text-ink-3">
                  {formatTime(hoverPoint.bucket, locale, bucketSeconds)}
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap font-mono text-[11px]">
                  <span className="text-[var(--mch-accent)]">●</span>
                  <span className="text-ink">{hoverPoint.total}</span>
                  <span className="text-ink-3">{t('calls.calls')}</span>
                  <span className="text-[var(--mch-danger)]">●</span>
                  <span className="text-ink">{hoverPoint.error}</span>
                  <span className="text-ink-3">{t('calls.errors')}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between pl-10 font-mono text-[10px] text-ink-3">
        {xTicks.map((index) => (
          <span key={index}>{formatTime(points[index].bucket, locale, bucketSeconds)}</span>
        ))}
      </div>
    </div>
  );
}
