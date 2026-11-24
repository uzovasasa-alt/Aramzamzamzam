/**
 * Сущности TypeORM. Схема создаётся миграцией (synchronize выключен),
 * здесь только отображение таблиц на классы.
 */
import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn, ValueTransformer } from 'typeorm';

/** pg возвращает numeric строкой — переводим в number */
export const num: ValueTransformer = {
  to: (v: number | null | undefined) => v,
  from: (v: string | null) => (v == null ? null : Number(v)),
};

export type Role = 'SUPERADMIN' | 'ADMIN' | 'MODERATOR' | 'DRIVER';
export type ShiftStatus = 'OPEN' | 'CLOSED' | 'APPROVED' | 'REJECTED';
export type PhotoKind = 'START_HOURS' | 'START_FUEL' | 'END_HOURS' | 'END_FUEL' | 'REFUEL_RECEIPT' | 'REFUEL_METER';

@Entity('organizations')
export class Organization {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() name: string;
  @Column({ type: 'text', nullable: true }) inn: string | null;
  /** Пороги антифрода (см. OrgSettings) и telegramChatId */
  @Column({ type: 'jsonb', default: {} }) settings: Record<string, any>;
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'org_id', type: 'uuid', nullable: true }) orgId: string | null;
  @Column({ type: 'text' }) role: Role;
  @Column({ name: 'full_name' }) fullName: string;
  @Column() login: string;
  @Column({ type: 'text', nullable: true }) phone: string | null;
  @Column({ name: 'password_hash', select: false }) passwordHash: string;
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @Column({ name: 'token_version', default: 0 }) tokenVersion: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity('bases')
export class Base {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'org_id', type: 'uuid' }) orgId: string;
  @Column() name: string;
  @Column({ type: 'double precision' }) lat: number;
  @Column({ type: 'double precision' }) lon: number;
  @Column({ name: 'radius_m', type: 'int' }) radiusM: number;
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity('vehicles')
export class Vehicle {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'org_id', type: 'uuid' }) orgId: string;
  @Column() name: string;
  @Column({ type: 'text', default: 'TRACTOR' }) kind: string;
  @Column({ name: 'reg_number', type: 'text', nullable: true }) regNumber: string | null;
  @Column({ name: 'tank_capacity_l', type: 'numeric', transformer: num }) tankCapacityL: number;
  @Column({ name: 'fuel_norm_lph', type: 'numeric', nullable: true, transformer: num }) fuelNormLph: number | null;
  @Column({ name: 'norm_tolerance_pct', type: 'numeric', nullable: true, transformer: num }) normTolerancePct: number | null;
  @Column({ name: 'tracker_imei', type: 'text', nullable: true }) trackerImei: string | null;
  @Column({ name: 'tracker_protocol', type: 'text', nullable: true }) trackerProtocol: string | null;
  @Column({ name: 'sensor_mapping', type: 'jsonb', nullable: true }) sensorMapping: Record<string, any> | null;
  @Column({ name: 'last_engine_hours', type: 'numeric', nullable: true, transformer: num }) lastEngineHours: number | null;
  @Column({ name: 'last_fuel_l', type: 'numeric', nullable: true, transformer: num }) lastFuelL: number | null;
  @Column({ name: 'last_lat', type: 'double precision', nullable: true }) lastLat: number | null;
  @Column({ name: 'last_lon', type: 'double precision', nullable: true }) lastLon: number | null;
  @Column({ name: 'last_speed_kmh', type: 'numeric', nullable: true, transformer: num }) lastSpeedKmh: number | null;
  @Column({ name: 'last_ignition', type: 'boolean', nullable: true }) lastIgnition: boolean | null;
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true }) lastSeenAt: Date | null;
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity('shifts')
export class Shift {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'org_id', type: 'uuid' }) orgId: string;
  @Column({ name: 'driver_id', type: 'uuid' }) driverId: string;
  @Column({ name: 'vehicle_id', type: 'uuid' }) vehicleId: string;
  @Column({ name: 'base_id', type: 'uuid', nullable: true }) baseId: string | null;
  @Column({ type: 'text' }) status: ShiftStatus;
  @Column({ name: 'started_at', type: 'timestamptz' }) startedAt: Date;
  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true }) endedAt: Date | null;
  @Column({ name: 'start_lat', type: 'double precision' }) startLat: number;
  @Column({ name: 'start_lon', type: 'double precision' }) startLon: number;
  @Column({ name: 'start_accuracy_m', type: 'real' }) startAccuracyM: number;
  @Column({ name: 'start_in_zone', default: false }) startInZone: boolean;
  @Column({ name: 'start_distance_m', type: 'real', nullable: true }) startDistanceM: number | null;
  @Column({ name: 'end_lat', type: 'double precision', nullable: true }) endLat: number | null;
  @Column({ name: 'end_lon', type: 'double precision', nullable: true }) endLon: number | null;
  @Column({ name: 'end_accuracy_m', type: 'real', nullable: true }) endAccuracyM: number | null;
  @Column({ name: 'end_in_zone', type: 'boolean', nullable: true }) endInZone: boolean | null;
  @Column({ name: 'mock_location', default: false }) mockLocation: boolean;
  @Column({ name: 'start_engine_hours', type: 'numeric', transformer: num }) startEngineHours: number;
  @Column({ name: 'end_engine_hours', type: 'numeric', nullable: true, transformer: num }) endEngineHours: number | null;
  @Column({ name: 'start_fuel_l', type: 'numeric', transformer: num }) startFuelL: number;
  @Column({ name: 'end_fuel_l', type: 'numeric', nullable: true, transformer: num }) endFuelL: number | null;
  @Column({ name: 'driver_note', type: 'text', nullable: true }) driverNote: string | null;
  @Column({ name: 'engine_hours', type: 'numeric', nullable: true, transformer: num }) engineHours: number | null;
  @Column({ name: 'fuel_consumed_l', type: 'numeric', nullable: true, transformer: num }) fuelConsumedL: number | null;
  @Column({ name: 'refueled_l', type: 'numeric', nullable: true, transformer: num }) refueledL: number | null;
  @Column({ name: 'norm_l', type: 'numeric', nullable: true, transformer: num }) normL: number | null;
  @Column({ name: 'over_norm_pct', type: 'numeric', nullable: true, transformer: num }) overNormPct: number | null;
  @Column({ name: 'anomaly_count', default: 0 }) anomalyCount: number;
  @Column({ name: 'review_comment', type: 'text', nullable: true }) reviewComment: string | null;
  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true }) reviewedBy: string | null;
  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true }) reviewedAt: Date | null;
  @Column({ name: 'device_id', type: 'text', nullable: true }) deviceId: string | null;
  @Column({ name: 'client_updated_at', type: 'timestamptz' }) clientUpdatedAt: Date;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
}

@Entity('refuelings')
export class Refueling {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'org_id', type: 'uuid' }) orgId: string;
  @Column({ name: 'vehicle_id', type: 'uuid' }) vehicleId: string;
  @Column({ name: 'driver_id', type: 'uuid', nullable: true }) driverId: string | null;
  @Column({ name: 'shift_id', type: 'uuid', nullable: true }) shiftId: string | null;
  @Column({ type: 'numeric', transformer: num }) liters: number;
  @Column({ name: 'occurred_at', type: 'timestamptz' }) occurredAt: Date;
  @Column({ type: 'double precision', nullable: true }) lat: number | null;
  @Column({ type: 'double precision', nullable: true }) lon: number | null;
  @Column({ type: 'text', default: 'MANUAL' }) source: 'MANUAL' | 'FUEL_TRUCK' | 'SENSOR';
  @Column({ type: 'text', nullable: true }) note: string | null;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy: string | null;
  @Column({ name: 'client_updated_at', type: 'timestamptz' }) clientUpdatedAt: Date;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity('photos')
export class Photo {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'org_id', type: 'uuid' }) orgId: string;
  @Column({ name: 'shift_id', type: 'uuid', nullable: true }) shiftId: string | null;
  @Column({ name: 'refueling_id', type: 'uuid', nullable: true }) refuelingId: string | null;
  @Column({ type: 'text' }) kind: PhotoKind;
  @Column({ name: 'storage_key', type: 'text', nullable: true }) storageKey: string | null;
  @Column({ name: 'content_type', type: 'text', nullable: true }) contentType: string | null;
  @Column({ name: 'size_bytes', type: 'int', nullable: true }) sizeBytes: number | null;
  @Column({ type: 'text', nullable: true }) sha256: string | null;
  @Column({ name: 'taken_at', type: 'timestamptz' }) takenAt: Date;
  @Column({ type: 'double precision', nullable: true }) lat: number | null;
  @Column({ type: 'double precision', nullable: true }) lon: number | null;
  @Column({ name: 'uploaded_by', type: 'uuid', nullable: true }) uploadedBy: string | null;
  @Column({ name: 'uploaded_at', type: 'timestamptz', nullable: true }) uploadedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity('anomalies')
export class Anomaly {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'org_id', type: 'uuid' }) orgId: string;
  @Column({ name: 'vehicle_id', type: 'uuid', nullable: true }) vehicleId: string | null;
  @Column({ name: 'shift_id', type: 'uuid', nullable: true }) shiftId: string | null;
  @Column({ name: 'driver_id', type: 'uuid', nullable: true }) driverId: string | null;
  @Column({ type: 'text' }) type: string;
  @Column({ type: 'text' }) severity: 'LOW' | 'MEDIUM' | 'HIGH';
  @Column({ type: 'text', default: 'NEW' }) status: 'NEW' | 'CONFIRMED' | 'DISMISSED';
  @Column({ type: 'text' }) message: string;
  @Column({ type: 'jsonb', default: {} }) details: Record<string, any>;
  @Column({ name: 'occurred_at', type: 'timestamptz' }) occurredAt: Date;
  @Column({ name: 'dedupe_key', type: 'text' }) dedupeKey: string;
  @Column({ name: 'resolved_by', type: 'uuid', nullable: true }) resolvedBy: string | null;
  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true }) resolvedAt: Date | null;
  @Column({ name: 'resolution_comment', type: 'text', nullable: true }) resolutionComment: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

export const ENTITIES = [Organization, User, Base, Vehicle, Shift, Refueling, Photo, Anomaly];
