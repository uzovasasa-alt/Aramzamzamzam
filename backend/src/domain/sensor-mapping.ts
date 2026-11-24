/**
 * Перевод «сырых» параметров трекера в понятные величины.
 * Хранится в vehicles.sensor_mapping (JSON) и редактируется в веб-панели.
 *
 * Примеры:
 *  Teltonika + CAN:   { fuel: { param: "io89", unit: "percent" }, engineHours: { param: "io102", unit: "minutes" }, ignition: { param: "io239" } }
 *  Teltonika + ДУТ RS-485: { fuel: { param: "io201", unit: "raw", calibration: [[0,0],[4095,400]] } }
 *  Galileosky (Wialon IPS): { fuel: { param: "fuel_lvl", unit: "liters" }, engineHours: { param: "eng_hours", unit: "hours" }, ignition: { param: "ign" } }
 */
import { applyCalibration } from './telemetry-analysis';

export interface SensorMapping {
  fuel?: {
    param: string;
    unit: 'liters' | 'deciliters' | 'percent' | 'raw';
    /** Тарировочная таблица [сырое значение, литры] — обязательна для unit=raw */
    calibration?: [number, number][];
  };
  engineHours?: { param: string; unit: 'hours' | 'minutes' | 'seconds' };
  ignition?: { param: string };
}

export interface DecodedSensors {
  fuelL: number | null;
  engineHours: number | null;
  ignition: boolean | null;
}

export function decodeSensors(
  params: Record<string, number | string>,
  mapping: SensorMapping | null | undefined,
  tankCapacityL: number,
): DecodedSensors {
  const res: DecodedSensors = { fuelL: null, engineHours: null, ignition: null };
  if (!mapping) return res;
  const n = (k: string): number | null => {
    const v = params[k];
    if (v == null) return null;
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) ? x : null;
  };
  if (mapping.fuel) {
    const raw = n(mapping.fuel.param);
    if (raw != null) {
      switch (mapping.fuel.unit) {
        case 'liters': res.fuelL = raw; break;
        case 'deciliters': res.fuelL = raw / 10; break;
        case 'percent': res.fuelL = (raw / 100) * tankCapacityL; break;
        case 'raw': res.fuelL = applyCalibration(raw, mapping.fuel.calibration ?? []); break;
      }
      if (res.fuelL != null) res.fuelL = Math.round(res.fuelL * 10) / 10;
    }
  }
  if (mapping.engineHours) {
    const raw = n(mapping.engineHours.param);
    if (raw != null) {
      const div = { hours: 1, minutes: 60, seconds: 3600 }[mapping.engineHours.unit];
      res.engineHours = Math.round((raw / div) * 100) / 100;
    }
  }
  if (mapping.ignition) {
    const raw = n(mapping.ignition.param);
    if (raw != null) res.ignition = raw > 0;
  }
  return res;
}
