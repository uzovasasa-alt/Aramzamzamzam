import { useMemo, useState } from 'react';
import { api, ShiftRow, Vehicle } from '../api';
import { LineChart, Marker } from '../components/LineChart';
import { MapView } from '../components/MapView';
import { Empty, ErrorLine, FuelBar, StatusPill, toast } from '../components/ui';
import { fmt, go, isoDay, useApi, VEHICLE_KIND } from '../lib';

interface Telemetry {
  samples: { ts: string; fuelL: number | null; speedKmh: number | null; ignition: boolean | null; engineHours: number | null }[];
  events: { kind: 'DRAIN' | 'REFUEL'; startTs: string; endTs: string; fromL: number; toL: number; deltaL: number }[];
}

const RANGES = [
  { h: 24, label: 'Сутки' },
  { h: 72, label: '3 дня' },
  { h: 168, label: 'Неделя' },
];

export function VehiclePage({ id }: { id: string }) {
  const v = useApi<Vehicle>(`/vehicles/${id}`);
  const [hours, setHours] = useState(24);
  // Границы периода фиксируем при выборе диапазона, иначе запрос повторялся бы при каждой перерисовке
  const range = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - hours * 3_600_000).toISOString(), to: to.toISOString() };
  }, [hours]);
  const tel = useApi<Telemetry>(v.data?.trackerImei ? `/telemetry/vehicles/${id}` : null, range);
  const shifts = useApi<ShiftRow[]>('/shifts', { vehicleId: id, from: isoDay(new Date(Date.now() - 30 * 86_400_000)) });
  const bases = useApi<{ id: string; name: string; lat: number; lon: number; radiusM: number }[]>('/bases');

  if (v.error) return <div className="page"><ErrorLine error={v.error} /></div>;
  const d = v.data;
  if (!d) return <div className="page muted">Загрузка…</div>;

  const samples = tel.data?.samples ?? [];
  // Прореживание для графика — не больше ~600 точек
  const step = Math.max(1, Math.ceil(samples.length / 600));
  const pts = samples.filter((_, i) => i % step === 0);
  const markers: Marker[] = (tel.data?.events ?? []).map((e) => {
    const t = new Date(e.startTs).getTime();
    let idx = pts.findIndex((p) => new Date(p.ts).getTime() >= t);
    if (idx < 0) idx = pts.length - 1;
    return {
      x: idx,
      tone: e.kind === 'DRAIN' ? 'alert' : 'info',
      label: `${e.kind === 'DRAIN' ? 'Слив' : 'Заправка'} ${fmt.dt(e.startTs)}: ${e.fromL} → ${e.toL} л (${e.deltaL > 0 ? '+' : ''}${e.deltaL} л)`,
    };
  });

  const analyze = async () => {
    await api(`/telemetry/vehicles/${id}/analyze`, { method: 'POST' });
    toast({ text: 'Проверка выполнена. Новые нарушения появятся в разделе «Нарушения».', tone: 'info' });
  };

  return (
    <div className="page">
      <a className="back" href="#/vehicles">Вся техника</a>
      <header className="page-head">
        <div>
          <h1>{d.name}</h1>
          <div className="sub">{VEHICLE_KIND[d.kind]} · {d.regNumber ?? 'без номера'} · бак {fmt.l(d.tankCapacityL)} · норма {d.fuelNormLph ? `${d.fuelNormLph} л/моточас` : 'не задана'}</div>
        </div>
      </header>

      <div className="grid-2">
        <section className="panel">
          <h2>Последнее состояние</h2>
          <dl className="kv">
            <dt>Моточасы</dt><dd className="num">{fmt.n(d.lastEngineHours, 1)}</dd>
            <dt>Топливо</dt><dd className="num">{fmt.l(d.lastFuelL)}{d.lastFuelL != null && <span className="muted"> из {fmt.l(d.tankCapacityL)}</span>}</dd>
            <dt>Источник</dt><dd>{d.trackerImei ? `трекер ${d.trackerImei}, ${fmt.ago(d.lastSeenAt)}` : 'последняя закрытая смена'}</dd>
            {d.trackerImei && <><dt>Зажигание</dt><dd>{d.lastIgnition == null ? '—' : d.lastIgnition ? 'включено' : 'выключено'}</dd></>}
          </dl>
        </section>
        <section className="panel">
          <h2>На карте</h2>
          {d.lastLat != null && d.lastLon != null ? (
            <MapView height={220} circles={(bases.data ?? []).map((b) => ({ ...b, label: b.name }))}
              points={[{ lat: d.lastLat, lon: d.lastLon, label: `${d.name}, ${fmt.ago(d.lastSeenAt)}`, tone: 'vehicle' }]} />
          ) : <Empty>Координат пока нет.</Empty>}
        </section>
      </div>

      {d.trackerImei ? (
        <section className="panel">
          <header className="panel-head">
            <h2>Уровень топлива по датчику</h2>
            <div className="seg">
              {RANGES.map((r) => <button key={r.h} className={hours === r.h ? 'on' : ''} onClick={() => setHours(r.h)}>{r.label}</button>)}
            </div>
            <button className="btn btn-sm" onClick={analyze}>Проверить на сливы</button>
          </header>
          <ErrorLine error={tel.error} />
          {pts.length ? (
            <LineChart
              height={260}
              labels={pts.map((p) => fmt.dt(p.ts))}
              xLabel={(i) => fmt.time(pts[i].ts)}
              unit=" л"
              markers={markers}
              series={[
                { name: 'Топливо', color: 'var(--fuel)', values: pts.map((p) => p.fuelL) },
                { name: 'Скорость, км/ч', color: 'var(--track)', values: pts.map((p) => p.speedKmh), dashed: true },
              ]}
            />
          ) : <Empty>Трекер ещё не присылал данных за этот период. Проверьте адрес сервера и порт в его настройках.</Empty>}
        </section>
      ) : (
        <section className="panel note-panel">
          Датчики не подключены — контроль идёт по показаниям водителя и фото. Чтобы видеть уровень топлива онлайн и ловить сливы на стоянке,
          установите GPS-трекер с ДУТ или чтением CAN и укажите его IMEI в карточке техники.
        </section>
      )}

      <section className="panel">
        <h2>Смены за 30 дней</h2>
        <table className="table">
          <thead><tr><th>Начало</th><th>Водитель</th><th className="r">Наработка</th><th style={{ width: '30%' }}>Расход / норма</th><th>Статус</th></tr></thead>
          <tbody>
            {shifts.data?.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => go(`/shifts/${s.id}`)}>
                <td className="num">{fmt.dt(s.startedAt)}</td>
                <td>{s.driverName}</td>
                <td className="r num">{fmt.h(s.engineHours)}</td>
                <td><FuelBar fact={s.fuelConsumedL} norm={s.normL} /></td>
                <td><StatusPill status={s.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
