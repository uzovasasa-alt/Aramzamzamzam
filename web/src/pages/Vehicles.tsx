import { useState } from 'react';
import { api, auth, Vehicle } from '../api';
import { Empty, ErrorLine, Field, Modal, toast } from '../components/ui';
import { fmt, go, useApi, VEHICLE_KIND } from '../lib';

/** Готовые настройки расшифровки датчиков — чтобы не писать JSON руками */
export const SENSOR_PRESETS: Record<string, { label: string; protocol: string; mapping: Record<string, unknown> }> = {
  teltonika_can: {
    label: 'Teltonika + CAN (уровень топлива в %, моточасы в минутах)',
    protocol: 'TELTONIKA',
    mapping: { fuel: { param: 'io89', unit: 'percent' }, engineHours: { param: 'io102', unit: 'minutes' }, ignition: { param: 'io239' } },
  },
  teltonika_lls: {
    label: 'Teltonika + ДУТ по RS-485 (нужна тарировка)',
    protocol: 'TELTONIKA',
    mapping: { fuel: { param: 'io201', unit: 'raw', calibration: [[0, 0], [4095, 400]] }, ignition: { param: 'io239' } },
  },
  wialon: {
    label: 'Galileosky / Arnavi по Wialon IPS (fuel_lvl, eng_hours)',
    protocol: 'WIALON_IPS',
    mapping: { fuel: { param: 'fuel_lvl', unit: 'liters' }, engineHours: { param: 'eng_hours', unit: 'hours' }, ignition: { param: 'ign' } },
  },
  http: {
    label: 'Своё устройство (ESP32 + CAN) по HTTP',
    protocol: 'HTTP',
    mapping: { fuel: { param: 'fuel_l', unit: 'liters' }, engineHours: { param: 'engine_hours', unit: 'hours' }, ignition: { param: 'ignition' } },
  },
};

export function VehiclesPage() {
  const list = useApi<Vehicle[]>('/vehicles');
  const [edit, setEdit] = useState<Partial<Vehicle> | null>(null);
  const isAdmin = auth.user?.role === 'ADMIN' || auth.user?.role === 'SUPERADMIN';

  return (
    <div className="page">
      <header className="page-head">
        <h1>Техника</h1>
        {isAdmin && <button className="btn btn-primary" onClick={() => setEdit({ kind: 'TRACTOR', tankCapacityL: 200 })}>Добавить технику</button>}
      </header>
      <ErrorLine error={list.error} />
      <div className="panel panel-flush">
        <table className="table">
          <thead>
            <tr><th>Название</th><th>Тип</th><th className="r">Бак</th><th className="r">Норма</th><th className="r">Моточасы</th><th className="r">Топливо</th><th>Датчики</th>{isAdmin && <th />}</tr>
          </thead>
          <tbody>
            {list.data?.map((v) => (
              <tr key={v.id} className={`clickable ${v.isActive ? '' : 'inactive'}`} onClick={() => go(`/vehicles/${v.id}`)}>
                <td>{v.name}<div className="muted small">{v.regNumber}</div></td>
                <td>{VEHICLE_KIND[v.kind] ?? v.kind}</td>
                <td className="r num">{fmt.l(v.tankCapacityL)}</td>
                <td className="r num">{v.fuelNormLph ? `${fmt.n(v.fuelNormLph, 1)} л/ч` : <span className="flag">не задана</span>}</td>
                <td className="r num">{fmt.n(v.lastEngineHours, 1)}</td>
                <td className="r num">{fmt.l(v.lastFuelL)}</td>
                <td>{v.trackerImei ? <span className={`online ${isOnline(v) ? 'on' : ''}`}>{isOnline(v) ? 'на связи' : fmt.ago(v.lastSeenAt)}</span> : <span className="muted">нет</span>}</td>
                {isAdmin && <td className="r"><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setEdit(v); }}>Изменить</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.length === 0 && <Empty>Добавьте первую единицу техники — водители смогут выбрать её в приложении.</Empty>}
      </div>
      {edit && <VehicleForm initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
    </div>
  );
}

const isOnline = (v: Vehicle) => !!v.lastSeenAt && Date.now() - new Date(v.lastSeenAt).getTime() < 15 * 60_000;

export function VehicleForm({ initial, onClose, onSaved }: { initial: Partial<Vehicle>; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<Partial<Vehicle>>(initial);
  const [mapping, setMapping] = useState(initial.sensorMapping ? JSON.stringify(initial.sensorMapping, null, 2) : '');
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof Vehicle, val: unknown) => setV((x) => ({ ...x, [k]: val }));
  const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));

  const save = async () => {
    setErr(null);
    let sensorMapping: unknown = null;
    if (mapping.trim()) {
      try { sensorMapping = JSON.parse(mapping); } catch { return setErr('Настройка датчиков — неверный JSON'); }
    }
    const body = {
      name: v.name, kind: v.kind, regNumber: v.regNumber || null, tankCapacityL: Number(v.tankCapacityL),
      fuelNormLph: v.fuelNormLph ?? null, normTolerancePct: v.normTolerancePct ?? null,
      trackerImei: v.trackerImei || null, trackerProtocol: v.trackerImei ? v.trackerProtocol ?? 'TELTONIKA' : null,
      sensorMapping, isActive: v.isActive ?? true,
    };
    try {
      if (v.id) await api(`/vehicles/${v.id}`, { method: 'PATCH', body });
      else await api('/vehicles', { method: 'POST', body });
      toast({ text: 'Сохранено', tone: 'info' });
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <Modal title={v.id ? `Техника: ${initial.name}` : 'Новая техника'} onClose={onClose} wide>
      <div className="form-grid">
        <Field label="Название"><input value={v.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="МТЗ-1221 №12" /></Field>
        <Field label="Тип">
          <select value={v.kind} onChange={(e) => set('kind', e.target.value)}>
            {Object.entries(VEHICLE_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Госномер / инв. номер"><input value={v.regNumber ?? ''} onChange={(e) => set('regNumber', e.target.value)} /></Field>
        <Field label="Объём бака, л"><input inputMode="decimal" value={v.tankCapacityL ?? ''} onChange={(e) => set('tankCapacityL', numOrNull(e.target.value))} /></Field>
        <Field label="Норма расхода, л/моточас" hint="Без нормы перерасход не проверяется">
          <input inputMode="decimal" value={v.fuelNormLph ?? ''} onChange={(e) => set('fuelNormLph', numOrNull(e.target.value))} />
        </Field>
        <Field label="Допуск, %" hint="Пусто — берётся из настроек хозяйства">
          <input inputMode="decimal" value={v.normTolerancePct ?? ''} onChange={(e) => set('normTolerancePct', numOrNull(e.target.value))} />
        </Field>
      </div>
      <h3>Датчики (этап 2)</h3>
      <div className="form-grid">
        <Field label="IMEI трекера" hint="Указан на наклейке трекера и в его конфигураторе">
          <input value={v.trackerImei ?? ''} onChange={(e) => set('trackerImei', e.target.value.trim())} inputMode="numeric" />
        </Field>
        <Field label="Протокол">
          <select value={v.trackerProtocol ?? 'TELTONIKA'} onChange={(e) => set('trackerProtocol', e.target.value)}>
            <option value="TELTONIKA">Teltonika (TCP 5027)</option>
            <option value="WIALON_IPS">Wialon IPS (TCP 20332)</option>
            <option value="HTTP">HTTP API</option>
          </select>
        </Field>
      </div>
      <Field label="Расшифровка параметров" hint="Какой параметр трекера — уровень топлива, моточасы и зажигание">
        <textarea rows={6} className="mono" value={mapping} onChange={(e) => setMapping(e.target.value)} placeholder='{ "fuel": { "param": "io89", "unit": "percent" } }' />
      </Field>
      <div className="presets">
        Шаблоны:
        {Object.entries(SENSOR_PRESETS).map(([k, p]) => (
          <button key={k} className="link" onClick={() => { setMapping(JSON.stringify(p.mapping, null, 2)); set('trackerProtocol', p.protocol); }}>{p.label}</button>
        ))}
      </div>
      {v.id && (
        <label className="check"><input type="checkbox" checked={v.isActive ?? true} onChange={(e) => set('isActive', e.target.checked)} /> В работе (снимите, если техника списана)</label>
      )}
      <ErrorLine error={err} />
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn btn-primary" onClick={save}>Сохранить</button>
      </div>
    </Modal>
  );
}
