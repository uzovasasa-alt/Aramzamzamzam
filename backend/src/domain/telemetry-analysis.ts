/**
 * Анализ телеметрии с датчиков (этап 2: ДУТ / CAN / GPS-трекер).
 *
 * Сырые показания ДУТ сильно «шумят»: топливо плещется в баке на кочках,
 * поэтому сначала сглаживаем медианой, и только потом ищем резкие перепады.
 */

export interface TelemetrySample {
  ts: Date;
  fuelL: number | null;
  speedKmh: number | null;
  ignition: boolean | null;
  engineHours?: number | null;
}

export interface FuelEvent {
  kind: 'DRAIN' | 'REFUEL';
  startTs: Date;
  endTs: Date;
  fromL: number;
  toL: number;
  deltaL: number;
}

/** Перевод «сырого» значения ДУТ (0..4095, частота, мм) в литры по тарировочной таблице. */
export function applyCalibration(raw: number, table: [number, number][]): number {
  if (!table.length) return raw;
  const t = [...table].sort((a, b) => a[0] - b[0]);
  if (raw <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (raw <= t[i][0]) {
      const [x0, y0] = t[i - 1];
      const [x1, y1] = t[i];
      return y0 + ((raw - x0) * (y1 - y0)) / (x1 - x0);
    }
  }
  return t[t.length - 1][1];
}

export function medianSmooth(values: number[], window = 5): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - half), Math.min(values.length, i + half + 1)).sort((a, b) => a - b);
    return slice[Math.floor(slice.length / 2)];
  });
}

/**
 * Поиск сливов и заправок.
 * Слив — падение ≥ minLiters за окно ≤ windowMin, пока техника стоит (скорость < 3 км/ч).
 * На ходу уровень тоже падает, но это нормальный расход: при норме 20 л/ч
 * за 20 минут уходит ~7 л, поэтому порог 15 л на стоянке надёжно отделяет слив.
 */
export function detectFuelEvents(
  samples: TelemetrySample[],
  opts: { minLiters: number; windowMin: number; smoothWindow?: number },
): FuelEvent[] {
  const pts = samples
    .filter((s) => s.fuelL != null && Number.isFinite(s.fuelL))
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  if (pts.length < 3) return [];
  const smooth = medianSmooth(pts.map((p) => p.fuelL as number), opts.smoothWindow ?? 5);
  const windowMs = opts.windowMin * 60_000;
  const events: FuelEvent[] = [];

  let i = 0;
  while (i < pts.length - 1) {
    let best: { j: number; delta: number } | null = null;
    for (let j = i + 1; j < pts.length && pts[j].ts.getTime() - pts[i].ts.getTime() <= windowMs; j++) {
      const delta = smooth[j] - smooth[i];
      if (Math.abs(delta) >= opts.minLiters && (!best || Math.abs(delta) > Math.abs(best.delta))) {
        best = { j, delta };
      }
    }
    if (best) {
      const kind: FuelEvent['kind'] = best.delta > 0 ? 'REFUEL' : 'DRAIN';
      // Уточняем начало: последняя точка «полки» перед перепадом (окно могло захватить лишние минуты простоя)
      let s0 = i;
      for (let k = i; k < best.j; k++) {
        if (kind === 'DRAIN' ? smooth[k] >= smooth[i] - 1 : smooth[k] <= smooth[i] + 1) s0 = k;
      }
      const moving = pts.slice(s0, best.j + 1).some((p) => (p.speedKmh ?? 0) >= 3);
      if (kind === 'REFUEL' || !moving) {
        // Расширяем событие до момента, пока уровень продолжает меняться в ту же сторону
        // Датчик квантует уровень (например, целые проценты), поэтому соседние точки могут совпадать —
        // смотрим на 3 точки вперёд, продолжается ли изменение в ту же сторону.
        let end = best.j;
        for (;;) {
          let next = -1;
          for (let m = end + 1; m < Math.min(pts.length, end + 4); m++) {
            const d = smooth[m] - smooth[end];
            if (Math.sign(d) === Math.sign(best.delta) && Math.abs(d) > 0.5) { next = m; break; }
          }
          if (next < 0) break;
          end = next;
        }
        events.push({
          kind,
          startTs: pts[s0].ts,
          endTs: pts[end].ts,
          fromL: round1(smooth[s0]),
          toL: round1(smooth[end]),
          deltaL: round1(smooth[end] - smooth[s0]),
        });
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return events;
}

/** Уровень топлива по датчику на момент времени (ближайший замер в пределах maxGapMin). */
export function sensorFuelAt(samples: TelemetrySample[], at: Date, maxGapMin = 10): number | null {
  let best: TelemetrySample | null = null;
  for (const s of samples) {
    if (s.fuelL == null) continue;
    if (!best || Math.abs(s.ts.getTime() - at.getTime()) < Math.abs(best.ts.getTime() - at.getTime())) best = s;
  }
  if (!best || Math.abs(best.ts.getTime() - at.getTime()) > maxGapMin * 60_000) return null;
  return best.fuelL;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
