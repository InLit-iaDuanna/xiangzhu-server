// AI 效果图生成执行器（框架先行）：支持 OpenAI 兼容生图接口与腾讯云混元生图。
// 密钥未配置时 imageGenAvailable() 返回 false，路由返回配置指引而非报错堆栈。
// 配置项（server/.env.local）：
//   IMAGE_EXECUTOR = openai-compatible | chugao | hunyuan
//   IMAGE_API_KEY / IMAGE_API_BASE_URL / IMAGE_MODEL   （openai-compatible）
//   TENCENT_SECRET_ID / TENCENT_SECRET_KEY             （hunyuan）
//   IMAGE_COUNT 可覆盖默认 4 版
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export type ImageRequest = {
  prompt: string;
  /** 现状照片（图生图参考），base64 不带 data: 前缀 */
  reference?: { mime: string; base64: string } | null;
  count: number;
  signal?: AbortSignal;
};

export type GeneratedImage = { mime: string; base64: string };

const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
const DEFAULT_IMAGE_TIMEOUT_MS = 180_000;
const MAX_PROMPT_CHARS = 32_000;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function imageGenConfig(): {
  executor: 'openai-compatible' | 'chugao' | 'hunyuan' | null;
  count: number;
  model: string | null;
} {
  const executor = (process.env.IMAGE_EXECUTOR ?? '').trim();
  const normalized =
    executor === 'openai-compatible' || executor === 'chugao' || executor === 'hunyuan'
      ? executor
      : null;
  const count = Math.min(6, Math.max(1, Number(process.env.IMAGE_COUNT) || 4));
  return {
    executor: normalized,
    count,
    model: normalized === 'openai-compatible'
      ? (process.env.IMAGE_MODEL?.trim() || 'gpt-image-1')
      : normalized === 'chugao'
        ? (process.env.IMAGE_MODEL?.trim() || 'gpt-image-2')
      : null,
  };
}

export function imageGenAvailable(): boolean {
  const { executor } = imageGenConfig();
  if (!executor) return false;
  if (executor === 'openai-compatible')
    return Boolean(process.env.IMAGE_API_KEY);
  if (executor === 'chugao')
    return Boolean(process.env.IMAGE_API_KEY);
  if (executor === 'hunyuan')
    return Boolean(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY);
  return false;
}

export function imageGenGuide(): string {
  return [
    'AI 效果图生成模型尚未配置。在 server 的 .env.local 中填入以下任一配置即可启用（无需改代码）：',
    '① OpenAI 兼容生图接口：IMAGE_EXECUTOR=openai-compatible + IMAGE_API_KEY + IMAGE_API_BASE_URL + IMAGE_MODEL（硅基流动 / 智谱 CogView / 通义万相等）',
    '② Chugao 生图接口：IMAGE_EXECUTOR=chugao + IMAGE_API_BASE_URL=https://chugao.art/api/v1 + IMAGE_API_KEY + IMAGE_MODEL（如 gpt-image-2）',
    '③ 腾讯云混元生图：IMAGE_EXECUTOR=hunyuan + TENCENT_SECRET_ID + TENCENT_SECRET_KEY',
    '配置后重启后端，点击「AI 生成效果图」即可一次生成 4 版概念效果供挑选。',
  ].join('\n');
}

// 4 版采样：同一要求下的风格差异化词（保守微改 → 标准改造 → 景观丰富 → 完整无障碍）。
export const SAMPLE_STYLES = [
  '保守微改：尽量保留原貌，仅添加必要的安全与休息设施',
  '标准改造：适度增设休息区、连续扶手与照明，材质色彩与原有环境协调',
  '景观丰富：增加绿化、遮阳廊架与活动场地层次，形成可停留的交往空间',
  '完整无障碍：全路径无障碍坡道、连贯扶手系统与夜间照明，细节适老化',
] as const;

function buildPrompt(base: string, style: string): string {
  return [
    base,
    `本版侧重：${style}。`,
    '画面要求：真实摄影质感、白天自然光、保持原有建筑肌理与树木，仅呈现适老化改造后的场景，无文字水印、无人物面部特写。',
  ].join('\n');
}

function imageApiError(status: number): Error {
  if (status === 401 || status === 403) return new Error('生图服务鉴权失败，请检查服务端 API 密钥及权限。');
  if (status === 429) return new Error('生图服务限流，请稍后重试。');
  if (status >= 500) return new Error('生图服务暂时不可用，请稍后重试。');
  return new Error(`生图服务拒绝了请求（HTTP ${status}）。`);
}

function imageAuthHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.IMAGE_API_KEY ?? ''}`,
  };
  if (contentType) headers['Content-Type'] = contentType;
  const actor = process.env.IMAGE_API_ACTOR_AUTHORIZATION?.trim()
    || process.env.OPENAI_ACTOR_AUTHORIZATION?.trim();
  if (actor) headers['x-openai-actor-authorization'] = actor;
  return headers;
}

function validateImageRequest(req: ImageRequest): void {
  if (!req.prompt.trim()) throw new Error('缺少设计要求（prompt）。');
  if (req.prompt.length > MAX_PROMPT_CHARS) throw new Error(`设计要求不能超过 ${MAX_PROMPT_CHARS} 个字符。`);
  if (req.reference) {
    const mime = req.reference.mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : req.reference.mime.toLowerCase();
    if (!IMAGE_MIMES.has(mime)) throw new Error('参考图片格式仅支持 PNG、JPEG 或 WebP。');
    const encoded = req.reference.base64;
    if (!encoded || encoded.length > Math.ceil(MAX_REFERENCE_IMAGE_BYTES * 4 / 3) + 8) {
      throw new Error('参考图片不能超过 10 MB。');
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('参考图片数据格式无效。');
    }
    if (Buffer.from(encoded, 'base64').byteLength > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error('参考图片不能超过 10 MB。');
    }
  }
}

async function imageFromResponse(response: Response, signal: AbortSignal): Promise<GeneratedImage> {
  if (!response.ok) throw imageApiError(response.status);
  let json: { data?: { b64_json?: string; url?: string }[] };
  try {
    json = await response.json() as typeof json;
  } catch {
    throw new Error('生图服务返回了无法解析的响应。');
  }
  const item = json.data?.[0];
  if (item?.b64_json) return { mime: 'image/png', base64: item.b64_json };
  if (item?.url) {
    const bin = await fetch(item.url, { signal });
    if (!bin.ok) throw new Error('无法下载生图服务返回的图片。');
    const buf = Buffer.from(await bin.arrayBuffer());
    return { mime: bin.headers.get('content-type') ?? 'image/png', base64: buf.toString('base64') };
  }
  throw new Error('生图服务未返回图片数据。');
}

async function generateOpenAICompatible(req: ImageRequest, style: string, signal: AbortSignal): Promise<GeneratedImage> {
  const base = (process.env.IMAGE_API_BASE_URL ?? OPENAI_DEFAULT_BASE).replace(/\/+$/, '');
  const model = process.env.IMAGE_MODEL?.trim() || 'gpt-image-1';
  const key = process.env.IMAGE_API_KEY ?? '';
  const prompt = buildPrompt(req.prompt, style);
  // 参考图请求必须成功使用 edits；失败时明确报错，不能无声丢弃参考图。
  if (req.reference) {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt.slice(0, MAX_PROMPT_CHARS));
    form.append('n', '1');
    form.append(
      'image',
      new Blob([Buffer.from(req.reference.base64, 'base64')], {
        type: req.reference.mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : req.reference.mime,
      }),
      'reference.png',
    );
    const res = await fetch(`${base}/images/edits`, {
      method: 'POST',
      headers: imageAuthHeaders(),
      body: form,
      signal,
    });
    return imageFromResponse(res, signal);
  }
  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: imageAuthHeaders('application/json'),
    body: JSON.stringify({ model, prompt, n: 1 }),
    signal,
  });
  return imageFromResponse(res, signal);
}

const CHUGAO_DEFAULT_BASE = 'https://chugao.art/api/v1';
const CHUGAO_MAX_PROMPT_CHARS = 4000;

function chugaoHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.IMAGE_API_KEY ?? ''}` };
}

async function chugaoJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    throw new Error('生图服务返回了无法解析的响应。');
  }
}

function generatedImageFromChugaoData(data: any): GeneratedImage | null {
  const item = data?.images?.[0];
  if (typeof item?.b64_json === 'string' && item.b64_json) {
    return { mime: item.mimeType || 'image/png', base64: item.b64_json };
  }
  return null;
}

async function waitForChugaoGeneration(
  base: string,
  id: string,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const response = await fetch(`${base}/generations/${encodeURIComponent(id)}`, {
      headers: chugaoHeaders(),
      signal,
    });
    if (!response.ok) throw imageApiError(response.status);
    const json = await chugaoJson(response);
    const data = json?.data;
    const image = generatedImageFromChugaoData(data);
    if (image) return image;
    if (data?.status === 'FAILED') throw new Error('生图服务生成失败。');
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(resolve, 2000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }
  throw new Error('生图服务超时，请稍后重试。');
}

async function uploadChugaoReference(
  base: string,
  reference: { mime: string; base64: string },
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  const mime = reference.mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : reference.mime;
  form.append(
    'file',
    new Blob([Buffer.from(reference.base64, 'base64')], { type: mime }),
    'reference.png',
  );
  const response = await fetch(`${base}/uploads`, {
    method: 'POST',
    headers: chugaoHeaders(),
    body: form,
    signal,
  });
  if (!response.ok) throw imageApiError(response.status);
  const json = await chugaoJson(response);
  const key = json?.data?.key;
  if (typeof key !== 'string' || !key) throw new Error('生图服务未返回参考图 key。');
  return key;
}

async function generateChugao(req: ImageRequest, style: string, signal: AbortSignal): Promise<GeneratedImage> {
  const base = (process.env.IMAGE_API_BASE_URL ?? CHUGAO_DEFAULT_BASE).replace(/\/+$/, '');
  const modelId = process.env.IMAGE_MODEL?.trim() || 'gpt-image-2';
  const prompt = buildPrompt(req.prompt, style).slice(0, CHUGAO_MAX_PROMPT_CHARS);
  const referenceImageKeys = req.reference
    ? [await uploadChugaoReference(base, req.reference, signal)]
    : undefined;
  const payload: Record<string, unknown> = {
    modelId,
    prompt,
    n: 1,
    size: process.env.IMAGE_SIZE?.trim() || '1024x1024',
    outputFormat: 'png',
    ...(process.env.IMAGE_QUALITY?.trim() ? { quality: process.env.IMAGE_QUALITY.trim() } : {}),
    ...(referenceImageKeys ? { referenceImageKeys } : {}),
  };
  const response = await fetch(`${base}/generations?wait=false`, {
    method: 'POST',
    headers: {
      ...chugaoHeaders(),
      'Content-Type': 'application/json',
      'Idempotency-Key': `xiangzhu-${randomUUID()}`,
    },
    body: JSON.stringify(payload),
    signal,
  });
  const json = await chugaoJson(response);
  const taskId = json?.data?.id || json?.error?.details?.id;
  const image = generatedImageFromChugaoData(json?.data);
  if (image) return image;
  if (taskId) return waitForChugaoGeneration(base, String(taskId), signal);
  if (!response.ok) throw imageApiError(response.status);
  if (json?.data?.status === 'FAILED') throw new Error('生图服务生成失败。');
  throw new Error('生图服务未返回图片数据。');
}

// 腾讯云混元生图：签名 V3（TC3-HMAC-SHA256），SubmitHunyuanImageJob 轮询出图。
// 框架阶段先给出标准实现骨架；未配密钥时不会走到这里。
async function generateHunyuan(req: ImageRequest, style: string, signal: AbortSignal): Promise<GeneratedImage> {
  const service = 'hunyuan';
  const host = 'hunyuan.tencentcloudapi.com';
  const version = '2023-09-01';
  const payload: Record<string, unknown> = {
    Prompt: buildPrompt(req.prompt, style),
    Style: 'photorealistic',
    Num: 1,
  };
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const secretId = process.env.TENCENT_SECRET_ID ?? '';
  const secretKey = process.env.TENCENT_SECRET_KEY ?? '';
  const crypto = await import('node:crypto');
  const sha256hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
  const hmac = (alg: string, key: string | Buffer, s: string) =>
    crypto.createHmac(alg, key).update(s).digest();
  const canonicalRequest = `POST\n/\n\ncontent-type:application/json\nhost:${host}\nx-tc-action:${'SubmitHunyuanImageJob'.toLowerCase()}\n\ncontent-type;host;x-tc-action\n${sha256hex(body)}`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${date}/${service}/tc3_request\n${sha256hex(canonicalRequest)}`;
  const kDate = hmac('sha256', `TC3${secretKey}`, date);
  const kService = hmac('sha256', kDate, service);
  const kSigning = hmac('sha256', kService, 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const res = await fetch(`https://${host}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: host,
      'X-TC-Action': 'SubmitHunyuanImageJob',
      'X-TC-Version': version,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': process.env.TENCENT_REGION ?? 'ap-guangzhou',
      Authorization:
        `TC3-HMAC-SHA256 Credential=${secretId}/${date}/${service}/tc3_request, ` +
        `SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
    },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`混元生图接口返回 ${res.status}`);
  const json = (await res.json()) as {
    Response?: { JobId?: string; Error?: { Message?: string } };
  };
  const jobId = json.Response?.JobId;
  if (!jobId) throw new Error(json.Response?.Error?.Message ?? '混元生图任务提交失败');
  // 轮询取图（最多 60s）
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, 3000);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const pollRes = await fetch(`https://${host}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: host,
        'X-TC-Action': 'QueryHunyuanImageJob',
        'X-TC-Version': version,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': process.env.TENCENT_REGION ?? 'ap-guangzhou',
      },
      body: JSON.stringify({ JobId: jobId }),
      signal,
    });
    const poll = (await pollRes.json()) as {
      Response?: { Status?: string; ResultImage?: string[]; Error?: { Message?: string } };
    };
    const p = poll.Response ?? {};
    if (p.Status === 'done' && p.ResultImage?.length) {
      const bin = await fetch(p.ResultImage[0], { signal });
      const buf = Buffer.from(await bin.arrayBuffer());
      return { mime: bin.headers.get('content-type') ?? 'image/png', base64: buf.toString('base64') };
    }
    if (p.Status === 'failed') throw new Error(p.Error?.Message ?? '混元生图任务失败');
  }
  throw new Error('混元生图超时，请稍后重试');
}

export async function generateImages(req: ImageRequest): Promise<GeneratedImage[]> {
  validateImageRequest(req);
  const { executor, count: configuredCount } = imageGenConfig();
  if (!executor) throw new Error(imageGenGuide());
  if ((executor === 'openai-compatible' || executor === 'chugao') && !process.env.IMAGE_API_KEY?.trim()) {
    throw new Error('生图 API 尚未配置，请在服务端设置 IMAGE_API_KEY 后重启。');
  }
  const configuredTimeout = Number(process.env.IMAGE_API_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.floor(configuredTimeout)
    : DEFAULT_IMAGE_TIMEOUT_MS;
  const count = Math.min(6, Math.max(1, Number(req.count) || configuredCount));
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(req.signal?.reason);
  if (req.signal?.aborted) onParentAbort();
  else req.signal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Image request timed out', 'TimeoutError'));
  }, timeoutMs);
  const styles = SAMPLE_STYLES;
  const tasks: Promise<GeneratedImage>[] = [];
  for (let i = 0; i < count; i++) {
    const style = styles[i % styles.length];
    tasks.push(
      executor === 'hunyuan'
        ? generateHunyuan(req, style, controller.signal)
        : executor === 'chugao'
          ? generateChugao(req, style, controller.signal)
        : generateOpenAICompatible(req, style, controller.signal),
    );
  }
  // 采样：任一版失败不影响其余版本；全部失败才抛错。
  try {
    const settled = await Promise.allSettled(tasks);
    if (controller.signal.aborted) {
      if (timedOut) throw new Error('生图请求超时，请稍后重试。');
      throw new DOMException('生图请求已取消。', 'AbortError');
    }
    const firstFailure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (req.reference && firstFailure) {
      throw new Error(firstFailure.reason instanceof Error
        ? firstFailure.reason.message
        : '参考图处理失败，未生成结果。');
    }
    const images = settled
      .filter((r): r is PromiseFulfilledResult<GeneratedImage> => r.status === 'fulfilled')
      .map(r => r.value);
    if (!images.length) {
      throw new Error(firstFailure
        ? firstFailure.reason instanceof Error ? firstFailure.reason.message : String(firstFailure.reason)
        : '生图失败');
    }
    return images;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onParentAbort);
  }
}

/** 把上传照片落盘为参考图读取辅助（当前版本参考图直接 base64 传输，无需落盘）。 */
export async function readImageFile(path: string): Promise<{ mime: string; base64: string }> {
  const buf = await readFile(path);
  return { mime: 'image/png', base64: buf.toString('base64') };
}
