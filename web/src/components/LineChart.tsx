/**
 * Простой SVG-график без библиотек: несколько линий по времени/категориям, подсказка при наведении,
 * необязательные отметки событий (сливы/заправки). Ширина подстраивается под контейнер.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

export interface Series { name: string; color: string; values: (number | null)[]; dashed?: boolean }
export interface Marker { x: number; label: string; tone: 'alert' | 'info' }

export function LineChart({
  labels, series, height = 220, unit = '', markers = [], xLabel,
}: {
  labels: string[]; series: Series[]; height?: number; unit?: string; markers?: Marker[]; xLabel?: (i: number) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [n > 0]);

  const pad = { l: 44, r: 12, t: 12, b: 26 };
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const { min, max, ticks } = useMemo(() => niceScale(all.length ? Math.min(0, ...all) : 0, all.length ? Math.max(...all) : 1), [all.join(',')]);
  const x = (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (w - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min || 1)) * (height - pad.t - pad.b);

  if (!n) return <div ref={ref} className="chart"><div className="empty">Нет данных за период</div></div>;
  const labelEvery = Math.max(1, Math.ceil(n / Math.floor((w - 60) / 70)));

  return (
    <div ref={ref} className="chart" onMouseLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label={series.map((s) => s.name).join(', ')}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left - pad.l) / (w - pad.l - pad.r)) * (n - 1));
          setHover(i >= 0 && i < n ? i : null);
        }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="chart-tick">{t.toLocaleString('ru-RU')}</text>
          </g>
        ))}
        {labels.map((l, i) => i % labelEvery === 0 && (
          <text key={i} x={x(i)} y={height - 6} textAnchor="middle" className="chart-tick">{xLabel ? xLabel(i) : l}</text>
        ))}
        {markers.map((m, k) => (
          <g key={k}>
            <line x1={x(m.x)} x2={x(m.x)} y1={pad.t} y2={height - pad.b} className={`chart-marker chart-marker-${m.tone}`} />
          </g>
        ))}
        {series.map((s) => (
          <path key={s.name} d={path(s.values, x, y)} fill="none" stroke={s.color} strokeWidth={2}
            strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} className="chart-cursor" />
            {series.map((s) => s.values[hover] != null && (
              <circle key={s.name} cx={x(hover)} cy={y(s.values[hover]!)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.name}><i style={{ background: s.color }} className={s.dashed ? 'dashed' : ''} />{s.name}
            {hover != null && s.values[hover] != null && <b className="num"> {s.values[hover]!.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}{unit}</b>}
          </span>
        ))}
        {hover != null && <span className="muted">{labels[hover]}</span>}
      </div>
      {markers.length > 0 && (
        <ul className="chart-events">
          {markers.map((m, k) => <li key={k} className={`ev-${m.tone}`}>{m.label}</li>)}
        </ul>
      )}
    </div>
  );
}

function path(vals: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  let d = '';
  let pen = false;
  vals.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

function niceScale(lo: number, hi: number) {
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = min; t <= max + step / 2; t += step) ticks.push(Math.round(t * 100) / 100);
  return { min, max, ticks };
}
