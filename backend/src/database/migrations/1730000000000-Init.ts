import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Начальная схема.
 * Координаты храним в обычных колонках lat/lon (удобно для ORM и мобильного клиента),
 * а PostGIS-колонка `location` вычисляется из них автоматически (GENERATED) —
 * по ней строятся пространственные индексы и запросы ST_DWithin.
 *
 * Идентификаторы смен, заправок и фото генерирует телефон (UUID) —
 * это и есть основа идемпотентной синхронизации: повторная отправка того же
 * объекта не создаёт дубликат, а обновляет (или игнорирует) существующую запись.
 */
export class Init1730000000000 implements MigrationInterface {
  name = 'Init1730000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await q.query(`
      CREATE TABLE organizations (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name        text NOT NULL,
        inn         text,
        settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_active   boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE users (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id         uuid REFERENCES organizations(id) ON DELETE CASCADE,
        role           text NOT NULL CHECK (role IN ('SUPERADMIN','ADMIN','MODERATOR','DRIVER')),
        full_name      text NOT NULL,
        login          text NOT NULL UNIQUE,
        phone          text,
        password_hash  text NOT NULL,
        is_active      boolean NOT NULL DEFAULT true,
        token_version  integer NOT NULL DEFAULT 0,
        created_at     timestamptz NOT NULL DEFAULT now(),
        CHECK (role = 'SUPERADMIN' OR org_id IS NOT NULL)
      )`);
    await q.query(`CREATE INDEX users_org_idx ON users(org_id)`);

    await q.query(`
      CREATE TABLE bases (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name        text NOT NULL,
        lat         double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
        lon         double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
        radius_m    integer NOT NULL CHECK (radius_m BETWEEN 20 AND 20000),
        location    geography(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) STORED,
        is_active   boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX bases_location_gix ON bases USING gist(location)`);

    await q.query(`
      CREATE TABLE vehicles (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name                text NOT NULL,
        kind                text NOT NULL DEFAULT 'TRACTOR' CHECK (kind IN ('TRACTOR','COMBINE','TRUCK','SPRAYER','LOADER','OTHER')),
        reg_number          text,
        tank_capacity_l     numeric(8,1) NOT NULL CHECK (tank_capacity_l > 0),
        fuel_norm_lph       numeric(6,2) CHECK (fuel_norm_lph > 0),
        norm_tolerance_pct  numeric(5,1) CHECK (norm_tolerance_pct >= 0),
        tracker_imei        text UNIQUE,
        tracker_protocol    text CHECK (tracker_protocol IN ('TELTONIKA','WIALON_IPS','HTTP')),
        sensor_mapping      jsonb,
        last_engine_hours   numeric(10,2),
        last_fuel_l         numeric(8,1),
        last_lat            double precision,
        last_lon            double precision,
        last_speed_kmh      numeric(6,1),
        last_ignition       boolean,
        last_seen_at        timestamptz,
        is_active           boolean NOT NULL DEFAULT true,
        created_at          timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX vehicles_org_idx ON vehicles(org_id)`);

    await q.query(`
      CREATE TABLE shifts (
        id                 uuid PRIMARY KEY,
        org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        driver_id          uuid NOT NULL REFERENCES users(id),
        vehicle_id         uuid NOT NULL REFERENCES vehicles(id),
        base_id            uuid REFERENCES bases(id),
        status             text NOT NULL CHECK (status IN ('OPEN','CLOSED','APPROVED','REJECTED')),
        started_at         timestamptz NOT NULL,
        ended_at           timestamptz,
        start_lat          double precision NOT NULL,
        start_lon          double precision NOT NULL,
        start_accuracy_m   real NOT NULL,
        start_in_zone      boolean NOT NULL DEFAULT false,
        start_distance_m   real,
        end_lat            double precision,
        end_lon            double precision,
        end_accuracy_m     real,
        end_in_zone        boolean,
        mock_location      boolean NOT NULL DEFAULT false,
        start_engine_hours numeric(10,2) NOT NULL,
        end_engine_hours   numeric(10,2),
        start_fuel_l       numeric(8,1) NOT NULL,
        end_fuel_l         numeric(8,1),
        driver_note        text,
        -- вычисляемые сервером итоги (пересчитываются при каждой синхронизации)
        engine_hours       numeric(10,2),
        fuel_consumed_l    numeric(8,1),
        refueled_l         numeric(8,1),
        norm_l             numeric(8,1),
        over_norm_pct      numeric(7,1),
        anomaly_count      integer NOT NULL DEFAULT 0,
        review_comment     text,
        reviewed_by        uuid REFERENCES users(id),
        reviewed_at        timestamptz,
        device_id          text,
        client_updated_at  timestamptz NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        CHECK (ended_at IS NULL OR ended_at >= started_at)
      )`);
    await q.query(`CREATE INDEX shifts_org_started_idx ON shifts(org_id, started_at DESC)`);
    await q.query(`CREATE INDEX shifts_vehicle_started_idx ON shifts(vehicle_id, started_at DESC)`);
    await q.query(`CREATE INDEX shifts_driver_started_idx ON shifts(driver_id, started_at DESC)`);

    await q.query(`
      CREATE TABLE refuelings (
        id                uuid PRIMARY KEY,
        org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        vehicle_id        uuid NOT NULL REFERENCES vehicles(id),
        driver_id         uuid REFERENCES users(id),
        shift_id          uuid REFERENCES shifts(id) ON DELETE SET NULL,
        liters            numeric(8,1) NOT NULL CHECK (liters > 0),
        occurred_at       timestamptz NOT NULL,
        lat               double precision,
        lon               double precision,
        source            text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','FUEL_TRUCK','SENSOR')),
        note              text,
        created_by        uuid REFERENCES users(id),
        client_updated_at timestamptz NOT NULL DEFAULT now(),
        created_at        timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX refuelings_vehicle_idx ON refuelings(vehicle_id, occurred_at)`);

    await q.query(`
      CREATE TABLE photos (
        id            uuid PRIMARY KEY,
        org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        shift_id      uuid REFERENCES shifts(id) ON DELETE CASCADE,
        refueling_id  uuid REFERENCES refuelings(id) ON DELETE CASCADE,
        kind          text NOT NULL CHECK (kind IN ('START_HOURS','START_FUEL','END_HOURS','END_FUEL','REFUEL_RECEIPT','REFUEL_METER')),
        storage_key   text,
        content_type  text,
        size_bytes    integer,
        sha256        text,
        taken_at      timestamptz NOT NULL,
        lat           double precision,
        lon           double precision,
        uploaded_by   uuid REFERENCES users(id),
        uploaded_at   timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX photos_shift_idx ON photos(shift_id)`);

    await q.query(`
      CREATE TABLE track_points (
        id          bigserial PRIMARY KEY,
        org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        shift_id    uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
        ts          timestamptz NOT NULL,
        lat         double precision NOT NULL,
        lon         double precision NOT NULL,
        accuracy_m  real,
        speed_kmh   real,
        location    geography(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) STORED,
        UNIQUE (shift_id, ts)
      )`);

    await q.query(`
      CREATE TABLE telemetry (
        id            bigserial PRIMARY KEY,
        org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        vehicle_id    uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        ts            timestamptz NOT NULL,
        lat           double precision,
        lon           double precision,
        speed_kmh     real,
        fuel_l        numeric(8,1),
        engine_hours  numeric(10,2),
        ignition      boolean,
        params        jsonb NOT NULL DEFAULT '{}'::jsonb,
        received_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (vehicle_id, ts)
      )`);

    await q.query(`
      CREATE TABLE anomalies (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        vehicle_id         uuid REFERENCES vehicles(id) ON DELETE CASCADE,
        shift_id           uuid REFERENCES shifts(id) ON DELETE CASCADE,
        driver_id          uuid REFERENCES users(id),
        type               text NOT NULL,
        severity           text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH')),
        status             text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','CONFIRMED','DISMISSED')),
        message            text NOT NULL,
        details            jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at        timestamptz NOT NULL DEFAULT now(),
        dedupe_key         text NOT NULL UNIQUE,
        resolved_by        uuid REFERENCES users(id),
        resolved_at        timestamptz,
        resolution_comment text,
        created_at         timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX anomalies_org_status_idx ON anomalies(org_id, status, created_at DESC)`);
  }

  async down(q: QueryRunner): Promise<void> {
    for (const t of ['anomalies', 'telemetry', 'track_points', 'photos', 'refuelings', 'shifts', 'vehicles', 'bases', 'users', 'organizations']) {
      await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
  }
}
