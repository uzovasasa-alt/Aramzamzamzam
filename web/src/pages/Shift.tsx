import { useState } from 'react';
import { api, AnomalyRow, PhotoItem, ShiftDetail } from '../api';
import { LineChart } from '../components/LineChart';
import { MapView } from '../components/MapView';
import { ErrorLine, FuelBar, Modal, SeverityDot, StatusPill, toast } from '../components/ui';
import { fmt, PHOTO_KIND, useApi } from '../lib';

export function ShiftPage({ id }: { id: string }) {
  const s = useApi<ShiftDetail>(`/shifts/${id}`);
  const bases = useApi<{ id: string; name: string; lat: number; lon: number; radiusM: number }[]>('/bases');
  const [photo, setPhoto] = useState<PhotoItem | null>(null);
  const [reject, setReject] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  if (s.error) return <div className="page"><ErrorLine error={s.error} /></div>;
  const d = s.data;
  if (!d) return <div className="page"><div className="muted">Загрузка…</div></div>;

  const review = async (decision: 'APPROVE' | 'REJECT') => {
    setBusy(true);
    try {
      s.setData(await api<ShiftDetail>(`/shifts/${id}/review`, { method: 'POST', body: { decision, comment: comment || undefined } }));
      toast({ text: decision === 'APPROVE' ? 'Смена принята' : 'Смена отклонена', tone: 'info' });
      setReject(false);
    } catch (e: any) {
      toast({ text: e.message, tone: 'alert' });
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (a: AnomalyRow, status: 'CONFIRMED' | 'DISMISSED') => {
    const c = status === 'DISMISSED' ? window.prompt('Почему это не нарушение? (необязательно)') ?? undefined : undefined;
    await api(`/anomalies/${a.id}/resolve`, { method: 'POST', body: { status, comment: c } });
    s.reload();
  };

  const tol = 15;
  const photoBy = (k: string) => d.photos.find((p) => p.kind === k);
  const track: [number, number][] = d.track.length
    ? d.track.map((p) => [p.lat, p.lon])
    : d.telemetry.filter((t) => t.lat != null).map((t) => [t.lat!, t.lon!]);
  const points = [
    { lat: d.startLat, lon: d.startLon, label: `Старт ${fmt.time(d.startedAt)} (±${Math.round(d.startAccuracyM)} м)`, tone: d.startInZone ? 'start' : 'alert' },
    ...(d.endLat != null && d.endLon != null ? [{ lat: d.endLat, lon: d.endLon, label: `Финиш ${fmt.time(d.endedAt)}`, tone: 'end' }] : []),
  ] as const;
  const fuelSamples = d.telemetry.filter((t) => t.fuelL != null);

  return (
    <div className="page">
      <a className="back" href="#/shifts">Все смены</a>
      <header className="page-head">
        <div>
          <h1>{d.vehicleName}</h1>
          <div className="sub">{d.driverName} · {fmt.date(d.startedAt)}, {fmt.time(d.startedAt)}–{d.endedAt ? fmt.time(d.endedAt) : 'идёт'}</div>
        </div>
        <StatusPill status={d.status} />
      </header>

      {d.status === 'CLOSED' && (
        <div className="decision">
          <span>{d.anomalyCount ? `Найдено нарушений: ${d.anomalyCount}. Проверьте фото и примите решение.` : 'Нарушений не найдено.'}</span>
          <div className="decision-actions">
            <button className="btn" onClick={() => setReject(true)} disabled={busy}>Отклонить</button>
            <button className="btn btn-primary" onClick={() => review('APPROVE')} disabled={busy}>Принять смену</button>
          </div>
        </div>
      )}
      {d.reviewedAt && (
        <div className="note">
          {d.status === 'APPROVED' ? 'Принята' : 'Отклонена'} {fmt.dt(d.reviewedAt)}{d.reviewedByName ? `, ${d.reviewedByName}` : ''}
          {d.reviewComment && <>: «{d.reviewComment}»</>}
        </div>
      )}

      {d.anomalies.length > 0 && (
        <section className="panel">
          <h2>Нарушения</h2>
          <ul className="anomalies">
            {d.anomalies.map((a) => (
              <li key={a.id} className={`an an-${a.status.toLowerCase()}`}>
                <SeverityDot severity={a.severity} />
                <div className="an-text">
                  <div>{a.message}</div>
                  {a.status !== 'NEW' && <div className="muted small">{a.status === 'CONFIRMED' ? 'Подтверждено' : 'Снято'}{a.resolutionComment ? `: ${a.resolutionComment}` : ''}</div>}
                </div>
                {a.status === 'NEW' && (
                  <div className="an-actions">
                    <button className="btn btn-sm" onClick={() => resolve(a, 'DISMISSED')}>Не нарушение</button>
                    <button className="btn btn-sm btn-danger" onClick={() => resolve(a, 'CONFIRMED')}>Подтвердить</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid-2">
        <section className="panel">
          <h2>Показания</h2>
          <table className="readings">
            <thead><tr><th /><th>Старт</th><th>Финиш</th><th>Итог</th></tr></thead>
            <tbody>
              <tr>
                <th>Моточасы</th>
                <td><Reading value={fmt.n(d.startEngineHours, 1)} photo={photoBy('START_HOURS')} onOpen={setPhoto} /></td>
                <td><Reading value={fmt.n(d.endEngineHours, 1)} photo={photoBy('END_HOURS')} onOpen={setPhoto} done={!!d.endedAt} /></td>
                <td className="num">{fmt.h(d.engineHours)}</td>
              </tr>
              <tr>
                <th>Топливо, л</th>
                <td><Reading value={fmt.n(d.startFuelL, 1)} photo={photoBy('START_FUEL')} onOpen={setPhoto} /></td>
                <td><Reading value={fmt.n(d.endFuelL, 1)} photo={photoBy('END_FUEL')} onOpen={setPhoto} done={!!d.endedAt} /></td>
                <td className="num">{fmt.l(d.fuelConsumedL)}</td>
              </tr>
            </tbody>
          </table>
          <div className="fuel-summary">
            <FuelBar fact={d.fuelConsumedL} norm={d.normL} tolerancePct={tol} />
            <div className="muted small">
              Расход = остаток на старте + заправки ({fmt.l(d.refueledL)}) − остаток на финише. Норма {fmt.l(d.normL)} по наработке.
            </div>
          </div>
          {d.driverNote && <div className="quote">Комментарий водителя: «{d.driverNote}»</div>}
          {d.refuelings.length > 0 && (
            <>
              <h3>Заправки</h3>
              <ul className="plain">
                {d.refuelings.map((r) => (
                  <li key={r.id}>
                    <span className="num">{fmt.time(r.occurredAt)}</span> — <b className="num">{fmt.l(r.liters)}</b>
                    {r.note && <span className="muted"> ({r.note})</span>}
                    {r.photos.map((p) => <button key={p.id} className="link" onClick={() => setPhoto(p)}>{PHOTO_KIND[p.kind]}</button>)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        <section className="panel">
          <h2>Где начата и закрыта</h2>
          <MapView
            height={300}
            circles={(bases.data ?? []).map((b) => ({ ...b, label: b.name }))}
            track={track}
            points={points as any}
          />
          <div className="muted small map-note">
            {d.mockLocation
              ? 'Телефон сообщил о подмене геолокации.'
              : d.startInZone
                ? `Старт на базе «${d.baseName ?? '—'}», ${fmt.n(d.startDistanceM, 0)} м от центра.`
                : `Старт вне базы: ${fmt.n(d.startDistanceM, 0)} м от центра ближайшей базы.`}
          </div>
        </section>
      </div>

      {fuelSamples.length > 0 && (
        <section className="panel">
          <h2>Датчик уровня топлива во время смены</h2>
          <LineChart
            labels={fuelSamples.map((t) => fmt.time(t.ts))}
            unit=" л"
            series={[{ name: 'Уровень по датчику', color: 'var(--fuel)', values: fuelSamples.map((t) => t.fuelL) }]}
          />
        </section>
      )}

      {photo && (
        <Modal title={`${PHOTO_KIND[photo.kind]} · ${fmt.dt(photo.takenAt)}`} onClose={() => setPhoto(null)} wide>
          {photo.url ? <img className="photo-full" src={photo.url} alt={PHOTO_KIND[photo.kind]} /> : <p>Фото ещё не загрузилось с телефона — оно придёт, когда у водителя появится связь.</p>}
        </Modal>
      )}
      {reject && (
        <Modal title="Отклонить смену" onClose={() => setReject(false)}>
          <label className="field">
            <span className="field-label">Причина — её увидит водитель</span>
            <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
          </label>
          <div className="modal-actions">
            <button className="btn" onClick={() => setReject(false)}>Отмена</button>
            <button className="btn btn-danger" disabled={!comment.trim() || busy} onClick={() => review('REJECT')}>Отклонить смену</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Reading({ value, photo, onOpen, done = true }: { value: string; photo?: PhotoItem; onOpen: (p: PhotoItem) => void; done?: boolean }) {
  if (!done) return <span className="muted">—</span>;
  return (
    <div className="reading">
      <span className="num">{value}</span>
      {photo ? (
        <button className={`thumb ${photo.url ? '' : 'thumb-pending'}`} onClick={() => onOpen(photo)} title="Открыть фото">
          {photo.url ? <img src={photo.url} alt="" /> : 'ждёт'}
        </button>
      ) : (
        <span className="thumb thumb-missing" title="Фото нет">нет фото</span>
      )}
    </div>
  );
}
