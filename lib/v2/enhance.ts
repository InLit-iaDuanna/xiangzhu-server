// 高清修复：在浏览器内对卫星/正射底图做轻量增强（缩放、锐化、去雾、对比度），
// 产出增强后的 JPEG dataURL。纯像素处理，无新增依赖；结果既用于显示，也可作为识别输入。
export type EnhanceLevel = 'none' | 'light' | 'strong';

export type EnhanceOptions = {
  level?: EnhanceLevel;
  /** 输出最长边像素；超过原图则不放大。默认 1600。 */
  maxSide?: number;
  /** JPEG 质量 0..1，默认 0.92。 */
  quality?: number;
  signal?: AbortSignal;
  onProgress?: (ratio: number, label: string) => void;
};

export type EnhanceResult = {
  dataUrl: string;
  /** 输出图像实际像素尺寸。 */
  size: { w: number; h: number };
  enhanced: boolean;
  elapsedMs: number;
};

export const enhanceLabels: Record<EnhanceLevel, string> = {
  none: '原图',
  light: '轻度',
  strong: '强化',
};

export class EnhanceAbortError extends Error {
  constructor() {
    super('已取消高清修复');
    this.name = 'EnhanceAbortError';
  }
}

export function isEnhanceAbort(error: unknown) {
  return error instanceof EnhanceAbortError;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new EnhanceAbortError();
}

// 加载图片为 HTMLImageElement（浏览器环境）。
function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('底图无法解码，请重新上传影像'));
    img.src = src;
  });
}

function nextFrame() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// 锐化：3×3 拉普拉斯/USM 近似，用局部均值增强边缘。核心卷积可复用，供纯逻辑测试。
export function sharpenKernel(amount: number) {
  // 中心 1+4a，四邻 -a（3×3 十字，避免对角过锐产生色噪）。
  const a = amount;
  return [
    0, -a, 0,
    -a, 1 + 4 * a, -a,
    0, -a, 0,
  ] as const;
}

// 在 RGBA 缓冲上做锐化 + 去雾 + 对比度/饱和度增强。
// 纯像素函数，不依赖 DOM，便于单元测试；浏览器入口是 enhanceImage。
export function enhancePixels(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  level: EnhanceLevel,
): Uint8ClampedArray {
  if (level === 'none' || w < 2 || h < 2) return data;
  const src = Uint8ClampedArray.from(data);
  const out = new Uint8ClampedArray(data.length);

  // 先做去雾 + 对比度 + 饱和度的逐像素线性增强，再叠加锐化（边缘）。
  const strength = level === 'strong' ? 1 : 0.55;
  // 去雾：拉伸全局亮度（去大气散射带来的发灰）。
  const dehaze = 0.06 * strength;
  const contrast = 1 + 0.12 * strength;
  const saturation = 1 + 0.08 * strength;

  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    let r = src[p];
    let g = src[p + 1];
    let b = src[p + 2];
    // 对比度：以 128 为轴拉伸。
    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;
    // 去雾：整体提亮。
    r += dehaze * 255;
    g += dehaze * 255;
    b += dehaze * 255;
    // 饱和度。
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    r = luma + (r - luma) * saturation;
    g = luma + (g - luma) * saturation;
    b = luma + (b - luma) * saturation;
    src[p] = r;
    src[p + 1] = g;
    src[p + 2] = b;
  }

  // 锐化：十字拉普拉斯。
  const amount = level === 'strong' ? 0.35 : 0.2;
  const center = 1 + 4 * amount;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = i * 4;
      const at = (ox: number, oy: number) => {
        const xx = Math.max(0, Math.min(w - 1, x + ox));
        const yy = Math.max(0, Math.min(h - 1, y + oy));
        return yy * w + xx;
      };
      const c = at(0, 0);
      const l = at(-1, 0);
      const rgt = at(1, 0);
      const u = at(0, -1);
      const d = at(0, 1);
      for (let k = 0; k < 3; k++) {
        const v =
          src[c * 4 + k] * center -
          amount * (src[l * 4 + k] + src[rgt * 4 + k] + src[u * 4 + k] + src[d * 4 + k]);
        out[p + k] = Math.max(0, Math.min(255, v));
      }
      out[p + 3] = 255;
    }
  }
  return out;
}

// 浏览器入口：解码 → 缩放 → 增强 → 输出 dataURL。
export async function enhanceImage(
  src: string,
  options: EnhanceOptions = {},
): Promise<EnhanceResult> {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const report = options.onProgress ?? (() => {});
  report(0.02, '读取底图');
  const img = await loadImage(src);
  throwIfAborted(options.signal);
  const level = options.level ?? 'light';
  const maxSide = options.maxSide ?? 1600;
  const quality = options.quality ?? 0.92;
  const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const w = Math.max(1, Math.round((img.naturalWidth || 0) * ratio));
  const h = Math.max(1, Math.round((img.naturalHeight || 0) * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前浏览器不支持影像增强，请更换浏览器后重试');
  report(0.3, '缩放影像');
  context.drawImage(img, 0, 0, w, h);
  throwIfAborted(options.signal);

  const imageData = context.getImageData(0, 0, w, h);
  report(0.55, '锐化与增强');
  await nextFrame();
  throwIfAborted(options.signal);
  imageData.data.set(enhancePixels(imageData.data, w, h, level));
  context.putImageData(imageData, 0, 0);
  report(0.8, '编码输出');
  await nextFrame();

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  report(1, '完成');
  return {
    dataUrl,
    size: { w, h },
    enhanced: level !== 'none',
    elapsedMs: Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
    ),
  };
}
