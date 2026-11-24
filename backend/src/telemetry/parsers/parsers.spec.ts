import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAvlPacket, buildImeiPacket, CODEC_8, CODEC_8E, parseAvlPacket, parseImeiPacket } from './teltonika';
import { buildWialonD, buildWialonLogin, handleWialonLine } from './wialon-ips';

test('Teltonika: пример Codec 8 из официальной документации', () => {
  // Пакет из wiki.teltonika-gps.com («Codec 8 — first example»), CRC 0xC7CF
  const hex =
    '000000000000003608010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E0000000000000000010000C7CF';
  const p = parseAvlPacket(Buffer.from(hex, 'hex'))!;
  assert.equal(p.codec, CODEC_8);
  assert.equal(p.records.length, 1);
  const r = p.records[0];
  assert.equal(r.ts.toISOString(), '2019-06-10T10:04:46.000Z');
  assert.equal(r.params.io21, 3);
  assert.equal(r.params.io1, 1);
  assert.equal(r.params.io66, 0x5e0f);
  assert.equal(r.params.io241, 0x601a);
  assert.equal(r.params.io78, 0);
  assert.equal(r.lat, null); // нет фиксации
});

test('Teltonika: кодирование ↔ разбор Codec 8E, IMEI, разрезанный TCP-поток', () => {
  const imei = parseImeiPacket(buildImeiPacket('356307042441013'))!;
  assert.equal(imei.imei, '356307042441013');
  const pkt = buildAvlPacket([
    { ts: new Date('2026-08-01T06:00:00Z'), lat: 54.1838, lon: 45.1749, altitude: 150, course: 90, satellites: 12, speedKmh: 14, io: { 239: 1, 89: 63, 102: 91_800, 84: 2520 } },
    { ts: new Date('2026-08-01T06:01:00Z'), lat: 54.1840, lon: 45.1760, altitude: 151, course: 92, satellites: 11, speedKmh: 15, io: { 239: 1, 89: 62 } },
  ], CODEC_8E);
  assert.equal(parseAvlPacket(pkt.subarray(0, pkt.length - 3)), null); // ещё не дошёл
  const p = parseAvlPacket(pkt)!;
  assert.equal(p.consumed, pkt.length);
  assert.equal(p.records.length, 2);
  assert.ok(Math.abs(p.records[0].lat! - 54.1838) < 1e-6);
  assert.equal(p.records[0].params.io102, 91_800);
  assert.equal(p.records[0].params.io84, 2520);
  const broken = Buffer.from(pkt);
  broken[20] ^= 0xff;
  assert.throws(() => parseAvlPacket(broken), /CRC/);
});

test('Wialon IPS: логин, пинг, расширенный пакет с параметрами', () => {
  const login = handleWialonLine(buildWialonLogin('861230043907626').trim(), { strictCrc: true });
  assert.equal(login.kind, 'login');
  assert.equal(login.kind === 'login' && login.imei, '861230043907626');
  assert.equal(handleWialonLine('#P#').reply, '#AP#\r\n');

  const line = buildWialonD({
    ts: new Date('2026-08-01T06:30:15Z'), lat: 54.1838, lon: 45.1749, speedKmh: 12, course: 180, altitude: 140, satellites: 9,
    params: { fuel_lvl: 212.5, eng_hours: 1532.4, ign: 1 },
  });
  const r = handleWialonLine(line.trim(), { strictCrc: true });
  assert.equal(r.kind, 'data', JSON.stringify(r));
  if (r.kind !== 'data') return;
  assert.equal(r.reply, '#AD#1\r\n');
  const rec = r.records[0];
  assert.equal(rec.ts.toISOString(), '2026-08-01T06:30:15.000Z');
  assert.ok(Math.abs(rec.lat! - 54.1838) < 1e-5 && Math.abs(rec.lon! - 45.1749) < 1e-5);
  assert.deepEqual([rec.params.fuel_lvl, rec.params.eng_hours, rec.params.ign], [212.5, 1532.4, 1]);
});

test('Wialon IPS: ручной ввод без CRC (v1.1) и «чёрный ящик»', () => {
  const r = handleWialonLine('#SD#010826;063015;5411.0280;N;04510.4940;E;0;0;140;9');
  assert.equal(r.kind, 'data');
  const b = handleWialonLine('#B#010826;063015;5411.0280;N;04510.4940;E;0;0;140;9|010826;063115;5411.0280;N;04510.4940;E;0;0;140;9');
  assert.equal(b.reply, '#AB#2\r\n');
  const bad = handleWialonLine('#D#010826;063015;5411.0280;N;04510.4940;E;0;0;140;9;1;0;0;;NA;fuel:2:1;FFFF', { strictCrc: true });
  assert.equal(bad.kind, 'error');
});
