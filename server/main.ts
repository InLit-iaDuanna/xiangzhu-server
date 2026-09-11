import { MemorySaver } from '@langchain/langgraph';
import { readFile } from 'node:fs/promises';
import { pool, one } from './db';
import { buildApp } from './app';
import { processRun } from './workflow';

// 顺序执行迁移：001 业务表 → 002 认证表（better-auth 预留，免登录未启用）→ 003 工作台文档表（pglite 多语句必须用 exec）。
for (const file of [
  './migrations/001.sql',
  './migrations/002-auth.sql',
  './migrations/003-doc.sql',
]) {
  await pool.exec(await readFile(new URL(file, import.meta.url), 'utf8'));
}

// 本地/内网免登录：注入固定用户，跳过 better-auth（用户确认：不做注册登录步骤）。
const auth = {
  handler: async () => new Response('{}', { status: 404 }),
  api: { getSession: async () => ({ user: { id: 'local-demo-user' } }) },
};

const app = await buildApp(pool, auth, {
  storage: process.env.MATERIALS_DIR ?? 'work/materials',
  origins: (process.env.WEB_ORIGINS ?? 'http://localhost:3000').split(','),
});

const saver = new MemorySaver();

// 启动时把中断的 runs 标记失败。
await pool.query(
  "UPDATE runs SET status='failed',error='执行服务重启，任务被中断；请明确重试',updated_at=now() WHERE status IN ('extracting','analyzing','evidence','planning','reviewing') OR (status='queued' AND claimed_at IS NOT NULL)",
);

const active = new Map<string, AbortController>();
let stopping = false;
let claiming = false;
const ticker = setInterval(async () => {
  if (stopping || claiming) return;
  claiming = true;
  try {
    for (const [id, c] of active) {
      const r = await one(pool, 'SELECT cancel_requested FROM runs WHERE id=$1', [
        id,
      ]);
      if (r?.cancel_requested) c.abort();
    }
    while (active.size < 2) {
      const run = await one(
        pool,
        "UPDATE runs SET claimed_at=now() WHERE id=(SELECT id FROM runs WHERE status='queued' AND claimed_at IS NULL AND NOT cancel_requested ORDER BY created_at LIMIT 1) RETURNING *",
      );
      if (!run) break;
      const controller = new AbortController();
      active.set(run.id, controller);
      processRun(pool, run, saver, controller.signal)
        .catch(async (e) => {
          await pool.query(
            "UPDATE runs SET status='failed',error=$1,updated_at=now() WHERE id=$2 AND NOT cancel_requested",
            [e instanceof Error ? e.message : '执行失败', run.id],
          );
        })
        .finally(() => active.delete(run.id));
    }
  } catch (e) {
    app.log.error(e, 'worker error');
  } finally {
    claiming = false;
  }
}, 500);

await app.listen({
  port: Number(process.env.PORT ?? 4100),
  host: process.env.HOST ?? '0.0.0.0',
});

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(ticker);
  active.forEach((c) => c.abort());
  await app.close();
  while (active.size) await new Promise((r) => setTimeout(r, 100));
  await pool.end();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
