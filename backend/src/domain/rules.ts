/**
 * Правила обнаружения аномалий — «мозг» антифрода.
 * Чистые функции без БД и Nest: их легко тестировать и обсуждать с заказчиком.
 * Все пороги настраиваются на уровне хозяйства (OrgSettings) и техники (нормы).
 */

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';

export type AnomalyType =
  | 'START_OUTSIDE_ZONE'
  | 'END_OUTSIDE_ZONE'
  | 'MOCK_LOCATION'
  | 'FUEL_OVER_NORM'
  | 'NEGATIVE_CONSUMPTION'
  | 'ENGINE_HOURS_EXCEED_DURATION'
  | 'ENGINE_HOURS_ROLLBACK'
  | 'ENGINE_HOURS_GAP'
  | 'FUEL_GAP_BETWEEN_SHIFTS'
  | 'LONG_SHIFT'
  | 'MISSING_PHOTO'
  | 'REFUEL_OVER_CAPACITY'
  | 'SENSOR_FUEL_DRAIN'
  | 'SENSOR_UNREGISTERED_REFUEL'
  | 'SENSOR_MANUAL_MISMATCH'
  | 'MOVEMENT_WITHOUT_SHIFT';

export const ANOMALY_TITLES: Record<AnomalyType, string> = {
  START_OUTSIDE_ZONE: 'Смена начата вне базы',
  END_OUTSIDE_ZONE: 'Смена закрыта вне базы',
  MOCK_LOCATION: 'Подмена геолокации',
  FUEL_OVER_NORM: 'Перерасход топлива',
  NEGATIVE_CONSUMPTION: 'Отрицательный расход',
  ENGINE_HOURS_EXCEED_DURATION: 'Моточасов больше, чем длилась смена',
  ENGINE_HOURS_ROLLBACK: 'Счётчик моточасов «откручен»',
  ENGINE_HOURS_GAP: 'Работа техники между сменами',
  FUEL_GAP_BETWEEN_SHIFTS: 'Топливо пропало между сменами',
  LONG_SHIFT: 'Слишком длинная смена',
  MISSING_PHOTO: 'Нет фото показаний',
  REFUEL_OVER_CAPACITY: 'Заправка больше объёма бака',
  SENSOR_FUEL_DRAIN: 'Датчик: резкое падение уровня топлива',
  SENSOR_UNREGISTERED_REFUEL: 'Датчик: заправка не зарегистрирована',
  SENSOR_MANUAL_MISMATCH: 'Показания водителя расходятся с датчиком',
  MOVEMENT_WITHOUT_SHIFT: 'Движение техники без открытой смены',
};

export interface AnomalyDraft {
  type: AnomalyType;
  severity: Severity;
  message: string;
  details: Record<string, unknown>;
}

export interface OrgSettings {
  /** Максимально допустимая погрешность GPS для старта смены, м */
  maxGpsAccuracyM: number;
  /** Допуск перерасхода по умолчанию, % (если у техники не задан свой) */
  defaultNormTolerancePct: number;
  /** Допустимое расхождение моточасов между концом прошлой и началом новой смены, ч */
  engineHoursGapTolerance: number;
  /** Допустимое расхождение топлива между сменами, л (погрешность замера щупом/по стрелке) */
  fuelGapToleranceL: number;
  /** Смена дольше этого — подозрительно, ч */
  maxShiftHours: number;
  /** Требовать закрытия смены на базе */
  requireEndInZone: boolean;
  /** Слив по датчику: минимальное падение, л */
  drainMinLiters: number;
  /** Слив по датчику: окно, мин */
  drainWindowMin: number;
  /** Расхождение ручного ввода и датчика, л */
  sensorManualMismatchL: number;
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  maxGpsAccuracyM: 100,
  defaultNormTolerancePct: 15,
  engineHoursGapTolerance: 0.3,
  fuelGapToleranceL: 10,
  maxShiftHours: 14,
  requireEndInZone: false,
  drainMinLiters: 15,
  drainWindowMin: 20,
  sensorManualMismatchL: 25,
};

export interface VehicleInfo {
  id: string;
  name: string;
  tankCapacityL: number;
  /** Норма расхода, л/моточас. null — норма не задана, перерасход не проверяем. */
  fuelNormLph: number | null;
  normTolerancePct: number | null;
}

export interface ShiftFacts {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  startInZone: boolean;
  endInZone: boolean | null;
  mockLocation: boolean;
  startEngineHours: number;
  endEngineHours: number | null;
  startFuelL: number;
  endFuelL: number | null;
  photos: { kind: string }[];
}

export interface PrevShiftFacts {
  id: string;
  endedAt: Date;
  endEngineHours: number;
  endFuelL: number;
  /** Сумма заправок без привязки к смене между концом prev и началом текущей */
  refueledSinceL?: number;
}

export interface RefuelFacts {
  id: string;
  liters: number;
  occurredAt: Date;
}

export interface ShiftTotals {
  engineHours: number | null;
  fuelConsumedL: number | null;
  refueledL: number;
  durationH: number | null;
  normL: number | null;
  /** (факт - норма) / норма * 100 */
  overNormPct: number | null;
  lph: number | null;
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export function computeTotals(shift: ShiftFacts, vehicle: VehicleInfo, refuels: RefuelFacts[]): ShiftTotals {
  const refueledL = refuels.reduce((s, r) => s + r.liters, 0);
  if (shift.endedAt == null || shift.endEngineHours == null || shift.endFuelL == null) {
    return { engineHours: null, fuelConsumedL: null, refueledL, durationH: null, normL: null, overNormPct: null, lph: null };
  }
  const engineHours = round(shift.endEngineHours - shift.startEngineHours, 2);
  const fuelConsumedL = round(shift.startFuelL + refueledL - shift.endFuelL, 1);
  const durationH = round((shift.endedAt.getTime() - shift.startedAt.getTime()) / 3_600_000, 2);
  const normL = vehicle.fuelNormLph != null ? round(engineHours * vehicle.fuelNormLph, 1) : null;
  const overNormPct = normL != null && normL > 0 ? round(((fuelConsumedL - normL) / normL) * 100, 1) : null;
  const lph = engineHours > 0 ? round(fuelConsumedL / engineHours, 2) : null;
  return { engineHours, fuelConsumedL, refueledL, durationH, normL, overNormPct, lph };
}

/** Проверка закрытой смены. Вызывается при каждой синхронизации — результат детерминирован. */
export function analyzeShift(
  shift: ShiftFacts,
  vehicle: VehicleInfo,
  refuels: RefuelFacts[],
  prev: PrevShiftFacts | null,
  s: OrgSettings,
): AnomalyDraft[] {
  const out: AnomalyDraft[] = [];
  const t = computeTotals(shift, vehicle, refuels);

  if (shift.mockLocation) {
    out.push({
      type: 'MOCK_LOCATION',
      severity: 'HIGH',
      message: 'Телефон сообщил о фиктивной геолокации (приложение-«фейковый GPS»).',
      details: {},
    });
  }
  if (!shift.startInZone) {
    out.push({
      type: 'START_OUTSIDE_ZONE',
      severity: 'HIGH',
      message: 'Сервер не подтвердил, что смена начата на территории базы.',
      details: {},
    });
  }
  if (s.requireEndInZone && shift.endInZone === false) {
    out.push({ type: 'END_OUTSIDE_ZONE', severity: 'LOW', message: 'Смена закрыта за пределами базы.', details: {} });
  }

  // --- Сравнение с предыдущей сменой этой же техники ---
  if (prev) {
    const dh = round(shift.startEngineHours - prev.endEngineHours, 2);
    if (dh < -0.05) {
      out.push({
        type: 'ENGINE_HOURS_ROLLBACK',
        severity: 'HIGH',
        message: `Моточасы на старте (${shift.startEngineHours}) меньше, чем в конце прошлой смены (${prev.endEngineHours}).`,
        details: { prevShiftId: prev.id, deltaH: dh },
      });
    } else if (dh > s.engineHoursGapTolerance) {
      out.push({
        type: 'ENGINE_HOURS_GAP',
        severity: 'MEDIUM',
        message: `Между сменами техника проработала ${dh} моточ. без открытой смены.`,
        details: { prevShiftId: prev.id, deltaH: dh },
      });
    }
    // Заправки, сделанные между сменами (например, заправщиком на базе), законно увеличивают остаток
    const df = round(prev.endFuelL + (prev.refueledSinceL ?? 0) - shift.startFuelL, 1);
    if (df > s.fuelGapToleranceL) {
      out.push({
        type: 'FUEL_GAP_BETWEEN_SHIFTS',
        severity: 'HIGH',
        message: `С конца прошлой смены пропало ${df} л топлива.`,
        details: { prevShiftId: prev.id, lostL: df, prevEndFuelL: prev.endFuelL, startFuelL: shift.startFuelL },
      });
    }
  }

  if (shift.endedAt == null) return out; // смена ещё открыта — дальше считать нечего

  // --- Приписка моточасов ---
  if (t.engineHours != null && t.durationH != null) {
    if (t.engineHours < 0) {
      out.push({
        type: 'ENGINE_HOURS_ROLLBACK',
        severity: 'HIGH',
        message: `Моточасы в конце смены меньше, чем в начале (${t.engineHours} ч).`,
        details: { engineHours: t.engineHours },
      });
    } else if (t.engineHours > t.durationH + 0.1) {
      out.push({
        type: 'ENGINE_HOURS_EXCEED_DURATION',
        severity: 'HIGH',
        message: `Наработка ${t.engineHours} моточ. при длительности смены ${t.durationH} ч — возможна накрутка счётчика.`,
        details: { engineHours: t.engineHours, durationH: t.durationH },
      });
    }
    if (t.durationH > s.maxShiftHours) {
      out.push({
        type: 'LONG_SHIFT',
        severity: 'LOW',
        message: `Смена длилась ${t.durationH} ч (порог ${s.maxShiftHours} ч). Возможно, её забыли закрыть.`,
        details: { durationH: t.durationH },
      });
    }
  }

  // --- Расход топлива ---
  if (t.fuelConsumedL != null) {
    if (t.fuelConsumedL < -s.fuelGapToleranceL) {
      out.push({
        type: 'NEGATIVE_CONSUMPTION',
        severity: 'MEDIUM',
        message: `Топлива в конце смены больше, чем было с учётом заправок (на ${-t.fuelConsumedL} л). Незарегистрированная заправка или ошибка ввода.`,
        details: { fuelConsumedL: t.fuelConsumedL },
      });
    } else if (t.normL != null && t.overNormPct != null) {
      const tol = vehicle.normTolerancePct ?? s.defaultNormTolerancePct;
      if (t.overNormPct > tol) {
        out.push({
          type: 'FUEL_OVER_NORM',
          severity: t.overNormPct > tol * 2 ? 'HIGH' : 'MEDIUM',
          message: `Расход ${t.fuelConsumedL} л при норме ${t.normL} л (+${t.overNormPct}%, допуск ${tol}%).`,
          details: { fuelConsumedL: t.fuelConsumedL, normL: t.normL, overNormPct: t.overNormPct, tolerancePct: tol, lph: t.lph },
        });
      }
    }
  }

  // --- Фото обязательны: старт и финиш, моточасы и топливо ---
  const required = ['START_HOURS', 'START_FUEL', 'END_HOURS', 'END_FUEL'];
  const have = new Set(shift.photos.map((p) => p.kind));
  const missing = required.filter((k) => !have.has(k));
  if (missing.length) {
    out.push({
      type: 'MISSING_PHOTO',
      severity: 'MEDIUM',
      message: `Не хватает фото: ${missing.map(photoKindTitle).join(', ')}.`,
      details: { missing },
    });
  }

  // --- Заправки ---
  for (const r of refuels) {
    if (r.liters > vehicle.tankCapacityL * 1.05) {
      out.push({
        type: 'REFUEL_OVER_CAPACITY',
        severity: 'MEDIUM',
        message: `Заправка ${r.liters} л больше объёма бака (${vehicle.tankCapacityL} л).`,
        details: { refuelId: r.id, liters: r.liters },
      });
    }
  }

  return out;
}

export function photoKindTitle(kind: string): string {
  return (
    {
      START_HOURS: 'моточасы на старте',
      START_FUEL: 'топливо на старте',
      END_HOURS: 'моточасы в конце',
      END_FUEL: 'топливо в конце',
      REFUEL_RECEIPT: 'чек/накладная заправки',
      REFUEL_METER: 'счётчик ТРК',
    } as Record<string, string>
  )[kind] ?? kind;
}
