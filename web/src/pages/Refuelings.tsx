import { useState } from 'react';
import { api, Vehicle } from '../api';
import { Empty, ErrorLine, Field, Modal, toast } from '../components/ui';
import { fmt, go, isoDay, useApi } from '../lib';

interface Row {
  id: string; liters: number; occurredAt: string; source: string; note: string | null; shiftId: string | null;
  vehicleName: string; driverName: string | null; createdByName: string | null; photoCount: number;
}

const SOURCE: Record<string, string> = { MANUAL: 'Водитель', FUEL_TRUCK: 'Заправщик / ведомость', SENSOR: 'Датчик' };

export function RefuelingsPage() {
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 14 * 86_400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const list = useApi<Row[]>('/refuelings', { from, to: isoDay(new Date(new Date(to).getTime() + 86_400_000)) });
  const [adding, setAdding] = useState(false);
  const total = (list.data ?? []).reduce((s, r) => s + r.liters, 0);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Заправки</h1>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>Внести выдачу топлива</button>
      </header>
      <div className="filters">
        <label>С <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>по <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <span className="muted">Итого за период: <b className="num">{fmt.l(total)}</b></span>
      </div>
      <ErrorLine error={list.error} />
      <div className="panel panel-flush">
        <table className="table">
          <thead><tr><th>Когда</th><th>Техника</th><th>Водитель</th><th className="r">Литров</th><th>Кто внёс</th><th>Фото</th></tr></thead>
          <tbody>
            {list.data?.map((r) => (
              <tr key={r.id} className={r.shiftId ? 'clickable' : ''} onClick={() => r.shiftId && go(`/shifts/${r.shiftId}`)}>
                <td className="num">{fmt.dt(r.occurredAt)}</td>
                <td>{r.vehicleName}</td>
                <td>{r.driverName ?? <span className="muted">—</span>}</td>
                <td className="r num">{fmt.n(r.liters, 1)}</td>
                <td>{SOURCE[r.source]}{r.createdByName && r.source !== 'MANUAL' ? `, ${r.createdByName}` : ''}{r.note && <div className="muted small">{r.note}</div>}</td>
                <td className="num">{r.photoCount || <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.length === 0 && <Empty>За период заправок нет.</Empty>}
      </div>
      {adding && <AddRefuel onClose={() => setAdding(false)} onSaved={() => { setAdding(false); list.reload(); }} />}
    </div>
  );
}

function AddRefuel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const vehicles = useApi<Vehicle[]>('/vehicles');
  const [vehicleId, setVehicleId] = useState('');
  const [liters, setLiters] = useState('');
  const [at, setAt] = useState(() => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16));
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    try {
      await api('/refuelings', {
        method: 'POST',
        body: { vehicleId, liters: Number(liters.replace(',', '.')), occurredAt: new Date(at + ':00+03:00').toISOString(), source: 'FUEL_TRUCK', note: note || undefined },
      });
      toast({ text: 'Заправка внесена', tone: 'info' });
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <Modal title="Выдача топлива" onClose={onClose}>
      <p className="muted small">Внесите выдачу по ведомости заправщика. Если в это время у техники шла смена, заправка попадёт в её расчёт, и расхождение с данными водителя будет видно.</p>
      <Field label="Техника">
        <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
          <option value="">Выберите…</option>
          {vehicles.data?.filter((v) => v.isActive).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </Field>
      <div className="form-grid">
        <Field label="Литров"><input inputMode="decimal" value={liters} onChange={(e) => setLiters(e.target.value)} /></Field>
        <Field label="Время (МСК)"><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
      </div>
      <Field label="Примечание"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ведомость №…" /></Field>
      <ErrorLine error={err} />
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn btn-primary" disabled={!vehicleId || !liters} onClick={save}>Внести</button>
      </div>
    </Modal>
  );
}
