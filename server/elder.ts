/**
 * 老人视角智能体工作台（elder-workbench）API 客户端。
 *
 * 乡筑把「道路/场景照片 + 任务」交给远端老人工作台做视角评估：
 * - 账号：env ELDER_USERNAME / ELDER_PASSWORD（首次自动 注册-or-登录），token 进程内缓存
 * - 请求 401 时自动清 token 重登一次（服务端内存表重启即失效）
 * - 图片直接以 data URL 透传，角色批量并行 + 自动汇总
 */
import { HttpError } from './db';

export type ElderPersona = {
  id: string;
  name: string;
  age: number;
  tags: string[];
  summary: string;
};

export type ElderItem =
  | { status: 'fulfilled'; result: any; model: string; elapsed_ms: number }
  | { status: 'rejected'; persona_id: string; error: string };

export type ElderTestOutput = {
  items: ElderItem[];
  comparison: {
    shared_issues: string[];
    persona_specific_issues: string[];
    priority_issues: string[];
    need_human_check: string[];
    summary: string;
  } | null;
};

const apiBase = () => (process.env.ELDER_API ?? 'http://yeye.chugao.art').replace(/\/$/, '');
let cachedToken: string | null = null;

/** 跟随站点/反代跳转，但保留 POST 与 Authorization，避免 301/302 把登录请求降成 GET。 */
async function elderRequest(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
  let url = pathOrUrl.startsWith('http') ? pathOrUrl : apiBase() + pathOrUrl;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    url = new URL(location, url).toString();
  }
  throw new HttpError(502, '老人工作台重定向次数过多');
}

async function ensureToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const username = process.env.ELDER_USERNAME;
  const password = process.env.ELDER_PASSWORD;
  if (!username || !password)
    throw new HttpError(500, '未配置老人工作台账号（ELDER_USERNAME / ELDER_PASSWORD）');
  const body = JSON.stringify({ username, password });
  const login = await elderRequest('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (login.ok) {
    cachedToken = ((await login.json()) as { token: string }).token;
    return cachedToken;
  }
  const reg = await elderRequest('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await reg.text();
  if (!reg.ok)
    throw new HttpError(502, `老人工作台账号注册失败（HTTP ${reg.status}）：${text.slice(0, 200)}`);
  cachedToken = (JSON.parse(text) as { token: string }).token;
  return cachedToken;
}

async function elderFetch(
  path: string,
  init: RequestInit = {},
  allowRetry = true,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  };
  // 角色库是公开接口，登录类接口自带凭据——这两类都不附加 Bearer
  const publicPath = path.startsWith('/api/auth/') || path === '/api/personas';
  const authed = !publicPath;
  if (authed) headers.Authorization = `Bearer ${await ensureToken()}`;
  const res = await elderRequest(path, {
    ...init,
    headers,
    signal: AbortSignal.timeout(320_000),
  });
  if (res.status === 401 && authed && allowRetry) {
    cachedToken = null;
    return elderFetch(path, init, false);
  }
  return res;
}

export async function elderPersonas(): Promise<ElderPersona[]> {
  const res = await elderFetch('/api/personas');
  if (!res.ok) throw new HttpError(502, `老人工作台不可用（HTTP ${res.status}）`);
  const j = (await res.json()) as { personas: ElderPersona[] };
  return j.personas;
}

export async function elderTest(input: {
  persona_ids: string[];
  task: string;
  context_type: 'image' | 'text';
  context: string;
}): Promise<ElderTestOutput> {
  const res = await elderFetch('/api/evaluate/batch', {
    method: 'POST',
    body: JSON.stringify({
      persona_ids: input.persona_ids,
      task: input.task,
      context_type: input.context_type,
      context: input.context,
      mode: 'strict',
      test_mode: 'first-use',
    }),
  });
  const text = await res.text();
  if (!res.ok)
    throw new HttpError(502, `老人视角评估失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
  const j = JSON.parse(text) as { items: ElderItem[] };
  const ok = j.items.filter((it) => it.status === 'fulfilled').map((it) => it.result);
  let comparison: ElderTestOutput['comparison'] = null;
  if (ok.length >= 2) {
    try {
      const c = await elderFetch('/api/compare', {
        method: 'POST',
        body: JSON.stringify({ results: ok }),
      });
      if (c.ok) comparison = ((await c.json()) as { result: ElderTestOutput['comparison'] }).result;
    } catch {
      // 汇总失败不阻塞单角色结果（与 elder-workbench 自身降级策略一致）
    }
  }
  return { items: j.items, comparison };
}
