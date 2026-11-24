import { ReactNode, useEffect, useState } from 'react';
import { fmt, SEVERITY, SHIFT_STATUS } from '../lib';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">×</button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill-${status.toLowerCase()}`}>{SHIFT_STATUS[status] ?? status}</span>;
}

export function SeverityDot({ severity }: { severity: string }) {
  return <span className={`sev sev-${severity.toLowerCase()}`} title={`Важность: ${SEVERITY[severity]}`} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <div className="error-line" role="alert">{error}</div> : null;
}

/**
 * Полоса «факт против нормы» — главный визуальный элемент панели.
 * Шкала до max(факт, норма+допуск)·1.1; тонкая риска — норма, заштрихованная зона — допуск.
 */
export function FuelBar({ fact, norm, tolerancePct = 15, compact }: { fact: number | null; norm: number | null; tolerancePct?: number; compact?: boolean }) {
  if (fact == null) return <span className="muted">—</span>;
  if (norm == null || norm <= 0) return <span className="num">{fmt.l(fact)}</span>;
  const limit = norm * (1 + tolerancePct / 100);
  const scale = Math.max(fact, limit) * 1.1;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  const state = fact > limit ? 'over' : fact > norm ? 'warn' : 'ok';
  const dev = ((fact - norm) / norm) * 100;
  return (
    <div className={`fuelbar ${compact ? 'fuelbar-compact' : ''}`} title={`Факт ${fmt.l(fact)}, норма ${fmt.l(norm)} (${fmt.pct(dev)})`}>
      <div className="fuelbar-track">
        <div className="fuelbar-tol" style={{ left: pct(norm), width: `calc(${pct(limit)} - ${pct(norm)})` }} />
        <div className={`fuelbar-fill fuelbar-${state}`} style={{ width: pct(fact) }} />
        <div className="fuelbar-norm" style={{ left: pct(norm) }} />
      </div>
      {!compact && (
        <div className="fuelbar-legend">
          <span className="num">{fmt.l(fact)}</span>
          <span className={`num dev-${state}`}>{fmt.pct(dev)}</span>
        </div>
      )}
    </div>
  );
}

/* ---------- Всплывающие уведомления ---------- */

export interface Toast { id: number; text: string; tone: 'info' | 'alert'; onClick?: () => void }
let pushToast: (t: Omit<Toast, 'id'>) => void = () => {};
export const toast = (t: Omit<Toast, 'id'>) => pushToast(t);

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    let n = 0;
    pushToast = (t) => {
      const id = ++n;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 9000);
    };
  }, []);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <button key={t.id} className={`toast toast-${t.tone}`} onClick={() => { t.onClick?.(); setItems((xs) => xs.filter((x) => x.id !== t.id)); }}>
          {t.text}
        </button>
      ))}
    </div>
  );
}
