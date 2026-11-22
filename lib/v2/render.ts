// AI 效果图前端客户端：多版采样生成（未配置生图模型时返回配置指引）。
export type EffectRenderResult =
  | { ok: true; images: { mime: string; dataUrl: string }[] }
  | { ok: false; reason: 'unconfigured'; guide: string }
  | { ok: false; reason: 'error'; message: string };

export async function requestEffectImages(options: {
  photos: string[];
  goal: string;
  preserve?: string;
  budget?: string;
  layoutKinds?: string[];
  count?: number;
  signal?: AbortSignal;
}): Promise<EffectRenderResult> {
  const photos = options.photos.slice(0, 3).map(src => {
    const idx = src.indexOf(',');
    return {
      mime: src.startsWith('data:') ? src.slice(5, src.indexOf(';')) || 'image/png' : 'image/png',
      base64: idx >= 0 ? src.slice(idx + 1) : src,
    };
  });
  const prompt = [
    `为乡村适老化改造生成概念效果图。设计目标：${options.goal || '提升老年人日常通行与停留的安全和舒适'}`,
    options.preserve ? `须保留：${options.preserve}` : '',
    options.budget ? `预算档位：${options.budget}` : '',
    options.layoutKinds?.length ? `拟新增设施：${options.layoutKinds.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('。');
  try {
    const res = await fetch('/api/v1/assistant/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photos, prompt, count: options.count ?? 4 }),
      signal: options.signal,
    });
    const json = (await res.json()) as {
      configured?: boolean;
      guide?: string;
      images?: { mime: string; base64: string }[];
      error?: string;
    };
    if (json.configured === false)
      return { ok: false, reason: 'unconfigured', guide: json.guide ?? '' };
    if (!res.ok || !json.images?.length)
      return { ok: false, reason: 'error', message: json.error ?? `生成失败（HTTP ${res.status}）` };
    return {
      ok: true,
      images: json.images.map(im => ({
        mime: im.mime,
        dataUrl: `data:${im.mime};base64,${im.base64}`,
      })),
    };
  } catch (e) {
    return {
      ok: false,
      reason: 'error',
      message: e instanceof Error ? e.message : '网络异常，请稍后重试',
    };
  }
}
