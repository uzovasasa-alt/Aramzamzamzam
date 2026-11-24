/** Нормализованная точка от любого трекера — независимо от протокола. */
export interface TrackerRecord {
  ts: Date;
  lat: number | null;
  lon: number | null;
  speedKmh: number | null;
  course: number | null;
  altitude: number | null;
  satellites: number | null;
  /** Все дополнительные параметры: показания ДУТ, CAN, входы. Ключи — как их называет протокол. */
  params: Record<string, number | string>;
}
