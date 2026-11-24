import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    if (!process.env[k]) throw new Error(`Не задана переменная окружения ${k} (см. .env.example)`);
  }
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  app.enableShutdownHooks();

  // Документация API: http://localhost:3000/api/docs — пригодится разработчику мобильного приложения
  const doc = new DocumentBuilder()
    .setTitle('АгроКонтроль API')
    .setDescription('Контроль топлива и рабочего времени сельхозтехники')
    .setVersion('0.1')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`API: http://localhost:${port}/api  ·  Документация: http://localhost:${port}/api/docs`, 'Bootstrap');
}
bootstrap();
