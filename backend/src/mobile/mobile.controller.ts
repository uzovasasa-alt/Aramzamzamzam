/**
 * API для мобильного приложения водителя.
 *   GET  /api/mobile/bootstrap        — справочники (техника, базы, настройки) для работы офлайн
 *   POST /api/mobile/sync             — отправка накопленных смен/заправок/фото-метаданных/трека
 *   PUT  /api/mobile/photos/:id       — загрузка файла фото (multipart, поле file), идемпотентно
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, OrgId, Roles } from '../common/auth';
import { OrgSettingsService } from '../directory/org-settings.service';
import { Base, Photo, Vehicle } from '../entities';
import { ShiftsService } from '../shifts/shifts.service';
import { StorageService } from '../storage/storage.service';
import { SyncRequestDto } from './sync.dto';
import { SyncService } from './sync.service';

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

@ApiTags('mobile')
@Roles('DRIVER', 'MODERATOR', 'ADMIN')
@Controller('mobile')
export class MobileController {
  constructor(
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Base) private readonly bases: Repository<Base>,
    @InjectRepository(Photo) private readonly photos: Repository<Photo>,
    private readonly settings: OrgSettingsService,
    private readonly sync: SyncService,
    private readonly shifts: ShiftsService,
    private readonly storage: StorageService,
  ) {}

  @Get('bootstrap')
  async bootstrap(@CurrentUser() user: AuthUser, @OrgId() orgId: string) {
    const s = await this.settings.get(orgId);
    const vehicles = await this.vehicles.find({ where: { orgId, isActive: true }, order: { name: 'ASC' } });
    return {
      serverTime: new Date().toISOString(),
      user,
      settings: { maxGpsAccuracyM: s.maxGpsAccuracyM, requireEndInZone: s.requireEndInZone },
      bases: await this.bases.find({ where: { orgId, isActive: true } }),
      // Последние известные показания — приложение подставит их подсказкой и предупредит о расхождении
      vehicles: vehicles.map((v) => ({
        id: v.id,
        name: v.name,
        kind: v.kind,
        regNumber: v.regNumber,
        tankCapacityL: v.tankCapacityL,
        fuelNormLph: v.fuelNormLph,
        lastEngineHours: v.lastEngineHours,
        lastFuelL: v.lastFuelL,
        hasSensors: !!v.trackerImei,
      })),
      openShift: await this.shifts.openShiftOf(user.id),
    };
  }

  @Post('sync')
  @HttpCode(200)
  doSync(@CurrentUser() user: AuthUser, @OrgId() orgId: string, @Body() dto: SyncRequestDto) {
    return this.sync.sync(user, orgId, dto);
  }

  /**
   * Загрузка самого файла. Метаданные фото должны прийти раньше через /sync.
   * Повторная загрузка того же файла (обрыв связи на 99%) просто перезаписывает объект — это безопасно.
   */
  @Put('photos/:id')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES } }))
  async uploadPhoto(
    @CurrentUser() user: AuthUser,
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Нет файла (поле file)');
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) throw new BadRequestException('Допустимы только JPEG/PNG/WebP');
    const photo = await this.photos.findOneBy({ id, orgId });
    if (!photo) throw new NotFoundException('RETRY: метаданные фото ещё не синхронизированы');
    if (photo.uploadedBy && photo.uploadedBy !== user.id) throw new BadRequestException('Чужое фото');

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    if (photo.sha256 && photo.sha256 !== sha256) {
      // Хэш считается на телефоне в момент съёмки — несовпадение значит, что файл подменили
      throw new BadRequestException('Контрольная сумма фото не совпадает с заявленной');
    }
    if (photo.uploadedAt && photo.storageKey) return { id, uploaded: true, duplicate: true };

    const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
    const key = `${orgId}/${photo.takenAt.toISOString().slice(0, 7)}/${id}.${ext}`;
    await this.storage.put(key, file.buffer, file.mimetype);
    await this.photos.update(id, {
      storageKey: key,
      contentType: file.mimetype,
      sizeBytes: file.size,
      sha256,
      uploadedAt: new Date(),
    });
    return { id, uploaded: true };
  }
}
