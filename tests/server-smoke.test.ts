import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

describe('后端项目创建（UI 项目映射幂等）', () => {
  it('相同稳定 ID 重试只创建一个后端项目', async () => {
    const payload = {
      id: 'ui-project-stable-id',
      name: '映射测试项目',
      mode: 'demo',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload,
    });
    const retry = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(first.json().id).toBe(payload.id);
    expect(retry.json().id).toBe(payload.id);
    const list = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(list.json().filter((project: { id: string }) => project.id === payload.id)).toHaveLength(1);
  });
});

describe('协作区 AI 状态端点', () => {
  it('GET /api/v1/assistant/status 脱敏返回文本与生图配置', async () => {
    vi.stubEnv('TEXT_AI_PROVIDER', 'openai-compatible');
    vi.stubEnv('TEXT_API_PROTOCOL', 'chat-completions');
    vi.stubEnv('TEXT_API_BASE_URL', 'https://private.example/v1');
    vi.stubEnv('TEXT_API_KEY', 'mock-text-secret');
    vi.stubEnv('TEXT_API_MODEL', 'mock-text-model');
    vi.stubEnv('IMAGE_EXECUTOR', 'openai-compatible');
    vi.stubEnv('IMAGE_API_BASE_URL', 'https://private-image.example/v1');
    vi.stubEnv('IMAGE_API_KEY', 'mock-image-secret');
    vi.stubEnv('IMAGE_MODEL', 'mock-image-model');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assistant/status',
    });
    try {
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        available: true,
        textAI: {
          provider: 'openai-compatible',
          protocol: 'chat-completions',
          configured: true,
          available: true,
          model: 'mock-text-model',
        },
        imageGen: {
          executor: 'openai-compatible',
          configured: true,
          available: true,
          model: 'mock-image-model',
        },
      });
      expect(body).not.toHaveProperty('cliPath');
      expect(JSON.stringify(body)).not.toContain('mock-text-secret');
      expect(JSON.stringify(body)).not.toContain('mock-image-secret');
      expect(JSON.stringify(body)).not.toContain('private.example');
      expect(JSON.stringify(body)).not.toContain('private-image.example');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('render route clearly reports an unconfigured image provider without calling an API', async () => {
    vi.stubEnv('IMAGE_EXECUTOR', 'openai-compatible');
    vi.stubEnv('IMAGE_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assistant/render',
        payload: { prompt: '合成场景验收', count: 1 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ configured: false });
      expect(res.json().guide).toContain('IMAGE_API_KEY');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('chat route maps provider SSE into the existing app event contract', async () => {
    vi.stubEnv('TEXT_AI_PROVIDER', 'openai-compatible');
    vi.stubEnv('TEXT_API_PROTOCOL', 'responses');
    vi.stubEnv('TEXT_API_BASE_URL', 'https://mock-text.invalid/v1');
    vi.stubEnv('TEXT_API_KEY', 'mock-chat-secret');
    vi.stubEnv('TEXT_API_MODEL', 'mock-chat-model');
    const providerEvents = [
      { type: 'response.reasoning_summary_text.delta', delta: 'private reasoning' },
      { type: 'response.output_text.delta', delta: 'Mock answer' },
      { type: 'response.completed' },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(providerEvents, {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assistant/chat',
        payload: { messages: [{ role: 'user', text: '用一句话介绍工作台。' }] },
      });
      expect(res.statusCode).toBe(200);
      const events = res.body
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5).trim()));
      expect(events.map((event: { type: string }) => event.type)).toEqual([
        'status',
        'delta',
        'done',
      ]);
      expect(events[1]).toEqual({ type: 'delta', text: 'Mock answer' });
      expect(res.body).not.toContain('private reasoning');
      const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(requestBody.instructions).toContain('乡筑');
      expect(requestBody.instructions).toContain('当前可用动作');
      expect(JSON.stringify(requestBody.input)).not.toContain('当前可用动作');
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('chat route reports oversized images through the SSE error event without calling a provider', async () => {
    vi.stubEnv('TEXT_AI_PROVIDER', 'openai-compatible');
    vi.stubEnv('TEXT_API_PROTOCOL', 'responses');
    vi.stubEnv('TEXT_API_KEY', 'mock-chat-secret');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assistant/chat',
        payload: {
          messages: [{ role: 'user', text: '请看这张图。' }],
          attachments: [{ kind: 'image', mime: 'image/png', data: 'A'.repeat(11_184_816) }],
        },
      });
      const events = res.body
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5).trim()));
      expect(res.statusCode).toBe(200);
      expect(events).toEqual([{
        type: 'error',
        code: 'ATTACHMENT_TOO_LARGE',
        message: '单张对话图片不能超过 8 MB。',
      }]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
