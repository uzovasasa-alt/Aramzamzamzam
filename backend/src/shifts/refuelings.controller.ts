import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { AuthUser, CurrentUser, OrgId, Roles } from '../common/auth';
import { Refueling, Shift, Vehicle } from '../entities';
import { ShiftsService } from './shifts.service';

class CreateRefuelDto {
  @IsUUID() vehicleId: string;
  @IsNumber() @Min(0.1) liters: number;
  @IsDateString() occurredAt: string;
  @IsIn(['MANUAL', 'FUEL_TRUCK']) source: 'MANUAL' | 'FUEL_TRUCK';
  @IsOptional() @IsString() note?: string;
}

/**
 * Заправки. Водитель вводит их в приложении, а модератор/заправщик может внести
 * выдачу топлива по ведомости — тогда расхождение «выдано/заявлено водителем» видно сразу.
 */
@ApiTags('refuelings')
@Roles('ADMIN', 'MODERATOR')
@Controller('refuelings')
export class RefuelingsController {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectRepository(Refueling) private readonly repo: Repository<Refueling>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Shift) private readonly shifts: Repository<Shift>,
    private readonly shiftsService: ShiftsService,
  ) {}

  @Get()
  list(@OrgId() orgId: string, @Query('from') from?: string, @Query('to') to?: string, @Query('vehicleId') vehicleId?: string) {
    const params: unknown[] = [orgId];
    const where = ['r.org_id = $1'];
    if (from) { params.push(from); where.push(`r.occurred_at >= $${params.length}`); }
    if (to) { params.push(to); where.push(`r.occurred_at < $${params.length}`); }
    if (vehicleId) { params.push(vehicleId); where.push(`r.vehicle_id = $${params.length}`); }
    return this.db.query(
      `SELECT r.id, r.liters::float, r.occurred_at AS "occurredAt", r.source, r.note, r.shift_id AS "shiftId",
              r.vehicle_id AS "vehicleId", v.name AS "vehicleName", u.full_name AS "driverName", c.full_name AS "createdByName",
              (SELECT count(*)::int FROM photos p WHERE p.refueling_id = r.id) AS "photoCount"
         FROM refuelings r
         JOIN vehicles v ON v.id = r.vehicle_id
         LEFT JOIN users u ON u.id = r.driver_id
         LEFT JOIN users c ON c.id = r.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY r.occurred_at DESC LIMIT 500`,
      params,
    );
  }

  @Post()
  async create(@OrgId() orgId: string, @CurrentUser() user: AuthUser, @Body() dto: CreateRefuelDto) {
    await this.vehicles.findOneByOrFail({ id: dto.vehicleId, orgId });
    const at = new Date(dto.occurredAt);
    // Если в этот момент у техники открыта/шла смена — привязываем заправку к ней
    const shift = await this.shifts
      .createQueryBuilder('s')
      .where('s.vehicle_id = :v AND s.started_at <= :t AND (s.ended_at IS NULL OR s.ended_at >= :t)', { v: dto.vehicleId, t: at })
      .getOne();
    const r = await this.repo.save(
      this.repo.create({
        id: randomUUID(),
        orgId,
        vehicleId: dto.vehicleId,
        driverId: shift?.driverId ?? null,
        shiftId: shift?.id ?? null,
        liters: dto.liters,
        occurredAt: at,
        source: dto.source,
        note: dto.note ?? null,
        createdBy: user.id,
        clientUpdatedAt: new Date(),
      }),
    );
    if (shift) await this.shiftsService.recompute(shift.id);
    return r;
  }
}
