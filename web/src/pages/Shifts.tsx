import { useState } from 'react';
import { auth, ShiftRow, User, Vehicle } from '../api';
import { Empty, ErrorLine, FuelBar, StatusPill } from '../components/ui';
import { fmt, go, isoDay, routeQuery, useApi, useRoute } from '../lib';

export function ShiftsPage() {
  const q = routeQuery(useRoute());
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 14 * 86_400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [vehicleId, setVehicleId] = useState('');
  const [driverId, setDriverId] = useState(q.get('driver') ?? '');
  const [status, setStatus] = useState('');
  const [onlyAnomalies, setOnlyAnomalies] = useState(false);

  const vehicles = useApi<Vehicle[]>('/vehicles');
  const users = useApi<User[]>('/users');
  const toNext = isoDay(new Date(new Date(to).getTime() + 86_400_000));
  const shifts = useApi<ShiftRow[]>('/shifts', { from, to: toNext, vehicleId, driverId, status, withAnomalies: onlyAnomalies || undefined });

  const csvHref = `/api/reports/shifts.csv?from=${from}&to=${toNext}`;
  const downloadCsv = async () => {
    // Файл скачиваем через fetch, потому что нужен заголовок авторизации
    const r = await fetch(csvHref, { headers: { authorization: `Bearer ${auth.token}`, ...(auth.orgId ? { 'x-org-id': auth.orgId } : {}) } });
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `smeny_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Смены</h1>
        <button className="btn" onClick={downloadCsv}>Скачать для Excel</button>
      </header>
      <div className="filters">
        <label>С <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>по <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} aria-label="Техника">
          <option value="">Вся техника</option>
          {vehicles.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select value={driverId} onChange={(e) => setDriverId(e.target.value)} aria-label="Водитель">
          <option value="">Все водители</option>
          {users.data?.filter((u) => u.role === 'DRIVER').map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Статус">
          <option value="">Любой статус</option>
          <option value="OPEN">Идёт</option>
          <option value="CLOSED">Ждёт проверки</option>
          <option value="APPROVED">Принята</option>
          <option value="REJECTED">Отклонена</option>
        </select>
        <label className="check"><input type="checkbox" checked={onlyAnomalies} onChange={(e) => setOnlyAnomalies(e.target.checked)} /> Только с нарушениями</label>
      </div>
      <ErrorLine error={shifts.error} />
      <div className="panel panel-flush">
        <table className="table">
          <thead>
            <tr>
              <th>Начало</th><th>Техника</th><th>Водитель</th><th className="r">Наработка</th>
              <th style={{ width: '24%' }}>Расход / норма</th><th className="r">Нарушений</th><th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {shifts.data?.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => go(`/shifts/${s.id}`)}>
                <td className="num">{fmt.dt(s.startedAt)}{!s.startInZone && <span className="flag" title="Старт не на базе">вне базы</span>}</td>
                <td>{s.vehicleName}</td>
                <td>{s.driverName}</td>
                <td className="r num">{s.endedAt ? fmt.h(s.engineHours) : <span className="muted">идёт</span>}</td>
                <td>{s.endedAt ? <FuelBar fact={s.fuelConsumedL} norm={s.normL} /> : <span className="muted">—</span>}</td>
                <td className={`r num ${s.anomalyCount ? 'dev-over' : 'muted'}`}>{s.anomalyCount || '—'}</td>
                <td><StatusPill status={s.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {shifts.data?.length === 0 && <Empty>Смен с такими условиями нет. Измените период или фильтры.</Empty>}
      </div>
    </div>
  );
}
