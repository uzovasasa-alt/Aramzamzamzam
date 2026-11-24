import { Body, Controller, Get, MessageEvent, NotFoundException, Param, ParseUUIDPipe, Post, Query, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { filter, interval, map, merge, Observable } from 'rxjs';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, OrgId, Roles } from '../common/auth';
import { ANOMALY_TITLES } from '../domain/rules';
import { Anomaly, Shift } from '../entities';
import { AnomaliesService } from './anomalies.service';

class ResolveDto {
  @IsIn(['CONFIRMED', 'DISMISSED']) status: 'CONFIRMED' | 'DISMISSED';
  @IsOptional() @IsString() comment?: string;
}

@ApiTags('anomalies')
@Roles('ADMIN', 'MODERATOR')
@Controller('anomalies')
export class AnomaliesController {
  constructor(
    @InjectRepository(Anomaly) private readonly repo: Repository<Anomaly>,
    @InjectRepository(Shift) private readonly shifts: Repository<Shift>,
    private readonly service: AnomaliesService,
  ) {}

  @Get('types')
  types() {
    return ANOMALY_TITLES;
  }

  @Get()
  async list(
    @OrgId() orgId: string,
    @Query('status') status?: string,
    @Query('severity') severity?: string,
    @Query('vehicleId') vehicleId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit = '200',
  ) {
    const params: unknown[] = [orgId];
    const where = ['a.org_id = $1'];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (status) add('a.status = ?', status);
    if (severity) add('a.severity = ?', severity);
    if (vehicleId) add('a.vehicle_id = ?', vehicleId);
    if (from) add('a.occurred_at >= ?', from);
    if (to) add('a.occurred_at < ?', to);
    params.push(Math.min(Number(limit) || 200, 1000));
    return this.repo.query(
      `SELECT a.id, a.type, a.severity, a.status, a.message, a.details, a.occurred_at AS "occurredAt",
              a.created_at AS "createdAt", a.shift_id AS "shiftId", a.vehicle_id AS "vehicleId", a.driver_id AS "driverId",
              a.resolution_comment AS "resolutionComment", a.resolved_at AS "resolvedAt",
              v.name AS "vehicleName", u.full_name AS "driverName", r.full_name AS "resolvedByName"
         FROM anomalies a
         LEFT JOIN vehicles v ON v.id = a.vehicle_id
         LEFT JOIN users u ON u.id = a.driver_id
         LEFT JOIN users r ON r.id = a.resolved_by
        WHERE ${where.join(' AND ')}
        ORDER BY (a.status = 'NEW') DESC, a.occurred_at DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  @Get('count')
  async count(@OrgId() orgId: string) {
    const rows: { severity: string; n: string }[] = await this.repo.query(
      `SELECT severity, count(*) AS n FROM anomalies WHERE org_id = $1 AND status = 'NEW' GROUP BY severity`,
      [orgId],
    );
    const bySeverity = Object.fromEntries(rows.map((r) => [r.severity, Number(r.n)]));
    return { total: rows.reduce((s, r) => s + Number(r.n), 0), bySeverity };
  }

  @Post(':id/resolve')
  async resolve(
    @OrgId() orgId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDto,
  ) {
    const a = await this.repo.findOneBy({ id, orgId });
    if (!a) throw new NotFoundException();
    Object.assign(a, { status: dto.status, resolutionComment: dto.comment ?? null, resolvedBy: user.id, resolvedAt: new Date() });
    await this.repo.save(a);
    if (a.shiftId) {
      const n = await this.repo.count({ where: [{ shiftId: a.shiftId, status: 'NEW' }, { shiftId: a.shiftId, status: 'CONFIRMED' }] });
      await this.shifts.update(a.shiftId, { anomalyCount: n });
    }
    return a;
  }

  /**
   * Поток новых аномалий (Server-Sent Events). Веб-панель открывает
   * EventSource('/api/anomalies/stream?access_token=...') и показывает всплывающее уведомление.
   */
  @Sse('stream')
  stream(@OrgId() orgId: string): Observable<MessageEvent> {
    const events = this.service.events$.pipe(
      filter((a: Anomaly) => a.orgId === orgId),
      map((a: Anomaly) => ({ type: 'anomaly', data: a }) as MessageEvent),
    );
    // «пинг» раз в 25 с, чтобы прокси не закрывали соединение
    const ping = interval(25_000).pipe(map(() => ({ type: 'ping', data: {} }) as MessageEvent));
    return merge(events, ping);
  }
}
