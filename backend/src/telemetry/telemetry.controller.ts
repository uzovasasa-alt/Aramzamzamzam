import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsNumber, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Repository } from 'typeorm';
import { OrgId, Public, Roles } from '../common/auth';
import { TELTONIKA_COMMON_IO } from './parsers/teltonika';
import { Vehicle } from '../entities';
import { TelemetryService } from './telemetry.service';

class HttpRecordDto {
  @IsDateString() ts: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lon?: number;
  @IsOptional() @IsNumber() speedKmh?: number;
  @IsOptional() @IsObject() params?: Record<string, number | string>;
}

class HttpIngestDto {
  @IsString() imei: string;
  @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => HttpRecordDto) records: HttpRecordDto[];
}

@ApiTags('telemetry')
@Controller('telemetry')
export class TelemetryController {
  constructor(
    private readonly telemetry: TelemetryService,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
  ) {}

  /**
   * Приём телеметрии по HTTP — для своих устройств (ESP32 + CAN-модуль), шлюзов
   * и ретрансляции из Wialon/Omnicomm. Заголовок X-Telemetry-Key = TELEMETRY_HTTP_KEY из .env.
   */
  @Public()
  @Post('ingest')
  @HttpCode(200)
  async ingest(@Headers('x-telemetry-key') key: string | undefined, @Body() dto: HttpIngestDto) {
    const expected = process.env.TELEMETRY_HTTP_KEY;
    if (!expected || key !== expected) throw new UnauthorizedException('Неверный X-Telemetry-Key');
    const vehicle = await this.telemetry.findByImei(dto.imei);
    if (!vehicle) throw new NotFoundException(`IMEI ${dto.imei} не привязан к технике`);
    const n = await this.telemetry.ingest(
      vehicle,
      dto.records.map((r) => ({
        ts: new Date(r.ts),
        lat: r.lat ?? null,
        lon: r.lon ?? null,
        speedKmh: r.speedKmh ?? null,
        course: null,
        altitude: null,
        satellites: null,
        params: r.params ?? {},
      })),
    );
    return { accepted: n };
  }

  /** Справочник популярных IO-параметров Teltonika для настройки sensorMapping в веб-панели */
  @Get('teltonika-io')
  teltonikaIo() {
    return TELTONIKA_COMMON_IO;
  }

  /** Данные датчиков за период + найденные сливы/заправки — для графика в веб-панели */
  @Roles('ADMIN', 'MODERATOR')
  @Get('vehicles/:id')
  async vehicleTelemetry(
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const v = await this.vehicles.findOneBy({ id, orgId });
    if (!v) throw new NotFoundException();
    const t = to ? new Date(to) : new Date();
    const f = from ? new Date(from) : new Date(t.getTime() - 24 * 3_600_000);
    return { samples: await this.telemetry.samples(id, f, t), events: await this.telemetry.events(v, f, t) };
  }

  /** Ручной запуск анализа (кнопка «Проверить сейчас» в веб-панели) */
  @Roles('ADMIN', 'MODERATOR')
  @Post('vehicles/:id/analyze')
  @HttpCode(200)
  async analyze(@OrgId() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    const v = await this.vehicles.findOneBy({ id, orgId });
    if (!v) throw new NotFoundException();
    const to = new Date();
    await this.telemetry.analyzeVehicle(v, new Date(to.getTime() - 48 * 3_600_000), to);
    return { ok: true };
  }
}
