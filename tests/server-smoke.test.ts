import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 冒烟：免登录（stub auth）下 fastify 核心端点与工作台文档乐观锁。
// pglite 用内存模式（必须在动态 import db.ts 前设置，避开磁盘持久化目录）。
let storageDir: string;
let app: Awaited<ReturnType<typeof import('../server/app')['buildApp']>>;
let pool: typeof import('../server/db')['pool'];

beforeAll(async () => {
  process.env.PGLITE_DATA_DIR = 'memory';
  const db = await import('../server/db');
  const { buildApp } = await import('../server/app');
  pool = db.pool;
  // 内存库是全新的：与 main.ts 相同顺序执行迁移（pglite 多语句必须 exec）。
  const serverDir = fileURLToPath(new URL('../server', import.meta.url));
  for (const file of [
    'migrations/001.sql',
    'migrations/002-auth.sql',
    'migrations/003-doc.sql',
  ]) {
    await pool.exec(await readFile(join(serverDir, file), 'utf8'));
  }
  storageDir = await mkdtemp(join(tmpdir(), 'xz-materials-'));
  await writeFile(join(storageDir, '.keep'), '');
  app = await buildApp(
    pool,
    {
      handler: async () => new Response('{}', { status: 404 }),
      api: {
        getSession: async () => ({ user: { id: 'smoke-test-user' } }),
      },
    },
    { storage: storageDir, origins: ['http://localhost:3000'] },
  );
});

afterAll(async () => {
  await app.close();
  await rm(storageDir, { recursive: true, force: true });
});

describe('health', () => {
  it('GET /api/v1/health 返回 ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});

describe('工作台文档（doc 乐观锁）', () => {
  it('初始文档为空数组且版本为 0', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/workspace/doc',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ doc: [], version: 0 });
  });

  it('PUT 正确版本推进版本号；PUT 过期版本返回 409', async () => {
    const put1 = await app.inject({
      method: 'PUT',
      url: '/api/v1/workspace/doc',
      payload: { doc: [{ id: 'p1', name: '一号项目' }], version: 0 },
    });
    expect(put1.statusCode).toBe(200);
    expect(put1.json()).toEqual({ version: 1 });

    // 过期版本：模拟另一设备已先保存。
    const stale = await app.inject({
      method: 'PUT',
      url: '/api/v1/workspace/doc',
      payload: { doc: [{ id: 'p1', name: '旧内容' }], version: 0 },
    });
    expect(stale.statusCode).toBe(409);

    const put2 = await app.inject({
      method: 'PUT',
      url: '/api/v1/workspace/doc',
      payload: { doc: [{ id: 'p1', name: '二号内容' }], version: 1 },
    });
    expect(put2.statusCode).toBe(200);
    expect(put2.json()).toEqual({ version: 2 });

    const get = await app.inject({ method: 'GET', url: '/api/v1/workspace/doc' });
    expect(get.json()).toEqual({
      doc: [{ id: 'p1', name: '二号内容' }],
      version: 2,
    });
  });

  it('非法载荷返回 422（zod 校验）', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/workspace/doc',
      payload: { doc: 'not-an-array', version: 2 },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('协作区 AI 状态端点', () => {
  it('GET /api/v1/assistant/status 返回可用性结构', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assistant/status',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('available');
    expect(body).toHaveProperty('cliPath');
    expect(body).toHaveProperty('version');
  });
});
