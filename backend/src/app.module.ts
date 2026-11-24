import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnomaliesController } from './anomalies/anomalies.controller';
import { AnomaliesService } from './anomalies/anomalies.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './common/auth';
import { dataSourceOptions } from './database/data-source';
import {
  BasesController,
  OrganizationsController,
  UsersController,
  VehiclesController,
} from './directory/directory.controllers';
import { OrgSettingsService } from './directory/org-settings.service';
import { ENTITIES } from './entities';
import { HealthController } from './health.controller';
import { MobileController } from './mobile/mobile.controller';
import { SyncService } from './mobile/sync.service';
import { RefuelingsController } from './shifts/refuelings.controller';
import { ReportsController } from './shifts/reports.controller';
import { ShiftsController } from './shifts/shifts.controller';
import { ShiftsService } from './shifts/shifts.service';
import { FilesController } from './storage/files.controller';
import { StorageService } from './storage/storage.service';
import { TelemetryController } from './telemetry/telemetry.controller';
import { TelemetryService } from './telemetry/telemetry.service';
import { TrackerGateways } from './telemetry/tracker-gateways';

/**
 * Один модуль на весь MVP — проще ориентироваться команде.
 * Когда проект вырастет, его легко разрезать на модули по папкам.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({ useFactory: () => ({ ...dataSourceOptions(), migrationsRun: true }) }),
    TypeOrmModule.forFeature(ENTITIES),
    JwtModule.register({}),
  ],
  controllers: [
    HealthController,
    AuthController,
    OrganizationsController,
    UsersController,
    BasesController,
    VehiclesController,
    ShiftsController,
    RefuelingsController,
    ReportsController,
    AnomaliesController,
    MobileController,
    TelemetryController,
    FilesController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    AuthService,
    OrgSettingsService,
    AnomaliesService,
    ShiftsService,
    SyncService,
    StorageService,
    TelemetryService,
    TrackerGateways,
  ],
})
export class AppModule {}
