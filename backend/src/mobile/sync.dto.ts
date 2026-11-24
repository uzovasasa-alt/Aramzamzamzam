import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ShiftSyncDto {
  @IsUUID() id: string;
  @IsUUID() vehicleId: string;
  @IsDateString() startedAt: string;
  @IsOptional() @IsDateString() endedAt?: string | null;
  @IsLatitude() startLat: number;
  @IsLongitude() startLon: number;
  @IsNumber() @Min(0) startAccuracyM: number;
  @IsOptional() @IsLatitude() endLat?: number | null;
  @IsOptional() @IsLongitude() endLon?: number | null;
  @IsOptional() @IsNumber() @Min(0) endAccuracyM?: number | null;
  @IsOptional() @IsBoolean() mockLocation?: boolean;
  @IsNumber() @Min(0) @Max(1_000_000) startEngineHours: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) endEngineHours?: number | null;
  @IsNumber() @Min(0) @Max(100_000) startFuelL: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000) endFuelL?: number | null;
  @IsOptional() @IsString() @MaxLength(2000) driverNote?: string | null;
  /** Время последнего изменения на телефоне — «побеждает» более свежая версия */
  @IsDateString() clientUpdatedAt: string;
}

export class RefuelSyncDto {
  @IsUUID() id: string;
  @IsUUID() vehicleId: string;
  @IsOptional() @IsUUID() shiftId?: string | null;
  @IsNumber() @Min(0.1) @Max(100_000) liters: number;
  @IsDateString() occurredAt: string;
  @IsOptional() @IsLatitude() lat?: number | null;
  @IsOptional() @IsLongitude() lon?: number | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
  @IsDateString() clientUpdatedAt: string;
}

export const PHOTO_KINDS = ['START_HOURS', 'START_FUEL', 'END_HOURS', 'END_FUEL', 'REFUEL_RECEIPT', 'REFUEL_METER'] as const;

export class PhotoMetaDto {
  @IsUUID() id: string;
  @IsIn(PHOTO_KINDS) kind: (typeof PHOTO_KINDS)[number];
  @IsOptional() @IsUUID() shiftId?: string | null;
  @IsOptional() @IsUUID() refuelingId?: string | null;
  @IsDateString() takenAt: string;
  @IsOptional() @IsLatitude() lat?: number | null;
  @IsOptional() @IsLongitude() lon?: number | null;
  @IsOptional() @IsString() sha256?: string | null;
}

export class TrackPointDto {
  @IsUUID() shiftId: string;
  @IsDateString() ts: string;
  @IsLatitude() lat: number;
  @IsLongitude() lon: number;
  @IsOptional() @IsNumber() accuracyM?: number | null;
  @IsOptional() @IsNumber() speedKmh?: number | null;
}

/** Пакет синхронизации: телефон отправляет всё, что накопил офлайн. */
export class SyncRequestDto {
  @IsOptional() @IsString() deviceId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ShiftSyncDto)
  shifts?: ShiftSyncDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => RefuelSyncDto)
  refuelings?: RefuelSyncDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => PhotoMetaDto)
  photos?: PhotoMetaDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(10_000) @ValidateNested({ each: true }) @Type(() => TrackPointDto)
  trackPoints?: TrackPointDto[];
}

export type ItemResult = { id: string; result: 'ok' | 'rejected'; reason?: string };
