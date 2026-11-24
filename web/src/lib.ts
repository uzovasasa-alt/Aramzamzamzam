import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';

/* ---------- Маршрутизация на hash: #/shifts/123 ---------- */

function getHash() {
  return window.location.hash.replace(/^#/, '') || '/';
}

export function useRoute(): string {
  return useSyncExternalStore(
    (cb) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); },
    getHash,
  );
}

/** Параметры после «?» в hash-маршруте: #/shifts?driver=... */
export function routeQuery(route: string): URLSearchParams {
  return new URLSearchParams(route.split('?')[1] ?? '');
}

export function go(path: string) {
  window.location.hash = path;
}

/* ---------- Загрузка данных ---------- */

export function useApi<T>(path: string | null, query?: Record<string, string | undefined | boolean | null>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = path ? path + JSON.stringify(query ?? {}) : null;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    api<T>(path, { query })
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/* ---------- Форматирование ---------- */

const TZ = 'Europe/Moscow';

export const fmt = {
  dt: (s: string | null | undefined) =>
    s ? new Date(s).toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—',
  date: (s: string | null | undefined) =>
    s ? new Date(s).toLocaleDateString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'long' }) : '—',
  time: (s: string | null | undefined) =>
    s ? new Date(s).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—',
  n: (v: number | null | undefined, d = 1) =>
    v == null || Number.isNaN(v) ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: 0 }),
  l: (v: number | null | undefined) => (v == null ? '—' : `${fmt.n(v, 1)} л`),
  h: (v: number | null | undefined) => (v == null ? '—' : `${fmt.n(v, 1)} ч`),
  pct: (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${fmt.n(v, 1)}%`),
  ago: (s: string | null | undefined) => {
    if (!s) return 'нет данных';
    const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин назад`;
    if (m < 60 * 24) return `${Math.round(m / 60)} ч назад`;
    return `${Math.round(m / 1440)} дн назад`;
  },
};

/** Значение для <input type="date"> по московскому времени */
export function isoDay(d: Date) {
  return new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

export const SHIFT_STATUS: Record<string, string> = {
  OPEN: 'Идёт',
  CLOSED: 'Ждёт проверки',
  APPROVED: 'Принята',
  REJECTED: 'Отклонена',
};

export const SEVERITY: Record<string, string> = { HIGH: 'Высокая', MEDIUM: 'Средняя', LOW: 'Низкая' };

export const PHOTO_KIND: Record<string, string> = {
  START_HOURS: 'Моточасы, старт',
  START_FUEL: 'Топливо, старт',
  END_HOURS: 'Моточасы, финиш',
  END_FUEL: 'Топливо, финиш',
  REFUEL_RECEIPT: 'Чек / накладная',
  REFUEL_METER: 'Счётчик ТРК',
};

export const VEHICLE_KIND: Record<string, string> = {
  TRACTOR: 'Трактор',
  COMBINE: 'Комбайн',
  TRUCK: 'Грузовик',
  SPRAYER: 'Опрыскиватель',
  LOADER: 'Погрузчик',
  OTHER: 'Другое',
};

export const ROLE: Record<string, string> = {
  SUPERADMIN: 'Суперадмин',
  ADMIN: 'Администратор',
  MODERATOR: 'Модератор',
  DRIVER: 'Водитель',
};
