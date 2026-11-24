import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ENTITIES } from '../entities';
import { Init1730000000000 } from './migrations/1730000000000-Init';

export function dataSourceOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    url: process.env.DATABASE_URL ?? 'postgres://agro:agro@localhost:5432/agro',
    entities: ENTITIES,
    migrations: [Init1730000000000],
    synchronize: false,
    logging: process.env.DB_LOGGING === 'true',
  };
}

/** Используется CLI TypeORM для миграций */
export default new DataSource(dataSourceOptions());
