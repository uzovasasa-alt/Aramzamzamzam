import { useState } from 'react';
import { api, AnomalyRow, Vehicle } from '../api';
import { Empty, ErrorLine, SeverityDot } from '../components/ui';
import { fmt, go, useApi } from '../lib';

export function AnomaliesPage() {
  const [status, setStatus] = useState('NEW');
  const [severity, setSeverity] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const vehicles = useApi<Vehicle[]>('/vehicles');
  const types = useApi<Record<string, string>>('/anomalies/types');
  const list = useApi<AnomalyRow[]>('/anomalies', { status, severity, vehicleId });

  const resolve = async (a: AnomalyRow, st: 'CONFIRMED' | 'DISMISSED') => {
    const comment = st === 'DISMISSED' ? window.prompt('Почему это не нарушение? (необязательно)') ?? undefined : undefined;
    await api(`/anomalies/${a.id}/resolve`, { method: 'POST', body: { status: st, comment } });
    list.reload();
  };

  return (
    <div className="page">
      <header className="page-head"><h1>Нарушения</h1></header>
      <div className="filters">
        <div className="seg" role="group" aria-label="Статус">
          {[['NEW', 'Новые'], ['CONFIRMED', 'Подтверждённые'], ['DISMISSED', 'Снятые'], ['', 'Все']].map(([v, l]) => (
            <button key={v} className={status === v ? 'on' : ''} onClick={() => setStatus(v)}>{l}</button>
          ))}
        </div>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Важность">
          <option value="">Любая важность</option>
          <option value="HIGH">Высокая</option>
          <option value="MEDIUM">Средняя</option>
          <option value="LOW">Низкая</option>
        </select>
        <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} aria-label="Техника">
          <option value="">Вся техника</option>
          {vehicles.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </div>
      <ErrorLine error={list.error} />
      <div className="panel panel-flush">
        <ul className="anomalies anomalies-wide">
          {list.data?.map((a) => (
            <li key={a.id} className={`an an-${a.status.toLowerCase()}`}>
              <SeverityDot severity={a.severity} />
              <div className="an-text">
                <div className="an-title">{types.data?.[a.type] ?? a.type}</div>
                <div>{a.message}</div>
                <div className="muted small">
                  {a.vehicleName ?? '—'}{a.driverName ? `, ${a.driverName}` : ''} · {fmt.dt(a.occurredAt)}
                  {a.status !== 'NEW' && ` · ${a.status === 'CONFIRMED' ? 'подтвердил' : 'снял'} ${a.resolvedByName ?? ''}${a.resolutionComment ? `: ${a.resolutionComment}` : ''}`}
                </div>
              </div>
              <div className="an-actions">
                {a.shiftId && <button className="btn btn-sm" onClick={() => go(`/shifts/${a.shiftId}`)}>Открыть смену</button>}
                {!a.shiftId && a.vehicleId && <button className="btn btn-sm" onClick={() => go(`/vehicles/${a.vehicleId}`)}>График датчика</button>}
                {a.status === 'NEW' && (
                  <>
                    <button className="btn btn-sm" onClick={() => resolve(a, 'DISMISSED')}>Не нарушение</button>
                    <button className="btn btn-sm btn-danger" onClick={() => resolve(a, 'CONFIRMED')}>Подтвердить</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        {list.data?.length === 0 && <Empty>{status === 'NEW' ? 'Новых нарушений нет.' : 'Ничего не найдено.'}</Empty>}
      </div>
    </div>
  );
}
