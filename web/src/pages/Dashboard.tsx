import { useState } from 'react';
import { AnomalyRow } from '../api';
import { LineChart } from '../components/LineChart';
import { Empty, ErrorLine, FuelBar, SeverityDot } from '../components/ui';
import { fmt, go, isoDay, useApi } from '../lib';

interface Agg { shifts: number; engineHours: number; fuelL: number; normL: number; refueledL: number; anomalies: number; lph: number | null; overNormPct: number | null }
interface Summary {
  totals: Agg; openShifts: number; pendingReview: number;
  byVehicle: (Agg & { id: string; name: string; normLph: number | null })[];
  byDriver: (Agg & { id: string; name: string })[];
  daily: { day: string; fuelL: number; normL: number; engineHours: number }[];
}

const PERIODS = [
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: 'Сезон' },
];

export function DashboardPage() {
  const [days, setDays] = useState(30);
  const to = new Date(Date.now() + 86_400_000);
  const from = new Date(to.getTime() - (days + 1) * 86_400_000);
  const s = useApi<Summary>('/reports/summary', { from: isoDay(from), to: isoDay(to) });
  const fresh = useApi<AnomalyRow[]>('/anomalies', { status: 'NEW', limit: '6' });
  const t = s.data?.totals;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Сводка</h1>
        <div className="seg" role="group" aria-label="Период">
          {PERIODS.map((p) => (
            <button key={p.days} className={days === p.days ? 'on' : ''} onClick={() => setDays(p.days)}>{p.label}</button>
          ))}
        </div>
      </header>
      <ErrorLine error={s.error} />

      <section className="ledger">
        <div className="ledger-main">
          <div className="ledger-caption">Израсходовано топлива за период</div>
          <div className="ledger-figure num">{fmt.n(t?.fuelL ?? null, 0)}<small> л</small></div>
          <FuelBar fact={t?.fuelL ?? null} norm={t?.normL ?? null} />
          <div className="ledger-sub">Норма по наработке — {fmt.l(t?.normL)}; средний расход {fmt.n(t?.lph ?? null, 1)} л/моточас</div>
        </div>
        <dl className="ledger-side">
          <div><dt>Смен закрыто</dt><dd className="num">{t?.shifts ?? '—'}</dd></div>
          <div><dt>Наработка</dt><dd className="num">{fmt.h(t?.engineHours)}</dd></div>
          <div className="link-cell" onClick={() => go('/shifts')}><dt>Ждут проверки</dt><dd className="num">{s.data?.pendingReview ?? '—'}</dd></div>
          <div className="link-cell" onClick={() => go('/shifts')}><dt>Сейчас в работе</dt><dd className="num">{s.data?.openShifts ?? '—'}</dd></div>
        </dl>
      </section>

      <div className="grid-2">
        <section className="panel">
          <h2>Расход по дням</h2>
          <LineChart
            labels={(s.data?.daily ?? []).map((d) => d.day)}
            xLabel={(i) => s.data!.daily[i].day.slice(8, 10) + '.' + s.data!.daily[i].day.slice(5, 7)}
            unit=" л"
            series={[
              { name: 'Факт', color: 'var(--fuel)', values: (s.data?.daily ?? []).map((d) => d.fuelL) },
              { name: 'Норма', color: 'var(--ink-3)', values: (s.data?.daily ?? []).map((d) => d.normL), dashed: true },
            ]}
          />
        </section>
        <section className="panel">
          <h2>Новые нарушения</h2>
          {fresh.data?.length === 0 && <Empty>Новых нарушений нет. Всё проверено.</Empty>}
          <ul className="feed">
            {fresh.data?.map((a) => (
              <li key={a.id} onClick={() => go(a.shiftId ? `/shifts/${a.shiftId}` : '/anomalies')}>
                <SeverityDot severity={a.severity} />
                <div>
                  <div className="feed-msg">{a.message}</div>
                  <div className="muted small">{a.vehicleName ?? '—'}{a.driverName ? `, ${a.driverName}` : ''} · {fmt.dt(a.occurredAt)}</div>
                </div>
              </li>
            ))}
          </ul>
          {!!fresh.data?.length && <a className="more" href="#/anomalies">Все нарушения</a>}
        </section>
      </div>

      <section className="panel">
        <h2>Техника: факт против нормы</h2>
        <table className="table">
          <thead><tr><th>Техника</th><th className="r">Смен</th><th className="r">Наработка</th><th className="r">л/моточас</th><th style={{ width: '34%' }}>Расход и норма</th><th className="r">Нарушений</th></tr></thead>
          <tbody>
            {s.data?.byVehicle.map((v) => (
              <tr key={v.id} className="clickable" onClick={() => go(`/vehicles/${v.id}`)}>
                <td>{v.name}</td>
                <td className="r num">{v.shifts}</td>
                <td className="r num">{fmt.h(v.engineHours)}</td>
                <td className="r num">{fmt.n(v.lph, 1)}{v.normLph ? <span className="muted"> / {fmt.n(v.normLph, 1)}</span> : null}</td>
                <td><FuelBar fact={v.fuelL} norm={v.normL || null} /></td>
                <td className={`r num ${v.anomalies ? 'dev-over' : ''}`}>{v.anomalies}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {s.data?.byVehicle.length === 0 && <Empty>За период нет закрытых смен.</Empty>}
      </section>

      <section className="panel">
        <h2>Водители</h2>
        <table className="table">
          <thead><tr><th>Водитель</th><th className="r">Смен</th><th className="r">Наработка</th><th className="r">Расход</th><th className="r">Отклонение</th><th className="r">Нарушений</th></tr></thead>
          <tbody>
            {s.data?.byDriver.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => go(`/shifts?driver=${d.id}`)}>
                <td>{d.name}</td>
                <td className="r num">{d.shifts}</td>
                <td className="r num">{fmt.h(d.engineHours)}</td>
                <td className="r num">{fmt.l(d.fuelL)}</td>
                <td className={`r num ${(d.overNormPct ?? 0) > 15 ? 'dev-over' : ''}`}>{fmt.pct(d.overNormPct)}</td>
                <td className={`r num ${d.anomalies ? 'dev-over' : ''}`}>{d.anomalies}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
