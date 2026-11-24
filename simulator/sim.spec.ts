/**
 * Проверка симулятора «в связке» с парсерами протоколов и детектором сливов:
 * поднимаем мини-сервер на тех же парсерах, что и backend, и гоняем через него сценарии.
 *   npx tsx --test simulator/sim.spec.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'net';
import { ackRecords, parseAvlPacket, parseImeiPacket } from '../backend/src/telemetry/parsers/teltonika';
import { handleWialonLine } from '../backend/src/telemetry/parsers/wialon-ips';
import { TrackerRecord } from '../backend/src/telemetry/parsers/types';
import { decodeSensors } from '../backend/src/domain/sensor-mapping';
import { detectFuelEvents } from '../backend/src/domain/telemetry-analysis';
import { generate, sendTeltonika, sendWialon } from './sim';

function miniTeltonika(received: TrackerRecord[]): Promise<net.Server> {
  return new Promise((res) => {
    const srv = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let imei: string | null = null;
      sock.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        for (;;) {
          if (!imei) {
            const p = parseImeiPacket(buf);
            if (!p) return;
            imei = p.imei; buf = buf.subarray(p.consumed); sock.write(Buffer.from([1]));
            continue;
          }
          const pkt = parseAvlPacket(buf);
          if (!pkt) return;
          buf = buf.subarray(pkt.consumed);
          received.push(...pkt.records);
          sock.write(ackRecords(pkt.records.length));
        }
      });
    });
    srv.listen(0, () => res(srv));
  });
}

function miniWialon(received: TrackerRecord[]): Promise<net.Server> {
  return new Promise((res) => {
    const srv = net.createServer((sock) => {
      let text = '';
      sock.setEncoding('utf8');
      sock.on('data', (c: string) => {
        text += c;
        let i: number;
        while ((i = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, i).trim();
          text = text.slice(i + 1);
          const r = handleWialonLine(line, { strictCrc: true });
          if (r.kind === 'data') received.push(...r.records);
          if (r.reply) sock.write(r.reply);
        }
      });
    });
    srv.listen(0, () => res(srv));
  });
}

const settings = { minLiters: 15, windowMin: 20 };

test('сценарий «drain» через Teltonika: слив найден, расшифровка CAN верна', async () => {
  const got: TrackerRecord[] = [];
  const srv = await miniTeltonika(got);
  const port = (srv.address() as net.AddressInfo).port;
  const pts = generate('drain', 24, 800);
  await sendTeltonika('356307042441013', pts, 800, port);
  srv.close();
  assert.equal(got.length, pts.length);
  const mapping = { fuel: { param: 'io89', unit: 'percent' as const }, engineHours: { param: 'io102', unit: 'minutes' as const } };
  const samples = got.map((r) => ({ ts: r.ts, speedKmh: r.speedKmh, ignition: null, ...decodeSensors(r.params, mapping, 800) }));
  const drains = detectFuelEvents(samples, settings).filter((e) => e.kind === 'DRAIN');
  assert.equal(drains.length, 1, JSON.stringify(drains));
  assert.ok(drains[0].deltaL <= -45, String(drains[0].deltaL));
});

test('сценарий «normal» через Wialon IPS 2.0 (строгий CRC): ложных сливов нет', async () => {
  const got: TrackerRecord[] = [];
  const srv = await miniWialon(got);
  const port = (srv.address() as net.AddressInfo).port;
  const pts = generate('normal', 12);
  await sendWialon('861230043907626', pts, port);
  srv.close();
  assert.equal(got.length, pts.length);
  const samples = got.map((r) => ({ ts: r.ts, speedKmh: r.speedKmh, ignition: null, fuelL: Number(r.params.fuel_lvl) }));
  assert.deepEqual(detectFuelEvents(samples, settings).filter((e) => e.kind === 'DRAIN'), []);
});

test('сценарий «refuel»: заправка видна', () => {
  const pts = generate('refuel', 24);
  const ev = detectFuelEvents(pts.map((p) => ({ ts: p.ts, fuelL: p.fuelL, speedKmh: p.speedKmh, ignition: p.ignition })), settings);
  assert.equal(ev.filter((e) => e.kind === 'REFUEL').length, 1, JSON.stringify(ev));
});
