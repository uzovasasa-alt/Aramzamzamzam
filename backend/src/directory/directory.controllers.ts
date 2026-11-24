/**
 * Справочники: хозяйства, сотрудники, базы (геозоны), техника.
 * Простые CRUD-операции — логика в контроллерах намеренно, чтобы не плодить слои.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { AuthUser, CurrentUser, OrgId, Roles } from '../common/auth';
import { DEFAULT_ORG_SETTINGS } from '../domain/rules';
import { Base, Organization, Role, User, Vehicle } from '../entities';
import { OrgSettingsService } from './org-settings.service';

/* ===================== Хозяйства ===================== */

class CreateOrgDto {
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() inn?: string;
  /** Сразу создать администратора хозяйства */
  @IsString() adminLogin: string;
  @IsString() @MinLength(6) adminPassword: string;
  @IsString() adminFullName: string;
}

class UpdateSettingsDto {
  @IsOptional() @IsNumber() @Min(5) @Max(1000) maxGpsAccuracyM?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(200) defaultNormTolerancePct?: number;
  @IsOptional() @IsNumber() @Min(0) engineHoursGapTolerance?: number;
  @IsOptional() @IsNumber() @Min(0) fuelGapToleranceL?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(48) maxShiftHours?: number;
  @IsOptional() @IsBoolean() requireEndInZone?: boolean;
  @IsOptional() @IsNumber() @Min(1) drainMinLiters?: number;
  @IsOptional() @IsNumber() @Min(1) drainWindowMin?: number;
  @IsOptional() @IsNumber() @Min(1) sensorManualMismatchL?: number;
  @IsOptional() @IsString() telegramChatId?: string;
}

@ApiTags('organizations')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    @InjectRepository(Organization) private readonly orgs: Repository<Organization>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly settings: OrgSettingsService,
  ) {}

  @Roles('SUPERADMIN')
  @Get()
  list() {
    return this.orgs.find({ order: { createdAt: 'DESC' } });
  }

  @Roles('SUPERADMIN')
  @Post()
  async create(@Body() dto: CreateOrgDto) {
    if (await this.users.exists({ where: { login: dto.adminLogin } })) throw new ConflictException('Логин занят');
    const org = await this.orgs.save(this.orgs.create({ name: dto.name, inn: dto.inn ?? null, settings: {} }));
    await this.users.save(
      this.users.create({
        orgId: org.id,
        role: 'ADMIN',
        login: dto.adminLogin,
        fullName: dto.adminFullName,
        passwordHash: await AuthService.hash(dto.adminPassword),
      }),
    );
    return org;
  }

  @Get('current')
  async current(@OrgId() orgId: string) {
    const org = await this.orgs.findOneBy({ id: orgId });
    if (!org) throw new NotFoundException();
    return { ...org, settings: await this.settings.get(orgId), defaults: DEFAULT_ORG_SETTINGS };
  }

  @Roles('ADMIN')
  @Patch('current/settings')
  async updateSettings(@OrgId() orgId: string, @Body() dto: UpdateSettingsDto) {
    const org = await this.orgs.findOneByOrFail({ id: orgId });
    org.settings = { ...org.settings, ...dto };
    await this.orgs.save(org);
    return this.settings.get(orgId);
  }
}

/* ===================== Сотрудники ===================== */

const ORG_ROLES: Role[] = ['ADMIN', 'MODERATOR', 'DRIVER'];

class CreateUserDto {
  @IsIn(ORG_ROLES) role: Role;
  @IsString() @MinLength(2) fullName: string;
  @IsString() @MinLength(3) login: string;
  @IsString() @MinLength(4) password: string;
  @IsOptional() @IsString() phone?: string;
}

class UpdateUserDto {
  @IsOptional() @IsIn(ORG_ROLES) role?: Role;
  @IsOptional() @IsString() fullName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MinLength(4) password?: string;
}

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  @Roles('ADMIN', 'MODERATOR')
  @Get()
  list(@OrgId() orgId: string) {
    return this.users.find({ where: { orgId }, order: { fullName: 'ASC' } });
  }

  @Roles('ADMIN')
  @Post()
  async create(@OrgId() orgId: string, @Body() dto: CreateUserDto) {
    if (await this.users.exists({ where: { login: dto.login } })) throw new ConflictException('Логин занят');
    const { password, ...rest } = dto;
    const saved = await this.users.save(this.users.create({ ...rest, orgId, passwordHash: await AuthService.hash(password) }));
    return this.users.findOneBy({ id: saved.id });
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(
    @OrgId() orgId: string,
    @CurrentUser() me: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    const user = await this.users.findOneBy({ id, orgId });
    if (!user) throw new NotFoundException();
    if (id === me.id && (dto.isActive === false || (dto.role && dto.role !== user.role))) {
      throw new BadRequestException('Нельзя заблокировать себя или сменить себе роль');
    }
    const { password, ...rest } = dto;
    Object.assign(user, rest);
    // При смене пароля или блокировке «выкидываем» все сессии пользователя
    if (password) user.passwordHash = await AuthService.hash(password);
    if (password || dto.isActive === false) user.tokenVersion += 1;
    await this.users.save(user);
    return this.users.findOneBy({ id });
  }
}

/* ===================== Базы (геозоны) ===================== */

class BaseDto {
  @IsString() @MinLength(1) name: string;
  @IsLatitude() lat: number;
  @IsLongitude() lon: number;
  @IsInt() @Min(20) @Max(20000) radiusM: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@ApiTags('bases')
@Controller('bases')
export class BasesController {
  constructor(@InjectRepository(Base) private readonly bases: Repository<Base>) {}

  @Get()
  list(@OrgId() orgId: string) {
    return this.bases.find({ where: { orgId }, order: { name: 'ASC' } });
  }

  @Roles('ADMIN')
  @Post()
  create(@OrgId() orgId: string, @Body() dto: BaseDto) {
    return this.bases.save(this.bases.create({ ...dto, orgId }));
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(@OrgId() orgId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BaseDto) {
    const base = await this.bases.findOneBy({ id, orgId });
    if (!base) throw new NotFoundException();
    return this.bases.save(Object.assign(base, dto));
  }

  @Roles('ADMIN')
  @Delete(':id')
  async remove(@OrgId() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    // Не удаляем физически — на базу ссылаются смены. Просто выключаем.
    await this.bases.update({ id, orgId }, { isActive: false });
    return { ok: true };
  }
}

/* ===================== Техника ===================== */

class VehicleDto {
  @IsString() @MinLength(1) name: string;
  @IsIn(['TRACTOR', 'COMBINE', 'TRUCK', 'SPRAYER', 'LOADER', 'OTHER']) kind: string;
  @IsOptional() @IsString() regNumber?: string | null;
  @Type(() => Number) @IsNumber() @Min(1) tankCapacityL: number;
  @IsOptional() @IsNumber() @Min(0.1) fuelNormLph?: number | null;
  @IsOptional() @IsNumber() @Min(0) normTolerancePct?: number | null;
  @IsOptional() @IsString() trackerImei?: string | null;
  @IsOptional() @IsIn(['TELTONIKA', 'WIALON_IPS', 'HTTP']) trackerProtocol?: string | null;
  /** См. domain/sensor-mapping.ts */
  @IsOptional() @IsObject() sensorMapping?: Record<string, unknown> | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@ApiTags('vehicles')
@Controller('vehicles')
export class VehiclesController {
  constructor(@InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>) {}

  @Get()
  list(@OrgId() orgId: string) {
    return this.vehicles.find({ where: { orgId }, order: { name: 'ASC' } });
  }

  @Get(':id')
  async get(@OrgId() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    const v = await this.vehicles.findOneBy({ id, orgId });
    if (!v) throw new NotFoundException();
    return v;
  }

  @Roles('ADMIN')
  @Post()
  async create(@OrgId() orgId: string, @Body() dto: VehicleDto) {
    await this.ensureImeiFree(dto.trackerImei);
    return this.vehicles.save(this.vehicles.create({ ...dto, orgId }));
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(@OrgId() orgId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VehicleDto) {
    const v = await this.vehicles.findOneBy({ id, orgId });
    if (!v) throw new NotFoundException();
    if (dto.trackerImei && dto.trackerImei !== v.trackerImei) await this.ensureImeiFree(dto.trackerImei);
    return this.vehicles.save(Object.assign(v, dto));
  }

  private async ensureImeiFree(imei?: string | null) {
    if (imei && (await this.vehicles.exists({ where: { trackerImei: imei } }))) {
      throw new ConflictException('Трекер с таким IMEI уже привязан к другой технике');
    }
  }
}
