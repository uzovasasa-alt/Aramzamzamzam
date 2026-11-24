/**
 * Пересчёт итогов смены и запуск правил антифрода.
 * Вызывается после каждой синхронизации смены, загрузки фото, добавления заправки.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AnomaliesService } from '../anomalies/anomalies.service';
import { OrgSettingsService } from '../directory/org-settings.service';
import { AnomalyDraft, analyzeShift, computeTotals, PrevShiftFacts } from '../domain/rules';
import { sensorFuelAt, TelemetrySample } from '../domain/telemetry-analysis';
import { Photo, Refueling, Shift, Vehicle } from '../entities';

export interface ZoneCheck {
  baseId: string | null;
  inZone: boolean;
  distanceM: number | null;
}

@Injectable()
export class ShiftsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectRepository(Shift) private readonly shifts: Repository<Shift>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Refueling) private readonly refuels: Repository<Refueling>,
    @InjectRepository(Photo) private readonly photos: Repository<Photo>,
    private readonly anomalies: AnomaliesService,
    private readonly settings: OrgSettingsService,
  ) {}

  /** Проверка геозоны средствами PostGIS: ближайшая активная база хозяйства и расстояние до её центра. */
  async checkZone(orgId: string, lat: number, lon: number, accuracyM: number, mock: boolean): Promise<ZoneCheck> {
    const s = await this.settings.get(orgId);
    const rows: { id: string; distance: number; radius_m: number }[] = await this.db.query(
      `SELECT id, radius_m, ST_Distance(location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) AS distance
         FROM bases
        WHERE org_id = $1 AND is_active
        ORDER BY location <-> ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
        LIMIT 1`,
      [orgId, lon, lat],
    );
    if (!rows.length) return { baseId: null, inZone: false, distanceM: null };
    const r = rows[0];
    const distance = Number(r.distance);
    const inZone = !mock && accuracyM <= s.maxGpsAccuracyM && distance <= r.radius_m;
    return { baseId: r.id, inZone, distanceM: Math.round(distance) };
  }

  /** Полный пересчёт смены. Идемпотентен: можно вызывать сколько угодно раз. */
  async recompute(shiftId: string): Promise<Shift | null> {
    const shift = await this.shifts.findOneBy({ id: shiftId });
    if (!shift) return null;
    const vehicle = await this.vehicles.findOneByOrFail({ id: shift.vehicleId });
    const s = await this.settings.get(shift.orgId);

    const refuels = await this.refuels.find({ where: { shiftId: shift.id } });
    const photos = await this.photos.find({ where: { shiftId: shift.id }, select: { kind: true } });
    const prev = await this.previousShift(shift);

    const facts = {
      ...shift,
      photos,
    };
    const vehicleInfo = {
      id: vehicle.id,
      name: vehicle.name,
      tankCapacityL: vehicle.tankCapacityL,
      fuelNormLph: vehicle.fuelNormLph,
      normTolerancePct: vehicle.normTolerancePct,
    };
    const totals = computeTotals(facts, vehicleInfo, refuels);
    const drafts: AnomalyDraft[] = analyzeShift(facts, vehicleInfo, refuels, prev, s);
    drafts.push(...(await this.compareWithSensor(shift, s.sensorManualMismatchL)));

    const count = await this.anomalies.syncShiftAnomalies(
      { orgId: shift.orgId, shiftId: shift.id, vehicleId: shift.vehicleId, driverId: shift.driverId, occurredAt: shift.startedAt },
      drafts,
    );

    await this.shifts.update(shift.id, {
      engineHours: totals.engineHours,
      fuelConsumedL: totals.fuelConsumedL,
      refueledL: totals.refueledL,
      normL: totals.normL,
      overNormPct: totals.overNormPct,
      anomalyCount: count,
      updatedAt: new Date(),
    });

    // Для техники без датчиков «последнее известное состояние» берём из последней закрытой смены
    if (shift.endedAt && !vehicle.trackerImei) {
      const latest = await this.shifts.findOne({
        where: { vehicleId: vehicle.id },
        order: { startedAt: 'DESC' },
      });
      if (latest?.id === shift.id) {
        await this.vehicles.update(vehicle.id, {
          lastEngineHours: shift.endEngineHours,
          lastFuelL: shift.endFuelL,
          lastSeenAt: shift.endedAt,
          lastLat: shift.endLat,
          lastLon: shift.endLon,
        });
      }
    }
    return this.shifts.findOneBy({ id: shift.id });
  }

  private async previousShift(shift: Shift): Promise<PrevShiftFacts | null> {
    const rows: Shift[] = await this.shifts
      .createQueryBuilder('s')
      .where('s.vehicle_id = :v', { v: shift.vehicleId })
      .andWhere('s.started_at < :t', { t: shift.startedAt })
      .andWhere('s.ended_at IS NOT NULL')
      .andWhere(`s.status <> 'REJECTED'`)
      .orderBy('s.started_at', 'DESC')
      .limit(1)
      .getMany();
    const p = rows[0];
    if (!p || p.endEngineHours == null || p.endFuelL == null || !p.endedAt) return null;
    const between: { sum: string } | undefined = await this.refuels
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.liters), 0)', 'sum')
      .where('r.vehicle_id = :v', { v: shift.vehicleId })
      .andWhere('r.shift_id IS NULL')
      .andWhere('r.occurred_at >= :a AND r.occurred_at <= :b', { a: p.endedAt, b: shift.startedAt })
      .getRawOne();
    return {
      id: p.id,
      endedAt: p.endedAt,
      endEngineHours: p.endEngineHours,
      endFuelL: p.endFuelL,
      refueledSinceL: Number(between?.sum ?? 0),
    };
  }

  /** Если на технике стоит ДУТ — сверяем то, что ввёл водитель, с показаниями датчика. */
  private async compareWithSensor(shift: Shift, thresholdL: number): Promise<AnomalyDraft[]> {
    const from = new Date(shift.startedAt.getTime() - 15 * 60_000);
    const to = new Date((shift.endedAt ?? shift.startedAt).getTime() + 15 * 60_000);
    const rows: { ts: Date; fuel_l: string | null }[] = await this.db.query(
      `SELECT ts, fuel_l FROM telemetry WHERE vehicle_id = $1 AND ts BETWEEN $2 AND $3 AND fuel_l IS NOT NULL ORDER BY ts`,
      [shift.vehicleId, from, to],
    );
    if (!rows.length) return [];
    const samples: TelemetrySample[] = rows.map((r) => ({ ts: new Date(r.ts), fuelL: Number(r.fuel_l), speedKmh: null, ignition: null }));
    const out: AnomalyDraft[] = [];
    const check = (label: string, manual: number | null, at: Date | null) => {
      if (manual == null || !at) return;
      const sensor = sensorFuelAt(samples, at);
      if (sensor == null) return;
      const diff = Math.round((manual - sensor) * 10) / 10;
      if (Math.abs(diff) > thresholdL) {
        out.push({
          type: 'SENSOR_MANUAL_MISMATCH',
          severity: 'MEDIUM',
          message: `${label}: водитель указал ${manual} л, датчик показывает ${sensor} л (разница ${diff} л).`,
          details: { manual, sensor, diff, at },
        });
      }
    };
    check('Начало смены', shift.startFuelL, shift.startedAt);
    check('Конец смены', shift.endFuelL, shift.endedAt);
    // Две проверки одного типа сливаем в одну аномалию (ключ дедупликации — по типу)
    if (out.length === 2) {
      out[0].message += ' ' + out[1].message;
      out.pop();
    }
    return out;
  }

  /** Открытая смена водителя (для подсказок мобильному приложению) */
  openShiftOf(driverId: string) {
    return this.shifts.findOne({ where: { driverId, endedAt: IsNull() }, order: { startedAt: 'DESC' } });
  }
}
