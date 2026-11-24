import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/auth';
import { StorageService } from './storage.service';

/** Раздача фото в режиме STORAGE_DRIVER=disk по подписанной ссылке (в режиме s3 не используется). */
@ApiExcludeController()
@Controller('files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Get(':key')
  async get(@Param('key') key: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    const buf = await this.storage.readSigned(key /* Express уже раскодировал %2F */,Number(exp), sig);
    res.setHeader('Content-Type', key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.send(buf);
  }
}
