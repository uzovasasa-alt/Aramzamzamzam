/**
 * Приём и анализ телеметрии с трекеров (этап 2).
 * Приложение водителя при этом не меняется: данные датчиков просто добавляют
 * ещё один независимый источник правды, с которым сверяются ручные показания.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AnomaliesService } from '../anomalies/anomalies.service';
import { OrgSettingsService } from '../directory/org-settings.service';
import { decodeSensors, SensorMapping } from '../domain/sensor-mapping';
import { detectFuelEvents, FuelEvent, TelemetrySample } from '../domain/telemetry-analysis';
import { Vehicle } from '../entities';
import { TrackerRecord } from './parsers/types';

@Injectable()
export class TelemetryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TelemetryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    private readonly anomalies: AnomaliesService,
    private readonly settings: OrgSettingsService,
  ) {}

  onModuleInit() {
    // Раз в 5 минут ищем сливы/заправки/движение без смены по свежей телеметрии
    if (process.env.NODE_ENV !== 'test') {
      this.timer = setInterval(() => this.analyzeRecent().catch((e) => this.log.error(e)), 5 * 60_000);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  findByImei(imei: string) {
    return this.vehicles.findOneBy({ trackerImei: imei, isActive: true });
  }

  /** Сохранить пачку точек от трекера. Дубликаты (тот же vehicle+ts) игнорируются. */
  async ingest(vehicle: Vehicle, records: TrackerRecord[]): Promise<number> {
    if (!records.length) return 0;
    const now = Date.now();
    const rows = records
      // трекеры с неустановленным временем шлют 1970 или 2000 год — отбрасываем
      .filter((r) => r.ts.getTime() > Date.parse('2020-01-01') && r.ts.getTime() < now + 10 * 60_000)
      .map((r) => {
        const d = decodeSensors(r.params, vehicle.sensorMapping as SensorMapping | null, vehicle.tankCapacityL);
        return { ...r, ...d };
      });
    if (!rows.length) return 0;
    await this.db.query(
      `INSERT INTO telemetry (org_id, vehicle_id, ts, lat, lon, speed_kmh, fuel_l, engine_hours, ignition, params)
       SELECT $1, $2, t.ts, t.lat, t.lon, t.spd, t.fuel, t.eh, t.ign, t.params
         FROM unnest($3::timestamptz[], $4::float8[], $5::float8[], $6::real[], $7::numeric[], $8::numeric[], $9::boolean[], $10::jsonb[])
              AS t(ts, lat, lon, spd, fuel, eh, ign, params)
       ON CONFLICT (vehicle_id, ts) DO NOTHING`,
      [
        vehicle.orgId,
        vehicle.id,
        rows.map((r) => r.ts.toISOString()),
        rows.map((r) => r.lat),
        rows.map((r) => r.lon),
        rows.map((r) => r.speedKmh),
        rows.map((r) => r.fuelL),
        rows.map((r) => r.engineHours),
        rows.map((r) => r.ignition),
        rows.map((r) => JSON.stringify(r.params)),
      ],
    );
    const last = rows.reduce((a, b) => (a.ts > b.ts ? a : b));
    if (!vehicle.lastSeenAt || last.ts > vehicle.lastSeenAt) {
      await this.vehicles.update(vehicle.id, {
        lastSeenAt: last.ts,
        lastLat: last.lat ?? vehicle.lastLat,
        lastLon: last.lon ?? vehicle.lastLon,
        lastSpeedKmh: last.speedKmh,
        lastFuelL: last.fuelL ?? vehicle.lastFuelL,
        lastEngineHours: last.engineHours ?? vehicle.lastEngineHours,
        lastIgnition: last.ignition,
      });
    }
    return rows.length;
  }

  async samples(vehicleId: string, from: Date, to: Date): Promise<TelemetrySample[]> {
    const rows: { ts: Date; fuel_l: string | null; speed_kmh: number | null; ignition: boolean | null; engine_hours: string | null }[] =
      await this.db.query(
        `SELECT ts, fuel_l, speed_kmh, ignition, engine_hours FROM telemetry
          WHERE vehicle_id = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts`,
        [vehicleId, from, to],
      );
    return rows.map((r) => ({
      ts: new Date(r.ts),
      fuelL: r.fuel_l == null ? null : Number(r.fuel_l),
      speedKmh: r.speed_kmh,
      ignition: r.ignition,
      engineHours: r.engine_hours == null ? null : Number(r.engine_hours),
    }));
  }

  async events(vehicle: Vehicle, from: Date, to: Date): Promise<FuelEvent[]> {
    const s = await this.settings.get(vehicle.orgId);
    return detectFuelEvents(await this.samples(vehicle.id, from, to), { minLiters: s.drainMinLiters, windowMin: s.drainWindowMin });
  }

  /** Анализ последних 6 часов по всем технике с датчиками. Повторный запуск не создаёт дубли (dedupe_key). */
  async analyzeRecent(hours = 6): Promise<void> {
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3_600_000);
    const active = await this.vehicles
      .createQueryBuilder('v')
      .where('v.tracker_imei IS NOT NULL AND v.last_seen_at >= :from', { from })
      .getMany();
    for (const v of active) {
      try {
        await this.analyzeVehicle(v, from, to);
      } catch (e) {
        this.log.error(`Анализ ${v.name}: ${e}`);
      }
    }
  }

  async analyzeVehicle(v: Vehicle, from: Date, to: Date): Promise<void> {
    const s = await this.settings.get(v.orgId);
    const samples = await this.samples(v.id, from, to);
    const events = detectFuelEvents(samples, { minLiters: s.drainMinLiters, windowMin: s.drainWindowMin });
    const minuteKey = (d: Date) => d.toISOString().slice(0, 16);

    for (const e of events) {
      const shift = await this.shiftAt(v.id, e.startTs);
      const ctx = { orgId: v.orgId, vehicleId: v.id, shiftId: shift?.id ?? null, driverId: shift?.driver_id ?? null, occurredAt: e.startTs };
      if (e.kind === 'DRAIN') {
        await this.anomalies.raise(
          ctx,
          {
            type: 'SENSOR_FUEL_DRAIN',
            severity: 'HIGH',
            message: `Уровень топлива упал с ${e.fromL} до ${e.toL} л (${e.deltaL} л) за ${minutes(e)} мин на стоянке.`,
            details: { ...e },
          },
          `drain:${v.id}:${minuteKey(e.startTs)}`,
        );
      } else {
        // Заправка по датчику — ищем зарегистрированную в ±45 минут
        const [reg] = await this.db.query(
          `SELECT id FROM refuelings WHERE vehicle_id = $1 AND occurred_at BETWEEN $2::timestamptz - interval '45 minutes' AND $3::timestamptz + interval '45 minutes' LIMIT 1`,
          [v.id, e.startTs, e.endTs],
        );
        if (!reg) {
          await this.anomalies.raise(
            ctx,
            {
              type: 'SENSOR_UNREGISTERED_REFUEL',
              severity: 'LOW',
              message: `Датчик зафиксировал заправку +${e.deltaL} л, но в системе её нет.`,
              details: { ...e },
            },
            `refuel:${v.id}:${minuteKey(e.startTs)}`,
          );
        }
      }
    }

    // Движение без смены: скорость > 5 км/ч дольше 10 минут вне любой смены
    const moving = samples.filter((p) => (p.speedKmh ?? 0) > 5);
    if (moving.length) {
      const shifts: { started_at: Date; ended_at: Date | null }[] = await this.db.query(
        `SELECT started_at, ended_at FROM shifts WHERE vehicle_id = $1 AND started_at <= $3 AND (ended_at IS NULL OR ended_at >= $2)`,
        [v.id, from, to],
      );
      const covered = (t: Date) => shifts.some((sh) => sh.started_at <= t && (!sh.ended_at || sh.ended_at >= t));
      const free = moving.filter((p) => !covered(p.ts));
      if (free.length >= 2 && free[free.length - 1].ts.getTime() - free[0].ts.getTime() >= 10 * 60_000) {
        const hourKey = free[0].ts.toISOString().slice(0, 13);
        await this.anomalies.raise(
          { orgId: v.orgId, vehicleId: v.id, occurredAt: free[0].ts },
          {
            type: 'MOVEMENT_WITHOUT_SHIFT',
            severity: 'MEDIUM',
            message: `Техника двигалась без открытой смены с ${fmt(free[0].ts)} до ${fmt(free[free.length - 1].ts)}.`,
            details: { from: free[0].ts, to: free[free.length - 1].ts, points: free.length },
          },
          `moving:${v.id}:${hourKey}`,
        );
      }
    }
  }

  private async shiftAt(vehicleId: string, t: Date): Promise<{ id: string; driver_id: string } | null> {
    const [row] = await this.db.query(
      `SELECT id, driver_id FROM shifts WHERE vehicle_id = $1 AND started_at <= $2 AND (ended_at IS NULL OR ended_at >= $2)
        ORDER BY started_at DESC LIMIT 1`,
      [vehicleId, t],
    );
    return row ?? null;
  }
}

const minutes = (e: FuelEvent) => Math.max(1, Math.round((e.endTs.getTime() - e.startTs.getTime()) / 60_000));
const fmt = (d: Date) => d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
