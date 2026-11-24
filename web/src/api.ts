/**
 * Клиент API: хранит токены, обновляет access-токен по refresh при 401,
 * для суперадмина добавляет заголовок X-Org-Id выбранного хозяйства.
 */

export type Role = 'SUPERADMIN' | 'ADMIN' | 'MODERATOR' | 'DRIVER';
export interface Me { id: string; orgId: string | null; role: Role; fullName: string; login?: string }

const KEY = 'agro.session';
const ORG_KEY = 'agro.org';

interface Session { accessToken: string; refreshToken: string; user: Me }

function load(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

let session: Session | null = load();
const listeners = new Set<() => void>();

export const auth = {
  get user() { return session?.user ?? null; },
  get token() { return session?.accessToken ?? null; },
  onChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  set(s: Session | null) {
    session = s;
    try {
      if (s) localStorage.setItem(KEY, JSON.stringify(s));
      else localStorage.removeItem(KEY);
    } catch { /* приватный режим браузера */ }
    listeners.forEach((l) => l());
  },
  get orgId(): string | null {
    try { return localStorage.getItem(ORG_KEY); } catch { return null; }
  },
  setOrg(id: string | null) {
    try { id ? localStorage.setItem(ORG_KEY, id) : localStorage.removeItem(ORG_KEY); } catch { /* */ }
    listeners.forEach((l) => l());
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  if (!session) return false;
  refreshing ??= fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  })
    .then(async (r) => {
      if (!r.ok) { auth.set(null); return false; }
      auth.set(await r.json());
      return true;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; query?: Record<string, string | undefined | null | boolean> } = {}): Promise<T> {
  const qs = opts.query
    ? '?' + Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
    : '';
  const doFetch = () => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (session) headers.authorization = `Bearer ${session.accessToken}`;
    if (session?.user.role === 'SUPERADMIN' && auth.orgId) headers['x-org-id'] = auth.orgId;
    return fetch(`/api${path}${qs}`, { method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  };
  let res = await doFetch();
  if (res.status === 401 && session && path !== '/auth/login' && (await refresh())) res = await doFetch();
  if (!res.ok) {
    let msg = `Ошибка ${res.status}`;
    try {
      const j = await res.json();
      msg = Array.isArray(j.message) ? j.message.join('; ') : j.message ?? msg;
    } catch { /* */ }
    throw new ApiError(res.status, msg);
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export async function login(login: string, password: string) {
  const s = await api<Session>('/auth/login', { method: 'POST', body: { login, password } });
  auth.set(s);
  return s.user;
}

export function logout() {
  auth.set(null);
}

/* ---------- Типы ответов ---------- */

export interface Vehicle {
  id: string; name: string; kind: string; regNumber: string | null; tankCapacityL: number;
  fuelNormLph: number | null; normTolerancePct: number | null; trackerImei: string | null; trackerProtocol: string | null;
  sensorMapping: Record<string, any> | null; lastEngineHours: number | null; lastFuelL: number | null;
  lastLat: number | null; lastLon: number | null; lastSeenAt: string | null; lastSpeedKmh: number | null; lastIgnition: boolean | null; isActive: boolean;
}
export interface Base { id: string; name: string; lat: number; lon: number; radiusM: number; isActive: boolean }
export interface User { id: string; role: Role; fullName: string; login: string; phone: string | null; isActive: boolean }
export interface ShiftRow {
  id: string; status: 'OPEN' | 'CLOSED' | 'APPROVED' | 'REJECTED'; startedAt: string; endedAt: string | null;
  vehicleId: string; vehicleName: string; driverId: string; driverName: string; baseName: string | null;
  startInZone: boolean; endInZone: boolean | null; mockLocation: boolean; startDistanceM: number | null;
  startEngineHours: number; endEngineHours: number | null; startFuelL: number; endFuelL: number | null;
  engineHours: number | null; fuelConsumedL: number | null; refueledL: number | null; normL: number | null; overNormPct: number | null;
  anomalyCount: number; driverNote: string | null; reviewComment: string | null; reviewedAt: string | null; reviewedByName: string | null;
  startLat: number; startLon: number; startAccuracyM: number; endLat: number | null; endLon: number | null;
}
export interface PhotoItem { id: string; kind: string; url: string | null; takenAt: string; lat: number | null; lon: number | null }
export interface AnomalyRow {
  id: string; type: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; status: 'NEW' | 'CONFIRMED' | 'DISMISSED'; message: string;
  details: Record<string, any>; occurredAt: string; shiftId: string | null; vehicleId: string | null; vehicleName?: string;
  driverName?: string; resolutionComment: string | null; resolvedByName?: string;
}
export interface ShiftDetail extends ShiftRow {
  photos: PhotoItem[];
  refuelings: { id: string; liters: number; occurredAt: string; source: string; note: string | null; photos: PhotoItem[] }[];
  anomalies: AnomalyRow[];
  track: { ts: string; lat: number; lon: number; speedKmh: number | null }[];
  telemetry: { ts: string; fuelL: number | null; speedKmh: number | null; engineHours: number | null; lat: number | null; lon: number | null }[];
}
