import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { AuthUser, CurrentUser, OrgId, Roles } from '../common/auth';
import { Photo, Refueling, Shift } from '../entities';
import { StorageService } from '../storage/storage.service';

class ReviewDto {
  @IsIn(['APPROVE', 'REJECT']) decision: 'APPROVE' | 'REJECT';
  @IsOptional() @IsString() comment?: string;
}

const SHIFT_COLUMNS = `
  s.id, s.status, s.started_at AS "startedAt", s.ended_at AS "endedAt",
  s.vehicle_id AS "vehicleId", v.name AS "vehicleName", s.driver_id AS "driverId", u.full_name AS "driverName",
  s.base_id AS "baseId", b.name AS "baseName",
  s.start_in_zone AS "startInZone", s.end_in_zone AS "endInZone", s.mock_location AS "mockLocation",
  s.start_distance_m AS "startDistanceM",
  s.start_engine_hours::float AS "startEngineHours", s.end_engine_hours::float AS "endEngineHours",
  s.start_fuel_l::float AS "startFuelL", s.end_fuel_l::float AS "endFuelL",
  s.engine_hours::float AS "engineHours", s.fuel_consumed_l::float AS "fuelConsumedL",
  s.refueled_l::float AS "refueledL", s.norm_l::float AS "normL", s.over_norm_pct::float AS "overNormPct",
  s.anomaly_count AS "anomalyCount", s.driver_note AS "driverNote",
  s.review_comment AS "reviewComment", s.reviewed_at AS "reviewedAt", r.full_name AS "reviewedByName",
  s.start_lat AS "startLat", s.start_lon AS "startLon", s.start_accuracy_m AS "startAccuracyM",
  s.end_lat AS "endLat", s.end_lon AS "endLon", s.updated_at AS "updatedAt"`;

const SHIFT_JOINS = `
  FROM shifts s
  JOIN vehicles v ON v.id = s.vehicle_id
  JOIN users u ON u.id = s.driver_id
  LEFT JOIN bases b ON b.id = s.base_id
  LEFT JOIN users r ON r.id = s.reviewed_by`;

@ApiTags('shifts')
@Roles('ADMIN', 'MODERATOR')
@Controller('shifts')
export class ShiftsController {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectRepository(Shift) private readonly shifts: Repository<Shift>,
    @InjectRepository(Photo) private readonly photos: Repository<Photo>,
    @InjectRepository(Refueling) private readonly refuels: Repository<Refueling>,
    private readonly storage: StorageService,
  ) {}

  @Get()
  list(
    @OrgId() orgId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('vehicleId') vehicleId?: string,
    @Query('driverId') driverId?: string,
    @Query('status') status?: string,
    @Query('withAnomalies') withAnomalies?: string,
  ) {
    const params: unknown[] = [orgId];
    const where = ['s.org_id = $1'];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (from) add('s.started_at >= ?', from);
    if (to) add('s.started_at < ?', to);
    if (vehicleId) add('s.vehicle_id = ?', vehicleId);
    if (driverId) add('s.driver_id = ?', driverId);
    if (status) add('s.status = ?', status);
    if (withAnomalies === 'true') where.push('s.anomaly_count > 0');
    return this.db.query(
      `SELECT ${SHIFT_COLUMNS} ${SHIFT_JOINS} WHERE ${where.join(' AND ')} ORDER BY s.started_at DESC LIMIT 500`,
      params,
    );
  }

  @Get(':id')
  async get(@OrgId() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    const [shift] = await this.db.query(`SELECT ${SHIFT_COLUMNS} ${SHIFT_JOINS} WHERE s.id = $1 AND s.org_id = $2`, [id, orgId]);
    if (!shift) throw new NotFoundException();

    const photos = await this.photos.find({ where: { shiftId: id }, order: { takenAt: 'ASC' } });
    const refuels = await this.refuels.find({ where: { shiftId: id }, order: { occurredAt: 'ASC' } });
    const refuelPhotos: Photo[] = refuels.length
      ? await this.photos.createQueryBuilder('p').where('p.refueling_id IN (:...ids)', { ids: refuels.map((r) => r.id) }).getMany()
      : [];
    const withUrl = async (p: Photo) => ({
      ...p,
      url: p.storageKey ? await this.storage.signedUrl(p.storageKey) : null, // null — фото ещё не догрузилось с телефона
    });

    const anomalies = await this.db.query(
      `SELECT id, type, severity, status, message, details, resolution_comment AS "resolutionComment"
         FROM anomalies WHERE shift_id = $1 ORDER BY severity DESC`,
      [id],
    );
    const track = await this.db.query(
      `SELECT ts, lat, lon, speed_kmh AS "speedKmh" FROM track_points WHERE shift_id = $1 ORDER BY ts`,
      [id],
    );
    const telemetry = await this.db.query(
      `SELECT ts, fuel_l::float AS "fuelL", speed_kmh AS "speedKmh", engine_hours::float AS "engineHours", lat, lon
         FROM telemetry WHERE vehicle_id = $1 AND ts BETWEEN $2 AND COALESCE($3, now()) ORDER BY ts`,
      [shift.vehicleId, shift.startedAt, shift.endedAt],
    );
    return {
      ...shift,
      photos: await Promise.all(photos.map(withUrl)),
      refuelings: await Promise.all(
        refuels.map(async (r) => ({ ...r, photos: await Promise.all(refuelPhotos.filter((p) => p.refuelingId === r.id).map(withUrl)) })),
      ),
      anomalies,
      track,
      telemetry,
    };
  }

  @Post(':id/review')
  async review(
    @OrgId() orgId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDto,
  ) {
    const shift = await this.shifts.findOneBy({ id, orgId });
    if (!shift) throw new NotFoundException();
    if (!shift.endedAt) throw new BadRequestException('Смена ещё не закрыта');
    if (dto.decision === 'REJECT' && !dto.comment?.trim()) throw new BadRequestException('Укажите причину отклонения');
    await this.shifts.update(id, {
      status: dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      reviewComment: dto.comment ?? null,
      reviewedBy: user.id,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    });
    return this.get(orgId, id);
  }
}
