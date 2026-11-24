/**
 * Аномалии: сохранение без дублей, уведомление модератора (веб-панель в реальном времени + Telegram).
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Subject } from 'rxjs';
import { In, Repository } from 'typeorm';
import { OrgSettingsService } from '../directory/org-settings.service';
import { ANOMALY_TITLES, AnomalyDraft, AnomalyType } from '../domain/rules';
import { Anomaly, Vehicle } from '../entities';

export interface AnomalyContext {
  orgId: string;
  vehicleId?: string | null;
  shiftId?: string | null;
  driverId?: string | null;
  occurredAt?: Date;
}

@Injectable()
export class AnomaliesService {
  private readonly log = new Logger(AnomaliesService.name);
  /** Поток новых аномалий для SSE (веб-панель подписывается на него) */
  readonly events$ = new Subject<Anomaly>();

  constructor(
    @InjectRepository(Anomaly) private readonly repo: Repository<Anomaly>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    private readonly settings: OrgSettingsService,
  ) {}

  /**
   * Синхронизирует аномалии смены с результатом анализа:
   *  - новые — создаём и уведомляем,
   *  - пропавшие (водитель исправил данные) — удаляем, если модератор их ещё не разбирал.
   * dedupe_key = shift:<id>:<type> гарантирует, что повторная синхронизация не плодит дубликаты.
   */
  async syncShiftAnomalies(ctx: AnomalyContext & { shiftId: string }, drafts: AnomalyDraft[]): Promise<number> {
    const key = (t: string) => `shift:${ctx.shiftId}:${t}`;
    const existing = await this.repo.find({ where: { shiftId: ctx.shiftId } });
    const wanted = new Map(drafts.map((d) => [key(d.type), d]));

    const stale = existing.filter((a) => a.dedupeKey.startsWith('shift:') && !wanted.has(a.dedupeKey) && a.status === 'NEW');
    if (stale.length) await this.repo.delete({ id: In(stale.map((a) => a.id)) });

    for (const [k, d] of wanted) {
      const prev = existing.find((a) => a.dedupeKey === k);
      if (prev) {
        if (prev.status === 'NEW' && (prev.message !== d.message || prev.severity !== d.severity)) {
          await this.repo.update(prev.id, { message: d.message, severity: d.severity, details: d.details as Record<string, any> });
        }
        continue;
      }
      await this.raise(ctx, d, k);
    }
    return this.repo.count({ where: { shiftId: ctx.shiftId, status: In(['NEW', 'CONFIRMED']) } });
  }

  /** Создать аномалию (если с таким ключом ещё нет). Возвращает true, если создана. */
  async raise(ctx: AnomalyContext, d: AnomalyDraft, dedupeKey: string): Promise<boolean> {
    const rows: { id: string }[] = await this.repo.query(
      `INSERT INTO anomalies (org_id, vehicle_id, shift_id, driver_id, type, severity, message, details, occurred_at, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        ctx.orgId, ctx.vehicleId ?? null, ctx.shiftId ?? null, ctx.driverId ?? null,
        d.type, d.severity, d.message, JSON.stringify(d.details), ctx.occurredAt ?? new Date(), dedupeKey,
      ],
    );
    const id = rows[0]?.id;
    if (!id) return false; // уже есть такая аномалия
    const created = await this.repo.findOneByOrFail({ id });
    this.events$.next(created);
    if (created.severity !== 'LOW') void this.notifyTelegram(created);
    return true;
  }

  private async notifyTelegram(a: Anomaly) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    const { telegramChatId } = await this.settings.get(a.orgId);
    if (!telegramChatId) return;
    const vehicle = a.vehicleId ? await this.vehicles.findOneBy({ id: a.vehicleId }) : null;
    const icon = a.severity === 'HIGH' ? '🔴' : '🟠';
    const text = `${icon} ${ANOMALY_TITLES[a.type as AnomalyType] ?? a.type}\n${vehicle ? `Техника: ${vehicle.name}\n` : ''}${a.message}`;
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramChatId, text }),
      });
      if (!r.ok) this.log.warn(`Telegram ответил ${r.status}`);
    } catch (e) {
      this.log.warn(`Не удалось отправить в Telegram: ${e}`);
    }
  }
}
