/**
 * Геометрия без внешних зависимостей.
 * Та же логика продублирована в Android-приложении (GeoFence.kt), чтобы
 * телефон и сервер одинаково решали, «внутри базы» точка или нет.
 * Окончательную проверку на сервере делает PostGIS (ST_DWithin) — см. bases.service.ts,
 * а эта функция используется в тестах, симуляторе и как запасной вариант.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface CircleZone {
  center: LatLon;
  radiusM: number;
}

const EARTH_RADIUS_M = 6_371_008.8;

export function haversineMeters(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type ZoneVerdict =
  | { ok: true; distanceM: number }
  | { ok: false; reason: 'OUTSIDE' | 'LOW_ACCURACY' | 'MOCK_LOCATION'; distanceM: number };

/**
 * Решение «можно ли начать смену в этой точке».
 * Точность GPS не прибавляется к радиусу: иначе при плохом сигнале
 * зона «раздувается» и антифрод теряет смысл. Вместо этого слишком
 * неточные фиксации просто отклоняются — водитель ждёт лучшего сигнала.
 */
export function checkInsideZone(
  point: LatLon,
  accuracyM: number,
  zone: CircleZone,
  opts: { maxAccuracyM: number; isMock?: boolean },
): ZoneVerdict {
  const distanceM = haversineMeters(point, zone.center);
  if (opts.isMock) return { ok: false, reason: 'MOCK_LOCATION', distanceM };
  if (!(accuracyM >= 0) || accuracyM > opts.maxAccuracyM) {
    return { ok: false, reason: 'LOW_ACCURACY', distanceM };
  }
  if (distanceM > zone.radiusM) return { ok: false, reason: 'OUTSIDE', distanceM };
  return { ok: true, distanceM };
}

/** Ближайшая база (для подсказки водителю «до базы N км»). */
export function nearestZone<T extends CircleZone>(point: LatLon, zones: T[]): { zone: T; distanceM: number } | null {
  let best: { zone: T; distanceM: number } | null = null;
  for (const zone of zones) {
    const d = haversineMeters(point, zone.center) - zone.radiusM;
    if (!best || d < best.distanceM) best = { zone, distanceM: Math.max(0, d) };
  }
  return best;
}
