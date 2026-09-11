import { PGlite } from '@electric-sql/pglite';
export type DB = {
  query: (
    sql: string,
    args?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
  connect?: () => Promise<any>;
};
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

// 嵌入式 postgres（pglite）：默认持久化到 work/pglite-data（重启不丢数据）；
// 显式设置 PGLITE_DATA_DIR=memory 时回到内存模式（仅临时演示用）。
const raw = process.env.PGLITE_DATA_DIR?.trim();
const client = new PGlite(
  raw === 'memory' ? undefined : raw || 'work/pglite-data',
);

// 暴露与 pg.Pool 兼容的最小接口：query / connect / end。
// connect 返回一个「事务客户端」，BEGIN/COMMIT/ROLLBACK 由 transaction() 用 SQL 控制；
// pglite 单实例串行执行，无需真正的连接池。
export const pool = {
  query: async (sql: string, args: any[] = []) => {
    const result = await client.query(sql, args);
    return { rows: result.rows as any[], rowCount: result.affectedRows ?? null };
  },
  connect: async () => ({
    query: async (sql: string, args: any[] = []) => {
      const result = await client.query(sql, args);
      return { rows: result.rows as any[], rowCount: result.affectedRows ?? null };
    },
    release: async () => {},
  }),
  exec: async (sql: string) => {
    await client.exec(sql);
  },
  end: async () => {
    await client.close();
  },
};

export async function transaction<T>(
  db: DB,
  fn: (tx: DB) => Promise<T>,
): Promise<T> {
  const tx = db.connect ? await db.connect() : db;
  await tx.query('BEGIN');
  try {
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (e) {
    await tx.query('ROLLBACK');
    throw e;
  } finally {
    if ('release' in tx) (tx as any).release();
  }
}

export async function one(db: DB, sql: string, args: any[] = []) {
  return (await db.query(sql, args)).rows[0];
}

export async function audit(
  db: DB,
  user: string,
  project: string | null,
  action: string,
  id: string | null = null,
  payload: unknown = {},
) {
  await db.query(
    'INSERT INTO audit(user_id,project_id,action,object_id,payload) VALUES($1,$2,$3,$4,$5)',
    [user, project, action, id, JSON.stringify(payload)],
  );
}
