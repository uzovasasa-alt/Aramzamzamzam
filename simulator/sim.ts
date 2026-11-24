/**
 * Симулятор для проверки системы без настоящей техники и телефонов.
 *
 *   npx tsx simulator/sim.ts tracker --protocol teltonika --imei 356307042441013 --scenario drain
 *   npx tsx simulator/sim.ts tracker --protocol wialon    --imei 861230043907626 --scenario night-move
 *   npx tsx simulator/sim.ts tracker --protocol http      --imei 111 --key change-me-telemetry
 *   npx tsx simulator/sim.ts driver  --login ivanov --password 1111 --scenario overuse
 *
 * tracker — притворяется GPS-трекером с ДУТ/CAN и шлёт данные по TCP (как настоящий) или HTTP.
 *           Точки генерируются «задним числом» за последние --hours часов, чтобы результат был виден сразу.
 * driver  — притворяется мобильным приложением водителя: открывает и закрывает смену через /api/mobile/sync.
 *
 * Общие параметры: --host localhost --api http://localhost:3000 --lat 54.1063 --lon 44.9395
 */
import { randomUUID } from 'crypto';
import * as net from 'net';
import { buildAvlPacket, buildImeiPacket, CODEC_8E } from '../backend/src/telemetry/parsers/teltonika';
import { buildWialonD, buildWialonLogin } from '../backend/src/telemetry/parsers/wialon-ips';

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const HOST = opt('host', 'localhost');
const API = opt('api', 'http://localhost:3000');
const LAT = Number(opt('lat', '54.1063'));
const LON = Number(opt('lon', '44.9395'));

/* ======================= Генерация телеметрии ======================= */

export interface Point {
  ts: Date; lat: number; lon: number; speedKmh: number; course: number; fuelL: number; engineHours: number; ignition: boolean;
}

/**
 * Сценарии:
 *  normal     — рабочий день 08–18 МСК, расход ~28 л/ч, ночью стоит
 *  drain      — как normal, плюс слив 60 л ночью на стоянке
 *  refuel     — заправка +300 л в обед, не внесённая в систему
 *  night-move — движение ночью без открытой смены
 */
export function generate(scenario: string, hours: number, tankL = 800, startFuel = 600, startEh = 9400): Point[] {
  const pts: Point[] = [];
  const end = Date.now();
  const start = end - hours * 3_600_000;
  let fuel = startFuel;
  let eh = startEh;
  let lat = LAT;
  let lon = LON;
  let drainDone = false;
  let refuelDone = false;
  for (let t = start; t <= end; t += 60_000) {
    const h = (new Date(t).getUTCHours() + 3) % 24;
    let working = h >= 8 && h < 18;
    if (scenario === 'night-move' && h >= 1 && h < 2) working = true;
    let speed = 0;
    if (working) {
      speed = 8 + 4 * Math.random();
      fuel -= 28 / 60; // л/мин
      eh += 1 / 60;
      const a = t / 600_000;
      lat = LAT + 0.012 * Math.sin(a);
      lon = LON + 0.02 * Math.cos(a);
    } else {
      lat = LAT + (Math.random() - 0.5) * 0.0002;
      lon = LON + (Math.random() - 0.5) * 0.0002;
    }
    if (scenario === 'drain' && !drainDone && h === 2) {
      // 60 л за 10 минут на стоянке (трекер шлёт точку раз в минуту)
      for (let k = 0; k < 10; k++) {
        fuel -= 6;
        pts.push(point(t + k * 60_000, lat, lon, 0, fuel, eh, false));
      }
      t += 10 * 60_000;
      drainDone = true;
    }
    if (scenario === 'refuel' && !refuelDone && h === 13) {
      fuel = Math.min(tankL, fuel + 300);
      refuelDone = true;
    }
    fuel = Math.max(5, fuel);
    // «плеск» топлива в баке — шум датчика ±2 л на ходу
    const noisy = fuel + (working ? (Math.random() - 0.5) * 4 : 0);
    pts.push(point(t, lat, lon, speed, noisy, eh, working));
  }
  return pts;
}

function point(t: number, lat: number, lon: number, speed: number, fuel: number, eh: number, ign: boolean): Point {
  return { ts: new Date(t), lat, lon, speedKmh: speed, course: 90, fuelL: Math.round(fuel * 10) / 10, engineHours: Math.round(eh * 100) / 100, ignition: ign };
}

/* ======================= Отправка ======================= */

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, HOST, () => resolve(s));
    s.once('error', reject);
  });
}

function readOnce(sock: net.Socket, timeoutMs = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Сервер не ответил')), timeoutMs);
    sock.once('data', (d) => { clearTimeout(t); resolve(d); });
  });
}

/** Teltonika: уровень топлива в % (io89, как с CAN), моточасы в минутах (io102), зажигание (io239) */
export async function sendTeltonika(imei: string, pts: Point[], tankL: number, port = 5027) {
  const sock = await connect(port);
  sock.write(buildImeiPacket(imei));
  const ok = await readOnce(sock);
  if (ok[0] !== 1) throw new Error('Сервер не принял IMEI — добавьте его технике в веб-панели');
  for (let i = 0; i < pts.length; i += 50) {
    const batch = pts.slice(i, i + 50);
    sock.write(buildAvlPacket(batch.map((p) => ({
      ts: p.ts, lat: p.lat, lon: p.lon, altitude: 150, course: p.course, satellites: 11, speedKmh: p.speedKmh,
      io: { 239: p.ignition ? 1 : 0, 89: Math.round((p.fuelL / tankL) * 100), 102: Math.round(p.engineHours * 60) },
    })), CODEC_8E));
    const ack = await readOnce(sock);
    if (ack.readUInt32BE(0) !== batch.length) throw new Error(`Сервер подтвердил ${ack.readUInt32BE(0)} из ${batch.length}`);
    process.stdout.write(`\rОтправлено ${Math.min(i + 50, pts.length)} / ${pts.length}`);
  }
  sock.end();
  console.log('\nГотово (Teltonika).');
}

/** Wialon IPS 2.0: параметры fuel_lvl (л), eng_hours (ч), ign */
export async function sendWialon(imei: string, pts: Point[], port = 20332) {
  const sock = await connect(port);
  sock.write(buildWialonLogin(imei));
  const login = (await readOnce(sock)).toString();
  if (!login.startsWith('#AL#1')) throw new Error(`Логин отклонён: ${login.trim()}`);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    sock.write(buildWialonD({
      ts: p.ts, lat: p.lat, lon: p.lon, speedKmh: p.speedKmh, course: p.course, altitude: 150, satellites: 10,
      params: { fuel_lvl: p.fuelL, eng_hours: p.engineHours, ign: p.ignition ? 1 : 0 },
    }));
    const r = (await readOnce(sock)).toString();
    if (!r.startsWith('#AD#1')) throw new Error(`Пакет отклонён: ${r.trim()}`);
    if (i % 50 === 0) process.stdout.write(`\rОтправлено ${i + 1} / ${pts.length}`);
  }
  sock.end();
  console.log('\nГотово (Wialon IPS).');
}

async function sendHttp(imei: string, pts: Point[], key: string) {
  for (let i = 0; i < pts.length; i += 500) {
    const r = await fetch(`${API}/api/telemetry/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telemetry-key': key },
      body: JSON.stringify({
        imei,
        records: pts.slice(i, i + 500).map((p) => ({
          ts: p.ts.toISOString(), lat: p.lat, lon: p.lon, speedKmh: p.speedKmh,
          params: { fuel_l: p.fuelL, engine_hours: p.engineHours, ignition: p.ignition ? 1 : 0 },
        })),
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  }
  console.log(`Готово (HTTP), отправлено ${pts.length} точек.`);
}

/* ======================= «Водитель» ======================= */

async function driver() {
  const login = opt('login', 'ivanov');
  const password = opt('password', '1111');
  const scenario = opt('scenario', 'normal'); // normal | overuse | outside | hours-padding
  const call = async (path: string, token: string | null, body?: unknown) => {
    const r = await fetch(`${API}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const { accessToken } = await call('/auth/login', null, { login, password });
  const boot = await call('/mobile/bootstrap', accessToken);
  const base = boot.bases[0];
  const vehicle = boot.vehicles.find((v: any) => !v.hasSensors) ?? boot.vehicles[0];
  if (!base || !vehicle) throw new Error('Нет баз или техники — сначала выполните npm run seed');

  const id = randomUUID();
  const started = new Date(Date.now() - 10 * 3_600_000);
  const ended = new Date(Date.now() - 30 * 60_000);
  const startEh = (vehicle.lastEngineHours ?? 1000) + 0;
  const startFuel = Math.min(vehicle.tankCapacityL * 0.9, vehicle.lastFuelL ?? vehicle.tankCapacityL * 0.9);
  const worked = scenario === 'hours-padding' ? 12.5 : 8.6;
  const norm = (vehicle.fuelNormLph ?? 12) * worked;
  const consumed = scenario === 'overuse' ? norm * 1.45 : norm * 0.97;
  const refuel = startFuel - consumed < 10 ? Math.ceil((consumed - startFuel + 30) / 10) * 10 : 0;
  const away = scenario === 'outside' ? 0.03 : 0; // ~3 км от базы

  const shift = {
    id, vehicleId: vehicle.id, startedAt: started.toISOString(), endedAt: ended.toISOString(),
    startLat: base.lat + away, startLon: base.lon, startAccuracyM: 12, endLat: base.lat, endLon: base.lon, endAccuracyM: 15,
    mockLocation: false, startEngineHours: startEh, endEngineHours: Math.round((startEh + worked) * 10) / 10,
    startFuelL: Math.round(startFuel), endFuelL: Math.round((startFuel + refuel - consumed) * 10) / 10,
    driverNote: 'Отправлено симулятором', clientUpdatedAt: ended.toISOString(),
  };
  const refuelings = refuel
    ? [{ id: randomUUID(), vehicleId: vehicle.id, shiftId: id, liters: refuel, occurredAt: new Date(started.getTime() + 4 * 3_600_000).toISOString(), clientUpdatedAt: ended.toISOString() }]
    : [];
  const photos = ['START_HOURS', 'START_FUEL', 'END_HOURS', 'END_FUEL'].map((kind) => ({
    id: randomUUID(), kind, shiftId: id, takenAt: (kind.startsWith('START') ? started : ended).toISOString(), sha256: 'simulated',
  }));
  const trackPoints = Array.from({ length: 60 }, (_, i) => ({
    shiftId: id, ts: new Date(started.getTime() + i * 9 * 60_000).toISOString(),
    lat: base.lat + 0.01 * Math.sin(i / 8), lon: base.lon + 0.015 * Math.cos(i / 8), accuracyM: 10, speedKmh: 11,
  }));

  const res = await call('/mobile/sync', accessToken, { deviceId: 'simulator', shifts: [shift], refuelings, photos, trackPoints });
  console.log('Ответ сервера:', JSON.stringify({ shifts: res.shifts, refuelings: res.refuelings, photos: res.photos.length }, null, 0));
  // Повтор того же пакета — проверка идемпотентности: дублей быть не должно
  await call('/mobile/sync', accessToken, { deviceId: 'simulator', shifts: [shift], refuelings, photos, trackPoints });
  const st = res.shiftStates.find((s: any) => s.id === id);
  console.log(`Смена ${id}: статус ${st?.status}, нарушений: ${st?.anomalyCount}. Откройте веб-панель → Смены.`);
}

/* ======================= Запуск ======================= */

async function main() {
  if (mode === 'tracker') {
    const protocol = opt('protocol', 'teltonika');
    const imei = opt('imei', '356307042441013');
    const scenario = opt('scenario', 'drain');
    const hours = Number(opt('hours', '24'));
    const tank = Number(opt('tank', '800'));
    const pts = generate(scenario, hours, tank);
    console.log(`Сценарий «${scenario}», ${pts.length} точек за ${hours} ч → ${protocol}`);
    if (protocol === 'teltonika') await sendTeltonika(imei, pts, tank, Number(opt('port', '5027')));
    else if (protocol === 'wialon') await sendWialon(imei, pts, Number(opt('port', '20332')));
    else await sendHttp(imei, pts, opt('key', 'change-me-telemetry'));
    console.log('Анализ запускается раз в 5 минут; чтобы сразу — кнопка «Проверить на сливы» в карточке техники.');
  } else if (mode === 'driver') {
    await driver();
  } else {
    console.log('Использование: tsx simulator/sim.ts tracker|driver [--параметры]. Подробности — в начале файла.');
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Ошибка:', e.message);
    process.exit(1);
  });
}
