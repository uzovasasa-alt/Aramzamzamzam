/**
 * TCP-шлюзы для трекеров: Teltonika (порт 5027) и Wialon IPS (порт 20332).
 * В настройках трекера указываете IP/домен сервера и порт — и трекер начинает слать данные.
 * IMEI трекера должен быть прописан у техники в веб-панели.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as net from 'net';
import { Vehicle } from '../entities';
import { ackRecords, parseAvlPacket, parseImeiPacket } from './parsers/teltonika';
import { handleWialonLine } from './parsers/wialon-ips';
import { TelemetryService } from './telemetry.service';

const MAX_BUFFER = 1024 * 1024;

@Injectable()
export class TrackerGateways implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('TrackerGateway');
  private servers: net.Server[] = [];

  constructor(private readonly telemetry: TelemetryService) {}

  onModuleInit() {
    const tPort = Number(process.env.TELTONIKA_TCP_PORT ?? 5027);
    const wPort = Number(process.env.WIALON_TCP_PORT ?? 20332);
    if (tPort > 0) this.listen('Teltonika', tPort, (s) => this.teltonika(s));
    if (wPort > 0) this.listen('Wialon IPS', wPort, (s) => this.wialon(s));
  }

  onModuleDestroy() {
    this.servers.forEach((s) => s.close());
  }

  private listen(name: string, port: number, handler: (s: net.Socket) => void) {
    const srv = net.createServer((sock) => {
      sock.setTimeout(10 * 60_000, () => sock.destroy()); // трекер молчит 10 минут — закрываем
      sock.on('error', (e) => this.log.debug(`${name} ${sock.remoteAddress}: ${e.message}`));
      handler(sock);
    });
    srv.on('error', (e) => this.log.error(`${name}: не удалось открыть порт ${port}: ${e.message}`));
    srv.listen(port, () => this.log.log(`${name}: слушаю TCP ${port}`));
    this.servers.push(srv);
  }

  /* ---------------- Teltonika Codec 8 / 8E ---------------- */
  private teltonika(sock: net.Socket) {
    let buf = Buffer.alloc(0);
    let vehicle: Vehicle | null = null;
    let imei: string | null = null;
    let busy = Promise.resolve();

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_BUFFER) return sock.destroy();
      // обработка строго по очереди, чтобы ACK шли в правильном порядке
      busy = busy.then(async () => {
        try {
          while (buf.length) {
            if (!imei) {
              const p = parseImeiPacket(buf);
              if (!p) return;
              buf = buf.subarray(p.consumed);
              imei = p.imei;
              vehicle = await this.telemetry.findByImei(imei);
              if (!vehicle) {
                this.log.warn(`Teltonika: неизвестный IMEI ${imei} — добавьте его технике в веб-панели`);
                sock.end(Buffer.from([0x00]));
                return;
              }
              sock.write(Buffer.from([0x01]));
              this.log.log(`Teltonika: подключён ${imei} (${vehicle.name})`);
              continue;
            }
            const pkt = parseAvlPacket(buf);
            if (!pkt) return;
            buf = buf.subarray(pkt.consumed);
            await this.telemetry.ingest(vehicle!, pkt.records);
            sock.write(ackRecords(pkt.records.length));
          }
        } catch (e) {
          this.log.warn(`Teltonika ${imei ?? sock.remoteAddress}: ${e}`);
          sock.destroy();
        }
      });
    });
  }

  /* ---------------- Wialon IPS 1.1 / 2.0 ---------------- */
  private wialon(sock: net.Socket) {
    let text = '';
    let vehicle: Vehicle | null = null;
    let busy = Promise.resolve();
    const strictCrc = process.env.WIALON_STRICT_CRC === 'true';

    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > MAX_BUFFER) return sock.destroy();
      busy = busy.then(async () => {
        let idx: number;
        while ((idx = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, idx).replace(/\r$/, '');
          text = text.slice(idx + 1);
          if (!line.trim()) continue;
          const r = handleWialonLine(line, { strictCrc });
          if (r.kind === 'login') {
            vehicle = await this.telemetry.findByImei(r.imei);
            if (!vehicle) {
              this.log.warn(`Wialon IPS: неизвестный IMEI ${r.imei}`);
              sock.write('#AL#0\r\n');
              sock.end();
              return;
            }
            this.log.log(`Wialon IPS: подключён ${r.imei} (${vehicle.name})`);
            sock.write(r.reply);
          } else if (r.kind === 'data') {
            if (!vehicle) { sock.write('#AL#0\r\n'); sock.end(); return; } // данные без логина
            try {
              await this.telemetry.ingest(vehicle, r.records);
              sock.write(r.reply);
            } catch (e) {
              this.log.error(`Wialon IPS: ошибка записи ${e}`);
              sock.write(r.reply.replace(/#1\r\n$/, '#0\r\n').replace(/#\d+\r\n$/, '#0\r\n'));
            }
          } else if (r.reply) {
            sock.write(r.reply);
          } else if (r.kind === 'error') {
            this.log.debug(`Wialon IPS: ${r.error}: ${line.slice(0, 80)}`);
          }
        }
      });
    });
  }
}
