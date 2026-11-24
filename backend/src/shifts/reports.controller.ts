import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { OrgId, Roles } from '../common/auth';

/**
 * Сводные отчёты для руководителя: наработка, расход, перерасход и аномалии
 * по технике и по водителям за период. Учитываются закрытые смены (кроме отклонённых).
 */
@ApiTags('reports')
@Roles('ADMIN', 'MODERATOR')
@Controller('reports')
export class ReportsController {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  private range(from?: string, to?: string) {
    const t = to ? new Date(to) : new Date();
    const f = from ? new Date(from) : new Date(t.getTime() - 30 * 86_400_000);
    return [f, t];
  }

  @Get('summary')
  async summary(@OrgId() orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    const [f, t] = this.range(from, to);
    const agg = `
      count(*)::int AS "shifts",
      COALESCE(sum(s.engine_hours), 0)::float AS "engineHours",
      COALESCE(sum(s.fuel_consumed_l), 0)::float AS "fuelL",
      COALESCE(sum(s.norm_l), 0)::float AS "normL",
      COALESCE(sum(s.refueled_l), 0)::float AS "refueledL",
      COALESCE(sum(s.anomaly_count), 0)::int AS "anomalies",
      CASE WHEN sum(s.engine_hours) > 0 THEN round((sum(s.fuel_consumed_l) / sum(s.engine_hours))::numeric, 2)::float END AS "lph",
      CASE WHEN sum(s.norm_l) > 0 THEN round(((sum(s.fuel_consumed_l) - sum(s.norm_l)) / sum(s.norm_l) * 100)::numeric, 1)::float END AS "overNormPct"`;
    const cond = `s.org_id = $1 AND s.started_at >= $2 AND s.started_at < $3 AND s.ended_at IS NOT NULL AND s.status <> 'REJECTED'`;
    const byVehicle = await this.db.query(
      `SELECT v.id, v.name, v.fuel_norm_lph::float AS "normLph", ${agg}
         FROM shifts s JOIN vehicles v ON v.id = s.vehicle_id
        WHERE ${cond} GROUP BY v.id ORDER BY "overNormPct" DESC NULLS LAST`,
      [orgId, f, t],
    );
    const byDriver = await this.db.query(
      `SELECT u.id, u.full_name AS name, ${agg}
         FROM shifts s JOIN users u ON u.id = s.driver_id
        WHERE ${cond} GROUP BY u.id ORDER BY "anomalies" DESC, "overNormPct" DESC NULLS LAST`,
      [orgId, f, t],
    );
    const [totals] = await this.db.query(`SELECT ${agg} FROM shifts s WHERE ${cond}`, [orgId, f, t]);
    const [open] = await this.db.query(`SELECT count(*)::int AS n FROM shifts WHERE org_id = $1 AND ended_at IS NULL`, [orgId]);
    const [pending] = await this.db.query(`SELECT count(*)::int AS n FROM shifts WHERE org_id = $1 AND status = 'CLOSED'`, [orgId]);
    const daily = await this.db.query(
      `SELECT to_char(date_trunc('day', s.started_at AT TIME ZONE 'Europe/Moscow'), 'YYYY-MM-DD') AS day,
              COALESCE(sum(s.fuel_consumed_l), 0)::float AS "fuelL", COALESCE(sum(s.norm_l), 0)::float AS "normL",
              COALESCE(sum(s.engine_hours), 0)::float AS "engineHours"
         FROM shifts s WHERE ${cond} GROUP BY 1 ORDER BY 1`,
      [orgId, f, t],
    );
    return { from: f, to: t, totals, openShifts: open.n, pendingReview: pending.n, byVehicle, byDriver, daily };
  }

  /** Выгрузка смен в CSV (открывается в Excel: разделитель «;», кодировка UTF-8 с BOM) */
  @Get('shifts.csv')
  async csv(@OrgId() orgId: string, @Res() res: Response, @Query('from') from?: string, @Query('to') to?: string) {
    const [f, t] = this.range(from, to);
    const rows: Record<string, unknown>[] = await this.db.query(
      `SELECT to_char(s.started_at AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY HH24:MI') AS "Начало",
              to_char(s.ended_at AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY HH24:MI') AS "Окончание",
              v.name AS "Техника", u.full_name AS "Водитель",
              s.start_engine_hours AS "Моточасы старт", s.end_engine_hours AS "Моточасы финиш", s.engine_hours AS "Наработка, моточ",
              s.start_fuel_l AS "Топливо старт, л", s.refueled_l AS "Заправлено, л", s.end_fuel_l AS "Топливо финиш, л",
              s.fuel_consumed_l AS "Расход, л", s.norm_l AS "Норма, л", s.over_norm_pct AS "Отклонение, %",
              s.anomaly_count AS "Аномалий", s.status AS "Статус", s.review_comment AS "Комментарий модератора"
         FROM shifts s JOIN vehicles v ON v.id = s.vehicle_id JOIN users u ON u.id = s.driver_id
        WHERE s.org_id = $1 AND s.started_at >= $2 AND s.started_at < $3
        ORDER BY s.started_at`,
      [orgId, f, t],
    );
    const esc = (v: unknown) => {
      if (v == null) return '';
      let s = String(v);
      if (/^-?\d+\.\d+$/.test(s)) s = s.replace('.', ','); // десятичная запятая для русского Excel
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = rows.length ? Object.keys(rows[0]) : ['Нет данных за период'];
    const lines = [header.join(';'), ...rows.map((r) => header.map((h) => esc(r[h])).join(';'))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="shifts.csv"');
    res.send('\uFEFF' + lines.join('\r\n'));
  }
}
