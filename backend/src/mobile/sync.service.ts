/**
 * Идемпотентная синхронизация офлайн-данных с телефона.
 *
 * Принципы:
 *  1. Каждый объект имеет UUID, сгенерированный на телефоне. Повторная отправка — не дубль, а upsert.
 *  2. При конфликте побеждает версия с более поздним clientUpdatedAt.
 *  3. Смены, уже проверенные модератором (APPROVED/REJECTED), телефон изменить не может.
 *  4. Сервер НЕ доверяет телефону в вопросе геозоны — перепроверяет координаты через PostGIS.
 *  5. Ответ по каждому объекту: ok (больше не отправлять) или rejected (ошибка данных — показать водителю).
 *     Временные сбои (БД недоступна и т.п.) — это HTTP 5xx: телефон просто повторит позже.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { AuthUser } from '../common/auth';
import { Photo, Refueling, Shift, Vehicle } from '../entities';
import { ShiftsService } from '../shifts/shifts.service';
import { ItemResult, PhotoMetaDto, RefuelSyncDto, ShiftSyncDto, SyncRequestDto } from './sync.dto';

@Injectable()
export class SyncService {
  private readonly log = new Logger(SyncService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectRepository(Shift) private readonly shifts: Repository<Shift>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Refueling) private readonly refuels: Repository<Refueling>,
    @InjectRepository(Photo) private readonly photos: Repository<Photo>,
    private readonly shiftsService: ShiftsService,
  ) {}

  async sync(user: AuthUser, orgId: string, req: SyncRequestDto) {
    const touched = new Set<string>(); // смены, которые надо пересчитать
    const vehicleIds = new Set(
      (await this.vehicles.find({ where: { orgId, isActive: true }, select: { id: true } })).map((v) => v.id),
    );

    const shiftResults: ItemResult[] = [];
    for (const s of req.shifts ?? []) shiftResults.push(await this.upsertShift(user, orgId, s, vehicleIds, req.deviceId, touched));

    const refuelResults: ItemResult[] = [];
    for (const r of req.refuelings ?? []) refuelResults.push(await this.upsertRefuel(user, orgId, r, vehicleIds, touched));

    const photoResults: ItemResult[] = [];
    for (const p of req.photos ?? []) photoResults.push(await this.upsertPhotoMeta(user, orgId, p, touched));

    const trackShiftsAccepted = await this.insertTrack(user, orgId, req);

    for (const id of touched) await this.shiftsService.recompute(id);

    // Возвращаем актуальный статус смен водителя за 30 дней — телефон покажет «принята/отклонена»
    const states = await this.shifts.find({
      where: { driverId: user.id },
      order: { startedAt: 'DESC' },
      take: 50,
      select: { id: true, status: true, reviewComment: true, anomalyCount: true, startInZone: true, fuelConsumedL: true, engineHours: true },
    });

    return {
      serverTime: new Date().toISOString(),
      shifts: shiftResults,
      refuelings: refuelResults,
      photos: photoResults,
      trackShiftsAccepted,
      shiftStates: states,
    };
  }

  private async upsertShift(
    user: AuthUser,
    orgId: string,
    s: ShiftSyncDto,
    vehicleIds: Set<string>,
    deviceId: string | undefined,
    touched: Set<string>,
  ): Promise<ItemResult> {
    const reject = (reason: string): ItemResult => ({ id: s.id, result: 'rejected', reason });
    if (!vehicleIds.has(s.vehicleId)) return reject('Техника не найдена или отключена');
    const started = new Date(s.startedAt);
    const ended = s.endedAt ? new Date(s.endedAt) : null;
    if (started.getTime() > Date.now() + 10 * 60_000) return reject('Время начала в будущем — проверьте часы телефона');
    if (ended && ended < started) return reject('Окончание раньше начала');
    if (ended && (s.endEngineHours == null || s.endFuelL == null)) return reject('Для закрытия смены нужны показания');

    const existing = await this.shifts.findOneBy({ id: s.id });
    if (existing && (existing.driverId !== user.id || existing.orgId !== orgId)) return reject('Смена принадлежит другому водителю');
    if (existing && (existing.status === 'APPROVED' || existing.status === 'REJECTED')) {
      return { id: s.id, result: 'ok', reason: 'Смена уже проверена модератором, изменения не приняты' };
    }

    const mock = !!s.mockLocation;
    const start = await this.shiftsService.checkZone(orgId, s.startLat, s.startLon, s.startAccuracyM, mock);
    const end =
      ended && s.endLat != null && s.endLon != null
        ? await this.shiftsService.checkZone(orgId, s.endLat, s.endLon, s.endAccuracyM ?? 9999, mock)
        : null;

    // Атомарный upsert: обновляем только если пришла более свежая версия и смена ещё не проверена
    const rows: { id: string }[] = await this.db.query(
      `INSERT INTO shifts (id, org_id, driver_id, vehicle_id, base_id, status, started_at, ended_at,
                           start_lat, start_lon, start_accuracy_m, start_in_zone, start_distance_m,
                           end_lat, end_lon, end_accuracy_m, end_in_zone, mock_location,
                           start_engine_hours, end_engine_hours, start_fuel_l, end_fuel_l, driver_note,
                           device_id, client_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (id) DO UPDATE SET
         vehicle_id = EXCLUDED.vehicle_id, base_id = EXCLUDED.base_id, status = EXCLUDED.status,
         started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at,
         start_lat = EXCLUDED.start_lat, start_lon = EXCLUDED.start_lon, start_accuracy_m = EXCLUDED.start_accuracy_m,
         start_in_zone = EXCLUDED.start_in_zone, start_distance_m = EXCLUDED.start_distance_m,
         end_lat = EXCLUDED.end_lat, end_lon = EXCLUDED.end_lon, end_accuracy_m = EXCLUDED.end_accuracy_m,
         end_in_zone = EXCLUDED.end_in_zone, mock_location = shifts.mock_location OR EXCLUDED.mock_location,
         start_engine_hours = EXCLUDED.start_engine_hours, end_engine_hours = EXCLUDED.end_engine_hours,
         start_fuel_l = EXCLUDED.start_fuel_l, end_fuel_l = EXCLUDED.end_fuel_l, driver_note = EXCLUDED.driver_note,
         device_id = EXCLUDED.device_id, client_updated_at = EXCLUDED.client_updated_at, updated_at = now()
       WHERE shifts.client_updated_at < EXCLUDED.client_updated_at
         AND shifts.status IN ('OPEN','CLOSED')
         AND shifts.driver_id = EXCLUDED.driver_id
       RETURNING id`,
      [
        s.id, orgId, user.id, s.vehicleId, start.baseId, ended ? 'CLOSED' : 'OPEN', started, ended,
        s.startLat, s.startLon, s.startAccuracyM, start.inZone, start.distanceM,
        s.endLat ?? null, s.endLon ?? null, s.endAccuracyM ?? null, end ? end.inZone : null, mock,
        s.startEngineHours, s.endEngineHours ?? null, s.startFuelL, s.endFuelL ?? null, s.driverNote ?? null,
        deviceId ?? null, new Date(s.clientUpdatedAt),
      ],
    );
    if (rows.length) touched.add(s.id); // изменилось — пересчитать; иначе это повтор, ничего не делаем
    return { id: s.id, result: 'ok' };
  }

  private async upsertRefuel(
    user: AuthUser,
    orgId: string,
    r: RefuelSyncDto,
    vehicleIds: Set<string>,
    touched: Set<string>,
  ): Promise<ItemResult> {
    const reject = (reason: string): ItemResult => ({ id: r.id, result: 'rejected', reason });
    if (!vehicleIds.has(r.vehicleId)) return reject('Техника не найдена');
    if (r.shiftId) {
      const sh = await this.shifts.findOneBy({ id: r.shiftId });
      // Смена ещё не дошла до сервера — это временная ситуация: не отклоняем, а просим повторить
      if (!sh) return reject('RETRY: смена ещё не синхронизирована');
      if (sh.driverId !== user.id) return reject('Чужая смена');
      if (sh.status === 'APPROVED' || sh.status === 'REJECTED') return reject('Смена уже проверена модератором');
    }
    const existing = await this.refuels.findOneBy({ id: r.id });
    if (existing && existing.driverId !== user.id) return reject('Чужая заправка');
    if (existing && existing.clientUpdatedAt >= new Date(r.clientUpdatedAt)) return { id: r.id, result: 'ok' };
    await this.refuels.save(
      this.refuels.create({
        id: r.id,
        orgId,
        vehicleId: r.vehicleId,
        driverId: user.id,
        shiftId: r.shiftId ?? null,
        liters: r.liters,
        occurredAt: new Date(r.occurredAt),
        lat: r.lat ?? null,
        lon: r.lon ?? null,
        source: 'MANUAL',
        note: r.note ?? null,
        createdBy: user.id,
        clientUpdatedAt: new Date(r.clientUpdatedAt),
      }),
    );
    if (r.shiftId) touched.add(r.shiftId);
    if (existing?.shiftId) touched.add(existing.shiftId);
    if (!r.shiftId) {
      // заправка между сменами влияет на проверку следующей смены этой техники
      const next = await this.shifts
        .createQueryBuilder('s')
        .where('s.vehicle_id = :v AND s.started_at >= :t', { v: r.vehicleId, t: new Date(r.occurredAt) })
        .orderBy('s.started_at', 'ASC')
        .getOne();
      if (next) touched.add(next.id);
    }
    return { id: r.id, result: 'ok' };
  }

  private async upsertPhotoMeta(user: AuthUser, orgId: string, p: PhotoMetaDto, touched: Set<string>): Promise<ItemResult> {
    const reject = (reason: string): ItemResult => ({ id: p.id, result: 'rejected', reason });
    if (!p.shiftId && !p.refuelingId) return reject('Фото не привязано к смене или заправке');
    if (p.shiftId) {
      const sh = await this.shifts.findOneBy({ id: p.shiftId });
      if (!sh) return reject('RETRY: смена ещё не синхронизирована');
      if (sh.driverId !== user.id) return reject('Чужая смена');
    }
    if (p.refuelingId) {
      const rf = await this.refuels.findOneBy({ id: p.refuelingId });
      if (!rf) return reject('RETRY: заправка ещё не синхронизирована');
      if (rf.driverId !== user.id) return reject('Чужая заправка');
    }
    const existing = await this.photos.findOneBy({ id: p.id });
    if (existing) return { id: p.id, result: 'ok' };
    await this.photos.insert({
      id: p.id,
      orgId,
      shiftId: p.shiftId ?? null,
      refuelingId: p.refuelingId ?? null,
      kind: p.kind,
      takenAt: new Date(p.takenAt),
      lat: p.lat ?? null,
      lon: p.lon ?? null,
      sha256: p.sha256 ?? null,
      uploadedBy: user.id,
    });
    if (p.shiftId) touched.add(p.shiftId);
    return { id: p.id, result: 'ok' };
  }

  /** Точки трека вставляются пачкой; дубли (shift_id, ts) молча пропускаются. */
  private async insertTrack(user: AuthUser, orgId: string, req: SyncRequestDto): Promise<string[]> {
    const pts = req.trackPoints ?? [];
    if (!pts.length) return [];
    const shiftIds = [...new Set(pts.map((p) => p.shiftId))];
    const own = new Set(
      (await this.shifts.find({ where: { id: In(shiftIds), driverId: user.id }, select: { id: true } })).map((s) => s.id),
    );
    const ok = pts.filter((p) => own.has(p.shiftId));
    if (!ok.length) return [];
    await this.db.query(
      `INSERT INTO track_points (org_id, shift_id, ts, lat, lon, accuracy_m, speed_kmh)
       SELECT $1, t.shift_id, t.ts, t.lat, t.lon, t.acc, t.spd
         FROM unnest($2::uuid[], $3::timestamptz[], $4::float8[], $5::float8[], $6::real[], $7::real[])
              AS t(shift_id, ts, lat, lon, acc, spd)
       ON CONFLICT (shift_id, ts) DO NOTHING`,
      [
        orgId,
        ok.map((p) => p.shiftId),
        ok.map((p) => p.ts),
        ok.map((p) => p.lat),
        ok.map((p) => p.lon),
        ok.map((p) => p.accuracyM ?? null),
        ok.map((p) => p.speedKmh ?? null),
      ],
    );
    // Точки «чужих» или ещё не синхронизированных смен отбрасываются — телефон отправит их повторно.
    // Возвращаем id смен, точки которых приняты: только их телефон удаляет из очереди.
    return [...own];
  }
}
