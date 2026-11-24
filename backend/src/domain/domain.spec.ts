import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInsideZone, haversineMeters } from './geo';
import { analyzeShift, computeTotals, DEFAULT_ORG_SETTINGS, ShiftFacts, VehicleInfo } from './rules';
import { applyCalibration, detectFuelEvents, TelemetrySample } from './telemetry-analysis';
import { decodeSensors } from './sensor-mapping';

const base = { center: { lat: 54.1838, lon: 45.1749 }, radiusM: 300 }; // Саранск

test('haversine: 1 градус широты ≈ 111 км', () => {
  const d = haversineMeters({ lat: 54, lon: 45 }, { lat: 55, lon: 45 });
  assert.ok(Math.abs(d - 111_195) < 200, String(d));
});

test('геозона: внутри / снаружи / плохая точность / фейковый GPS', () => {
  const opts = { maxAccuracyM: 100 };
  assert.equal(checkInsideZone({ lat: 54.1840, lon: 45.1750 }, 15, base, opts).ok, true);
  const out = checkInsideZone({ lat: 54.1900, lon: 45.1749 }, 15, base, opts);
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.reason, 'OUTSIDE');
  const acc = checkInsideZone({ lat: 54.1840, lon: 45.1750 }, 500, base, opts);
  assert.equal(!acc.ok && acc.reason, 'LOW_ACCURACY');
  const mock = checkInsideZone({ lat: 54.1840, lon: 45.1750 }, 5, base, { ...opts, isMock: true });
  assert.equal(!mock.ok && mock.reason, 'MOCK_LOCATION');
});

const tractor: VehicleInfo = { id: 'v1', name: 'МТЗ-1221', tankCapacityL: 160, fuelNormLph: 12, normTolerancePct: 10 };
const allPhotos = ['START_HOURS', 'START_FUEL', 'END_HOURS', 'END_FUEL'].map((kind) => ({ kind }));
const okShift = (): ShiftFacts => ({
  id: 's1',
  startedAt: new Date('2026-08-01T05:00:00Z'),
  endedAt: new Date('2026-08-01T15:00:00Z'),
  startInZone: true,
  endInZone: true,
  mockLocation: false,
  startEngineHours: 1000,
  endEngineHours: 1009,
  startFuelL: 150,
  endFuelL: 45,
  photos: allPhotos,
});

test('нормальная смена — без аномалий', () => {
  const t = computeTotals(okShift(), tractor, []);
  assert.equal(t.engineHours, 9);
  assert.equal(t.fuelConsumedL, 105);
  assert.equal(t.normL, 108);
  assert.deepEqual(analyzeShift(okShift(), tractor, [], null, DEFAULT_ORG_SETTINGS), []);
});

test('перерасход: 9 моточ., норма 108 л, факт 140 л с учётом заправки', () => {
  const s = { ...okShift(), endFuelL: 60 };
  const a = analyzeShift(s, tractor, [{ id: 'r1', liters: 50, occurredAt: new Date('2026-08-01T10:00:00Z') }], null, DEFAULT_ORG_SETTINGS);
  const over = a.find((x) => x.type === 'FUEL_OVER_NORM');
  assert.ok(over, JSON.stringify(a));
  assert.equal(over!.severity, 'HIGH'); // +29.6% > 2 * 10%
});

test('приписка моточасов: 14 моточ. за 10 часов смены', () => {
  const s = { ...okShift(), endEngineHours: 1014, endFuelL: 0 };
  const types = analyzeShift(s, tractor, [], null, DEFAULT_ORG_SETTINGS).map((x) => x.type);
  assert.ok(types.includes('ENGINE_HOURS_EXCEED_DURATION'), types.join());
});

test('сравнение с прошлой сменой: откат счётчика и пропажа топлива', () => {
  const prev = { id: 'p', endedAt: new Date('2026-07-31T18:00:00Z'), endEngineHours: 1002, endFuelL: 180 };
  const types = analyzeShift(okShift(), tractor, [], prev, DEFAULT_ORG_SETTINGS).map((x) => x.type);
  assert.ok(types.includes('ENGINE_HOURS_ROLLBACK'));
  assert.ok(types.includes('FUEL_GAP_BETWEEN_SHIFTS'));
  // заправка между сменами объясняет разницу
  const prev2 = { ...prev, endEngineHours: 1000, endFuelL: 100, refueledSinceL: 50 };
  assert.deepEqual(analyzeShift(okShift(), tractor, [], prev2, DEFAULT_ORG_SETTINGS), []);
});

test('нет фото и старт вне базы', () => {
  const s = { ...okShift(), photos: [{ kind: 'START_HOURS' }], startInZone: false };
  const types = analyzeShift(s, tractor, [], null, DEFAULT_ORG_SETTINGS).map((x) => x.type);
  assert.deepEqual(types.sort(), ['MISSING_PHOTO', 'START_OUTSIDE_ZONE']);
});

test('тарировочная таблица ДУТ', () => {
  const table: [number, number][] = [[0, 0], [1000, 100], [3000, 350]];
  assert.equal(applyCalibration(500, table), 50);
  assert.equal(applyCalibration(2000, table), 225);
  assert.equal(applyCalibration(5000, table), 350);
});

function series(): TelemetrySample[] {
  const out: TelemetrySample[] = [];
  const t0 = Date.parse('2026-08-01T05:00:00Z');
  let fuel = 300;
  for (let m = 0; m < 240; m += 1) {
    let speed = 12;
    if (m >= 100 && m < 130) speed = 0; // стоянка
    if (m >= 100 && m < 130) {
      if (m >= 110 && m < 118) fuel -= 5; // слив 40 л за 8 мин на стоянке
    } else {
      fuel -= 0.25; // ~15 л/ч
    }
    if (m === 180) speed = 0;
    if (m >= 180 && m < 185) { fuel += 30; speed = 0; } // заправка 150 л
    const noise = ((m * 7919) % 7) - 3; // ±3 л «плеска»
    out.push({ ts: new Date(t0 + m * 60_000), fuelL: fuel + noise * 0.8, speedKmh: speed, ignition: true });
  }
  return out;
}

test('поиск слива и заправки по ДУТ, нормальный расход не считается сливом', () => {
  const ev = detectFuelEvents(series(), { minLiters: 15, windowMin: 20 });
  const drains = ev.filter((e) => e.kind === 'DRAIN');
  const refuels = ev.filter((e) => e.kind === 'REFUEL');
  assert.equal(drains.length, 1, JSON.stringify(ev));
  assert.ok(drains[0].deltaL <= -30 && drains[0].deltaL >= -50, String(drains[0].deltaL));
  assert.equal(refuels.length, 1, JSON.stringify(ev));
  assert.ok(refuels[0].deltaL >= 130, String(refuels[0].deltaL));
});

test('расшифровка параметров трекера', () => {
  const d = decodeSensors({ io89: 50, io102: 90_000, io239: 1 }, {
    fuel: { param: 'io89', unit: 'percent' },
    engineHours: { param: 'io102', unit: 'minutes' },
    ignition: { param: 'io239' },
  }, 400);
  assert.deepEqual(d, { fuelL: 200, engineHours: 1500, ignition: true });
});
