/**
 * Teltonika Codec 8 / Codec 8 Extended (TCP) — бинарный протокол самых
 * распространённых трекеров с чтением CAN (FMC150, FMB140, FMC650 и др.).
 *
 * Обмен:
 *  1) трекер шлёт [2 байта длина][IMEI ASCII]  → сервер отвечает 0x01 (принят) или 0x00
 *  2) трекер шлёт AVL-пакет:
 *     [00 00 00 00][4 б длина данных][codec id][N1][записи...][N2][4 б CRC-16/IBM]
 *     → сервер отвечает 4 байтами — количество принятых записей.
 *
 * Запись: [8 б timestamp, мс][1 б приоритет][GPS 15 б][IO-элементы]
 * GPS: lon int32 *1e7, lat int32 *1e7, высота int16, курс uint16, спутники uint8, скорость uint16 (км/ч)
 * IO (Codec 8):  eventId u8, total u8, затем группы 1/2/4/8 байт: [кол-во u8]{[id u8][значение]}
 * IO (Codec 8E): всё то же, но id и счётчики — u16, плюс группа переменной длины NX.
 *
 * Параметры сохраняем как io<ID> (например io89 — уровень топлива с CAN, %),
 * а смысл задаётся в настройке техники (sensor mapping) — у разных моделей ID разные.
 */
import { crc16Arc } from './crc16';
import { TrackerRecord } from './types';

export const CODEC_8 = 0x08;
export const CODEC_8E = 0x8e;

/** Часто используемые IO ID (FMB/FMC с LV-CAN200/ALL-CAN300). Сверяйте с вики Teltonika для своей модели! */
export const TELTONIKA_COMMON_IO: Record<number, string> = {
  239: 'Зажигание (0/1)',
  240: 'Движение (0/1)',
  66: 'Напряжение бортсети, мВ',
  9: 'Аналоговый вход 1, мВ (аналоговый ДУТ)',
  201: 'LLS 1 — уровень топлива (RS-485 ДУТ)',
  202: 'LLS 1 — температура',
  89: 'CAN: уровень топлива, %',
  84: 'CAN: уровень топлива, 0.1 л',
  83: 'CAN: израсходовано топлива всего, 0.1 л',
  85: 'CAN: обороты двигателя',
  102: 'CAN: моточасы двигателя, мин',
  87: 'CAN: пробег, м',
};

export function parseImeiPacket(buf: Buffer): { imei: string; consumed: number } | null {
  if (buf.length < 2) return null;
  const len = buf.readUInt16BE(0);
  if (len < 8 || len > 20) throw new Error(`Странная длина IMEI: ${len}`);
  if (buf.length < 2 + len) return null;
  const imei = buf.subarray(2, 2 + len).toString('ascii');
  if (!/^\d+$/.test(imei)) throw new Error('IMEI должен состоять из цифр');
  return { imei, consumed: 2 + len };
}

export interface AvlPacket {
  codec: number;
  records: TrackerRecord[];
  consumed: number;
}

/** Возвращает null, если пакет ещё не пришёл целиком (TCP может резать данные). */
export function parseAvlPacket(buf: Buffer): AvlPacket | null {
  if (buf.length < 8) return null;
  if (buf.readUInt32BE(0) !== 0) throw new Error('Нет преамбулы 00000000');
  const dataLen = buf.readUInt32BE(4);
  const total = 8 + dataLen + 4;
  if (buf.length < total) return null;
  const data = buf.subarray(8, 8 + dataLen);
  const crc = buf.readUInt32BE(8 + dataLen);
  const calc = crc16Arc(data);
  if (calc !== (crc & 0xffff)) throw new Error(`CRC не совпал: ${calc.toString(16)} != ${crc.toString(16)}`);

  let o = 0;
  const codec = data.readUInt8(o++);
  if (codec !== CODEC_8 && codec !== CODEC_8E) throw new Error(`Кодек 0x${codec.toString(16)} не поддерживается`);
  const ext = codec === CODEC_8E;
  const n1 = data.readUInt8(o++);
  const records: TrackerRecord[] = [];

  const rdId = () => {
    const v = ext ? data.readUInt16BE(o) : data.readUInt8(o);
    o += ext ? 2 : 1;
    return v;
  };

  for (let r = 0; r < n1; r++) {
    const ts = new Date(Number(data.readBigUInt64BE(o)));
    o += 8;
    o += 1; // priority
    const lon = data.readInt32BE(o) / 1e7; o += 4;
    const lat = data.readInt32BE(o) / 1e7; o += 4;
    const altitude = data.readInt16BE(o); o += 2;
    const course = data.readUInt16BE(o); o += 2;
    const satellites = data.readUInt8(o); o += 1;
    const speed = data.readUInt16BE(o); o += 2;
    const params: Record<string, number | string> = {};
    const eventId = rdId();
    if (eventId) params.event = eventId;
    rdId(); // общее количество IO
    for (const size of [1, 2, 4, 8]) {
      const cnt = rdId();
      for (let k = 0; k < cnt; k++) {
        const id = rdId();
        let v: number;
        if (size === 1) v = data.readUInt8(o);
        else if (size === 2) v = data.readUInt16BE(o);
        else if (size === 4) v = data.readUInt32BE(o);
        else v = Number(data.readBigUInt64BE(o));
        o += size;
        params[`io${id}`] = v;
      }
    }
    if (ext) {
      const cnt = data.readUInt16BE(o); o += 2;
      for (let k = 0; k < cnt; k++) {
        const id = data.readUInt16BE(o); o += 2;
        const len = data.readUInt16BE(o); o += 2;
        params[`io${id}`] = data.subarray(o, o + len).toString('hex');
        o += len;
      }
    }
    const noFix = lat === 0 && lon === 0;
    records.push({
      ts,
      lat: noFix ? null : lat,
      lon: noFix ? null : lon,
      speedKmh: speed,
      course,
      altitude,
      satellites,
      params,
    });
  }
  const n2 = data.readUInt8(o);
  if (n2 !== n1) throw new Error(`Количество записей не совпадает: ${n1} / ${n2}`);
  return { codec, records, consumed: total };
}

export function ackRecords(count: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(count);
  return b;
}

/* ---------- Кодирование (для симулятора и тестов) ---------- */

export function buildImeiPacket(imei: string): Buffer {
  const b = Buffer.alloc(2 + imei.length);
  b.writeUInt16BE(imei.length);
  b.write(imei, 2, 'ascii');
  return b;
}

export interface AvlInput {
  ts: Date; lat: number; lon: number; altitude: number; course: number; satellites: number; speedKmh: number;
  io: Record<number, number>;
}

export function buildAvlPacket(recs: AvlInput[], codec = CODEC_8E): Buffer {
  const ext = codec === CODEC_8E;
  const parts: Buffer[] = [];
  const u8 = (v: number) => Buffer.from([v & 0xff]);
  const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
  const id = (v: number) => (ext ? u16(v) : u8(v));
  parts.push(u8(codec), u8(recs.length));
  for (const r of recs) {
    const head = Buffer.alloc(8 + 1 + 15);
    head.writeBigUInt64BE(BigInt(r.ts.getTime()), 0);
    head.writeUInt8(0, 8);
    head.writeInt32BE(Math.round(r.lon * 1e7), 9);
    head.writeInt32BE(Math.round(r.lat * 1e7), 13);
    head.writeInt16BE(r.altitude, 17);
    head.writeUInt16BE(r.course, 19);
    head.writeUInt8(r.satellites, 21);
    head.writeUInt16BE(Math.round(r.speedKmh), 22);
    parts.push(head);
    const groups: Record<number, [number, number][]> = { 1: [], 2: [], 4: [], 8: [] };
    for (const [k, v] of Object.entries(r.io)) {
      const size = v < 0x100 ? 1 : v < 0x10000 ? 2 : v < 0x100000000 ? 4 : 8;
      groups[size].push([Number(k), v]);
    }
    const total = Object.values(groups).reduce((s, g) => s + g.length, 0);
    parts.push(id(0), id(total));
    for (const size of [1, 2, 4, 8]) {
      parts.push(id(groups[size].length));
      for (const [k, v] of groups[size]) {
        parts.push(id(k));
        const b = Buffer.alloc(size);
        if (size === 1) b.writeUInt8(v);
        else if (size === 2) b.writeUInt16BE(v);
        else if (size === 4) b.writeUInt32BE(v);
        else b.writeBigUInt64BE(BigInt(v));
        parts.push(b);
      }
    }
    if (ext) parts.push(u16(0));
  }
  parts.push(u8(recs.length));
  const data = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(0, 0);
  head.writeUInt32BE(data.length, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc16Arc(data));
  return Buffer.concat([head, data, crc]);
}
