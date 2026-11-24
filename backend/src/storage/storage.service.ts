/**
 * Хранилище фотографий.
 *  - disk: папка на диске (по умолчанию; в Docker — том `photos`)
 *  - s3:   любое S3-совместимое хранилище (Yandex Object Storage / VK Cloud / Selectel) для продакшена
 * Браузер модератора получает фото по подписанной временной ссылке.
 */
import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger(StorageService.name);
  private readonly driver = process.env.STORAGE_DRIVER ?? 'disk';
  private readonly bucket = process.env.S3_BUCKET ?? 'agro-photos';
  private readonly diskRoot = path.resolve(process.env.DISK_STORAGE_PATH ?? './uploads');
  private s3?: S3Client;
  /** Отдельный клиент с публичным адресом — чтобы подписанная ссылка открывалась из браузера */
  private s3Public?: S3Client;

  async onModuleInit() {
    if (this.driver === 's3') {
      const common = {
        region: process.env.S3_REGION ?? 'ru-central1',
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
        credentials: { accessKeyId: process.env.S3_ACCESS_KEY ?? '', secretAccessKey: process.env.S3_SECRET_KEY ?? '' },
      };
      this.s3 = new S3Client({ ...common, endpoint: process.env.S3_ENDPOINT });
      this.s3Public = new S3Client({ ...common, endpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT });
      try {
        await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch {
        this.log.warn(`Бакет ${this.bucket} не найден — создаю`);
        await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket })).catch((e: unknown) => this.log.error(e));
      }
    } else {
      await fs.mkdir(this.diskRoot, { recursive: true });
      this.log.log(`Фото сохраняются на диск: ${this.diskRoot}`);
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
      return;
    }
    const file = this.safePath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }

  /** Временная ссылка для просмотра (15 минут) */
  async signedUrl(key: string, ttlSec = 900): Promise<string> {
    if (this.s3Public) {
      return getSignedUrl(this.s3Public, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSec });
    }
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `/api/files/${encodeURIComponent(key)}?exp=${exp}&sig=${this.sign(key, exp)}`;
  }

  /** Для disk-режима: проверка подписи и чтение файла */
  async readSigned(key: string, exp: number, sig: string): Promise<Buffer> {
    const expected = Buffer.from(this.sign(key, exp));
    const given = Buffer.from(sig ?? '');
    if (exp < Date.now() / 1000 || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new NotFoundException();
    }
    return fs.readFile(this.safePath(key));
  }

  private sign(key: string, exp: number): string {
    return createHmac('sha256', process.env.JWT_ACCESS_SECRET ?? 'dev').update(`${key}:${exp}`).digest('hex');
  }

  private safePath(key: string): string {
    const p = path.resolve(this.diskRoot, key);
    if (!p.startsWith(this.diskRoot + path.sep)) throw new NotFoundException();
    return p;
  }
}
