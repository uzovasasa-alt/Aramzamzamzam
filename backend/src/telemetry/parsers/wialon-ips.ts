/**
 * Протокол Wialon IPS (версии 1.1 и 2.0) — текстовый, поддерживается
 * Galileosky, Arnavi, Навтелеком (Сигнал), многими китайскими трекерами.
 * Удобен для отладки: можно подключиться через `nc` и отправлять строки руками.
 *
 * Пакеты (каждый заканчивается \r\n):
 *   #L#2.0;IMEI;пароль;CRC16          — логин (v2.0)   → #AL#1
 *   #L#IMEI;пароль                    — логин (v1.1)   → #AL#1
 *   #P#                               — пинг           → #AP#
 *   #SD#дата;время;lat;N;lon;E;скорость;курс;высота;спутники;CRC16   → #ASD#1
 *   #D#дата;время;lat;N;lon;E;скорость;курс;высота;спутники;hdop;входы;выходы;adc;ibutton;параметры;CRC16 → #AD#1
 *   #B#пакет|пакет|...;CRC16          — «чёрный ящик» (накопленные офлайн точки) → #AB#кол-во
 *
 * Параметры в #D#: имя:тип:значение через запятую, тип 1 — целое, 2 — дробное, 3 — строка.
 * Пример: fuel_lvl:2:312.5,eng_hours:2:1532.4,ign:1:1
 */
import { crc16Arc } from './crc16';
import { TrackerRecord } from './types';

export type WialonResult =
  | { kind: 'login'; imei: string; password: string; reply: string }
  | { kind: 'ping'; reply: string }
  | { kind: 'data'; records: TrackerRecord[]; reply: string }
  | { kind: 'error'; reply: string | null; error: string };

const enc = new TextEncoder();

/** CRC в IPS 2.0 считается по телу пакета после «#ТИП#» включая последнюю «;» перед CRC. */
export function wialonCrc(body: string): string {
  return crc16Arc(enc.encode(body)).toString(16).toUpperCase().padStart(4, '0');
}

function splitCrc(body: string): { payload: string; crc: string | null; crcOk: boolean } {
  const idx = body.lastIndexOf(';');
  if (idx < 0) return { payload: body, crc: null, crcOk: true };
  const tail = body.slice(idx + 1);
  if (!/^[0-9A-Fa-f]{1,4}$/.test(tail)) return { payload: body, crc: null, crcOk: true };
  const covered = body.slice(0, idx + 1);
  return { payload: body.slice(0, idx), crc: tail, crcOk: wialonCrc(covered) === tail.toUpperCase().padStart(4, '0') };
}

function parseCoord(v: string, hemi: string): number | null {
  if (!v || v === 'NA') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const deg = Math.trunc(n / 100);
  const min = n - deg * 100;
  const dec = deg + min / 60;
  return hemi === 'S' || hemi === 'W' ? -dec : dec;
}

function num(v: string | undefined): number | null {
  if (v == null || v === '' || v === 'NA') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTs(date: string, time: string, now: Date): Date {
  if (!date || date === 'NA' || !time || time === 'NA') return now;
  const dd = Number(date.slice(0, 2));
  const mm = Number(date.slice(2, 4));
  const yy = Number(date.slice(4, 6));
  const h = Number(time.slice(0, 2));
  const mi = Number(time.slice(2, 4));
  const s = Number(time.slice(4, 6));
  return new Date(Date.UTC(2000 + yy, mm - 1, dd, h, mi, s));
}

function parseParams(s: string | undefined): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if (!s || s === 'NA') return out;
  for (const part of s.split(',')) {
    const [name, type, ...rest] = part.split(':');
    const value = rest.join(':');
    if (!name || value === undefined) continue;
    if (type === '1' || type === '2') {
      const n = Number(value);
      if (Number.isFinite(n)) out[name] = n;
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** Разбор полей одной точки (без CRC). short=true для #SD#. */
function parseRecord(fields: string[], short: boolean, now: Date): TrackerRecord {
  const [date, time, lat1, lat2, lon1, lon2, speed, course, alt, sats] = fields;
  const rec: TrackerRecord = {
    ts: parseTs(date, time, now),
    lat: parseCoord(lat1, lat2),
    lon: parseCoord(lon1, lon2),
    speedKmh: num(speed),
    course: num(course),
    altitude: num(alt),
    satellites: num(sats),
    params: {},
  };
  if (!short) {
    const [, , , , , , , , , , hdop, inputs, outputs, adc, ibutton, params] = fields;
    const h = num(hdop);
    if (h != null) rec.params.hdop = h;
    const inp = num(inputs);
    if (inp != null) rec.params.inputs = inp;
    const outp = num(outputs);
    if (outp != null) rec.params.outputs = outp;
    if (adc && adc !== 'NA' && adc !== '') adc.split(',').forEach((v, i) => {
      const n = num(v);
      if (n != null) rec.params[`adc${i + 1}`] = n;
    });
    if (ibutton && ibutton !== 'NA') rec.params.ibutton = ibutton;
    Object.assign(rec.params, parseParams(params));
  }
  return rec;
}

/**
 * Обработка одной строки (без \r\n). Возвращает, что ответить трекеру.
 * @param strictCrc если true — пакеты с неверным CRC отвергаются (по умолчанию только логируем).
 */
export function handleWialonLine(line: string, opts: { strictCrc?: boolean; now?: Date } = {}): WialonResult {
  const now = opts.now ?? new Date();
  const m = /^#([A-Z]+)#(.*)$/.exec(line.trim());
  if (!m) return { kind: 'error', reply: null, error: 'Не пакет Wialon IPS' };
  const [, type, body] = m;

  switch (type) {
    case 'L': {
      const parts = body.split(';');
      if (parts[0] === '2.0') {
        const { crcOk } = splitCrc(body);
        if (!crcOk && opts.strictCrc) return { kind: 'error', reply: '#AL#10\r\n', error: 'CRC логина' };
        return { kind: 'login', imei: parts[1], password: parts[2] ?? '', reply: '#AL#1\r\n' };
      }
      return { kind: 'login', imei: parts[0], password: parts[1] ?? '', reply: '#AL#1\r\n' };
    }
    case 'P':
      return { kind: 'ping', reply: '#AP#\r\n' };
    case 'SD':
    case 'D': {
      const short = type === 'SD';
      const ack = short ? 'ASD' : 'AD';
      const need = short ? 10 : 16;
      // В v1.1 CRC нет, в v2.0 он идёт лишним полем в конце — различаем по количеству полей
      const hasCrc = body.split(';').length > need;
      const { payload, crc, crcOk } = hasCrc ? splitCrc(body) : { payload: body, crc: null, crcOk: true };
      if (crc && !crcOk && opts.strictCrc) return { kind: 'error', reply: `#${ack}#13\r\n`, error: 'CRC' };
      const fields = payload.split(';');
      if (fields.length < need) return { kind: 'error', reply: `#${ack}#-1\r\n`, error: 'Мало полей' };
      try {
        return { kind: 'data', records: [parseRecord(fields, short, now)], reply: `#${ack}#1\r\n` };
      } catch (e) {
        return { kind: 'error', reply: `#${ack}#-1\r\n`, error: String(e) };
      }
    }
    case 'B': {
      // v2.0: пакеты разделены «|», CRC — последним сегментом после «|»
      const segs = body.split('|');
      if (segs.length > 1 && /^[0-9A-Fa-f]{1,4}$/.test(segs[segs.length - 1])) segs.pop();
      const records: TrackerRecord[] = [];
      for (const pkt of segs) {
        const fields = pkt.split(';');
        if (fields.length >= 16) records.push(parseRecord(fields, false, now));
        else if (fields.length >= 10) records.push(parseRecord(fields, true, now));
      }
      return { kind: 'data', records, reply: `#AB#${records.length}\r\n` };
    }
    default:
      return { kind: 'error', reply: null, error: `Неизвестный тип пакета ${type}` };
  }
}

/** Формирование строки #D# — используется симулятором и тестами. */
export function buildWialonD(rec: {
  ts: Date; lat: number; lon: number; speedKmh: number; course: number; altitude: number; satellites: number;
  params: Record<string, number | string>;
}): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const d = rec.ts;
  const date = `${pad(d.getUTCDate())}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCFullYear() % 100)}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const toNmea = (v: number, degW: number) => {
    const a = Math.abs(v);
    const deg = Math.trunc(a);
    const min = (a - deg) * 60;
    return `${String(deg).padStart(degW, '0')}${min.toFixed(4).padStart(7, '0')}`;
  };
  const params = Object.entries(rec.params)
    .map(([k, v]) => (typeof v === 'number' ? `${k}:${Number.isInteger(v) ? 1 : 2}:${v}` : `${k}:3:${v}`))
    .join(',');
  const body =
    [date, time, toNmea(rec.lat, 2), rec.lat >= 0 ? 'N' : 'S', toNmea(rec.lon, 3), rec.lon >= 0 ? 'E' : 'W',
     Math.round(rec.speedKmh), Math.round(rec.course), Math.round(rec.altitude), rec.satellites,
     '1.0', '0', '0', '', 'NA', params].join(';') + ';';
  return `#D#${body}${wialonCrc(body)}\r\n`;
}

export function buildWialonLogin(imei: string, password = 'NA'): string {
  const body = `2.0;${imei};${password};`;
  return `#L#${body}${wialonCrc(body)}\r\n`;
}
