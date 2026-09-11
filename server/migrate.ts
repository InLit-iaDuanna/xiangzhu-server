import { readFile } from 'node:fs/promises';
import { getMigrations } from 'better-auth/db/migration';
import { makeAuth } from './auth';
import { pool } from './db';
await pool.query(
  await readFile(new URL('./migrations/001.sql', import.meta.url), 'utf8'),
);
const auth = makeAuth();
await auth.$context;
const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
console.log('业务与认证数据库已迁移');
await pool.end();
