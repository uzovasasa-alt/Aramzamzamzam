/**
 * Демо-данные: хозяйство, база, техника, сотрудники и две недели смен
 * (в том числе со «сливами» и «приписками»), чтобы веб-панель сразу было что показать.
 *
 *   npm run seed            — в разработке
 *   npm run seed:prod       — в docker (после сборки)
 *
 * Повторный запуск ничего не дублирует.
 */
import 'reflect-metadata';
process.env.TELTONIKA_TCP_PORT = '0'; // не открываем TCP-порты трекеров при сидировании
process.env.WIALON_TCP_PORT = '0';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'seed';

import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { AuthService } from '../auth/auth.service';
import { Base, Organization, Photo, Refueling, Shift, User, Vehicle } from '../entities';
import { ShiftsService } from '../shifts/shifts.service';
import { TelemetryService } from '../telemetry/telemetry.service';

const BASE = { lat: 54.1063, lon: 44.9395 }; // условная база в Рузаевском районе Мордовии

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const db = app.get(DataSource);
  const shiftsService = app.get(ShiftsService);
  const telemetry = app.get(TelemetryService);

  const users = db.getRepository(User);
  if (!(await users.exists({ where: { login: 'superadmin' } }))) {
    await users.save(users.create({ orgId: null, role: 'SUPERADMIN', login: 'superadmin', fullName: 'Суперадминистратор', passwordHash: await AuthService.hash('superadmin') }));
  }
  if (await users.exists({ where: { login: 'admin' } })) {
    console.log('Демо-данные уже есть. Логины: admin/admin123, moderator/moder123, ivanov/1111, petrov/2222, superadmin/superadmin');
    await app.close();
    return;
  }

  const org = await db.getRepository(Organization).save({ name: 'Демо-хозяйство «Нива»', inn: '1300000000', settings: {} });
  const base = await db.getRepository(Base).save({ orgId: org.id, name: 'Машинный двор', lat: BASE.lat, lon: BASE.lon, radiusM: 250 });
  await db.getRepository(Base).save({ orgId: org.id, name: 'Отделение №2', lat: BASE.lat + 0.08, lon: BASE.lon + 0.12, radiusM: 200 });

  const mk = async (role: User['role'], login: string, fullName: string, password: string, phone?: string) =>
    users.save(users.create({ orgId: org.id, role, login, fullName, phone: phone ?? null, passwordHash: await AuthService.hash(password) }));
  await mk('ADMIN', 'admin', 'Сергеев Олег Петрович (главный инженер)', 'admin123');
  await mk('MODERATOR', 'moderator', 'Кузнецова Анна Викторовна (диспетчер)', 'moder123');
  const ivanov = await mk('DRIVER', 'ivanov', 'Иванов Пётр Сергеевич', '1111', '+79270000001');
  const petrov = await mk('DRIVER', 'petrov', 'Петров Николай Ильич', '2222', '+79270000002');
  const sidorov = await mk('DRIVER', 'sidorov', 'Сидоров Алексей Юрьевич', '3333', '+79270000003');

  const vRepo = db.getRepository(Vehicle);
  const mtz = await vRepo.save({ orgId: org.id, name: 'МТЗ-1221 №12', kind: 'TRACTOR', regNumber: '13 ТО 1234', tankCapacityL: 160, fuelNormLph: 11.5, normTolerancePct: 12 });
  const kirovets = await vRepo.save({
    orgId: org.id, name: 'Кировец К-742 №3', kind: 'TRACTOR', regNumber: '13 ТО 5678', tankCapacityL: 800, fuelNormLph: 28, normTolerancePct: 10,
    trackerImei: '356307042441013', trackerProtocol: 'TELTONIKA',
    sensorMapping: { fuel: { param: 'io89', unit: 'percent' }, engineHours: { param: 'io102', unit: 'minutes' }, ignition: { param: 'io239' } },
  });
  const acros = await vRepo.save({ orgId: org.id, name: 'Acros 595 Plus №1', kind: 'COMBINE', regNumber: '13 ТО 9012', tankCapacityL: 540, fuelNormLph: 22, normTolerancePct: 15 });
  await vRepo.save({ orgId: org.id, name: 'КамАЗ-45143 №7', kind: 'TRUCK', regNumber: 'Е123КХ13', tankCapacityL: 350, fuelNormLph: 14 });

  // --- две недели смен ---
  const shiftRepo = db.getRepository(Shift);
  const refRepo = db.getRepository(Refueling);
  const photoRepo = db.getRepository(Photo);
  const state = new Map<string, { eh: number; fuel: number }>([
    [mtz.id, { eh: 4120.5, fuel: 140 }],
    [kirovets.id, { eh: 9310.2, fuel: 650 }],
    [acros.id, { eh: 1488.0, fuel: 480 }],
  ]);
  const plan: [Vehicle, User][] = [[mtz, ivanov], [kirovets, petrov], [acros, sidorov]];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let rnd = 42;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);

  for (let day = 14; day >= 1; day--) {
    for (const [v, d] of plan) {
      if (rand() < 0.15) continue; // выходной / ремонт
      const st = state.get(v.id)!;
      const start = new Date(today.getTime() - day * 86_400_000 + (4 + rand()) * 3_600_000); // ~07:00-08:00 МСК
      const durH = 8 + rand() * 3;
      const end = new Date(start.getTime() + durH * 3_600_000);
      let worked = Math.round(durH * (0.75 + rand() * 0.15) * 10) / 10;
      let consumed = worked * v.fuelNormLph! * (0.9 + rand() * 0.15);
      let startFuel = st.fuel;
      let startEh = st.eh;
      let note: string | null = null;

      // сценарии нарушений для демонстрации
      if (v.id === mtz.id && day === 9) consumed *= 1.45; // перерасход
      if (v.id === acros.id && day === 6) worked = Math.round((durH + 2.5) * 10) / 10; // приписка моточасов
      if (v.id === mtz.id && day === 4) startFuel = st.fuel - 35; // пропало топливо между сменами
      if (v.id === kirovets.id && day === 3) { note = 'Ждал агронома 2 часа'; }

      let refuel = 0;
      if (startFuel - consumed < v.tankCapacityL * 0.15) refuel = Math.round((v.tankCapacityL * 0.8) / 10) * 10;
      const endFuel = Math.max(5, Math.round((startFuel + refuel - consumed) * 10) / 10);
      const endEh = Math.round((startEh + worked) * 10) / 10;

      const id = randomUUID();
      const near = (k: number) => ({ lat: BASE.lat + (rand() - 0.5) * k, lon: BASE.lon + (rand() - 0.5) * k });
      const sp = near(0.002);
      const ep = near(0.002);
      await shiftRepo.insert({
        id, orgId: org.id, driverId: d.id, vehicleId: v.id, baseId: base.id, status: day > 2 ? 'APPROVED' : 'CLOSED',
        startedAt: start, endedAt: end, startLat: sp.lat, startLon: sp.lon, startAccuracyM: 8 + rand() * 20, startInZone: true,
        startDistanceM: 50, endLat: ep.lat, endLon: ep.lon, endAccuracyM: 12, endInZone: true, mockLocation: false,
        startEngineHours: startEh, endEngineHours: endEh, startFuelL: startFuel, endFuelL: endFuel, driverNote: note,
        clientUpdatedAt: end, updatedAt: end,
      });
      for (const kind of ['START_HOURS', 'START_FUEL', 'END_HOURS', 'END_FUEL'] as const) {
        if (v.id === acros.id && day === 6 && kind === 'END_HOURS') continue; // «забыл» сфотографировать счётчик
        await photoRepo.insert({ id: randomUUID(), orgId: org.id, shiftId: id, kind, takenAt: kind.startsWith('START') ? start : end, uploadedBy: d.id });
      }
      if (refuel) {
        await refRepo.insert({
          id: randomUUID(), orgId: org.id, vehicleId: v.id, driverId: d.id, shiftId: id, liters: refuel,
          occurredAt: new Date(start.getTime() + 4 * 3_600_000), source: 'MANUAL', createdBy: d.id, clientUpdatedAt: end,
        });
      }
      await shiftsService.recompute(id);
      // Подозрительные смены оставляем на проверку модератору
      const fresh = await shiftRepo.findOneByOrFail({ id });
      if (fresh.anomalyCount > 0) await shiftRepo.update(id, { status: 'CLOSED', reviewedAt: null });
      state.set(v.id, { eh: endEh, fuel: endFuel });
    }
  }

  // --- телеметрия Кировца за последние сутки, со сливом 60 л ночью ---
  const st = state.get(kirovets.id)!;
  const records = [];
  let fuelPct = (st.fuel / kirovets.tankCapacityL) * 100;
  const t0 = Date.now() - 24 * 3_600_000;
  const mskHour = (m: number) => (new Date(t0 + m * 60_000).getUTCHours() + 3) % 24;
  let drainStart = 0;
  while (mskHour(drainStart) !== 2) drainStart += 2; // слив в 2 часа ночи, техника стоит
  for (let m = 0; m < 24 * 60; m += 2) {
    const working = mskHour(m) >= 8 && mskHour(m) < 18;
    if (working) fuelPct -= (28 / 60) * 2 / kirovets.tankCapacityL * 100;
    if (m >= drainStart && m < drainStart + 12) fuelPct -= (60 / 6) / kirovets.tankCapacityL * 100; // слив
    records.push({
      ts: new Date(t0 + m * 60_000), lat: BASE.lat + (working ? 0.01 * Math.sin(m / 50) : 0), lon: BASE.lon + (working ? 0.01 * Math.cos(m / 50) : 0),
      speedKmh: working ? 9 + (m % 5) : 0, course: 0, altitude: 150, satellites: 10,
      params: { io89: Math.round(fuelPct * 10) / 10 + Math.sin(m) * 0.3, io102: Math.round(st.eh * 60), io239: working ? 1 : 0 },
    });
  }
  await telemetry.ingest(kirovets, records);
  await telemetry.analyzeVehicle(kirovets, new Date(t0), new Date());

  console.log('Готово! Логины: admin/admin123, moderator/moder123, водители ivanov/1111, petrov/2222, sidorov/3333, superadmin/superadmin');
  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
