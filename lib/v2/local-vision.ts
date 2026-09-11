// 本机影像分析：不依赖业务服务与登录，直接在浏览器 Canvas 上按像素特征提取
// 候选道路中心线与建筑轮廓，输出与后端视觉模型一致的 BlueprintResult 契约，
// 因此候选项确认、尺度标定、路长路宽与仿真链路无需任何改动即可复用。
import { blueprintResult, type BlueprintResult } from './blueprint';

export type VisionSensitivity = 'conservative' | 'balanced' | 'eager';

export const sensitivityLabels: Record<VisionSensitivity, string> = {
  conservative: '保守',
  balanced: '均衡',
  eager: '灵敏',
};

export const sensitivityHints: Record<VisionSensitivity, string> = {
  conservative: '只保留清晰的路面与屋顶，漏检较多',
  balanced: '兼顾漏检与误检，适合多数正射影像',
  eager: '尽量找出所有可疑对象，误检需要人工删除',
};

export type LocalVisionSummary = {
  /** 实际参与分析的画布尺寸。 */
  analysis: { w: number; h: number };
  /** 植被、硬化路面、非植被建成面的像素占比，用于解释本次识别的依据。 */
  vegetationRatio: number;
  pavedRatio: number;
  builtRatio: number;
  roads: number;
  buildings: number;
  readable: boolean;
  sensitivity: VisionSensitivity;
  elapsedMs: number;
  notes: string[];
};

export type LocalVisionOutcome = {
  result: BlueprintResult;
  summary: LocalVisionSummary;
};

export type LocalVisionLayers = {
  paved: Uint8Array;
  roof: Uint8Array;
  road: Uint8Array;
  /** 细化后的道路骨架。 */
  skeleton: Uint8Array;
  /** 本次分析实际采用的阈值，便于人工核对识别偏好。 */
  thresholds: { brightness: number; smoothLimit: number; darkLimit: number; satMax: number };
};

export type LocalVisionOptions = {
  sensitivity?: VisionSensitivity;
  /** 分析画布最长边；越大越细但更慢。默认 520。 */
  maxSide?: number;
  signal?: AbortSignal;
  onProgress?: (ratio: number, label: string) => void;
  /** 调试钩子：导出中间掩膜，用于离线校核阈值，不参与候选生成。 */
  onLayers?: (layers: LocalVisionLayers) => void;
};

export class VisionAbortError extends Error {
  constructor() {
    super('已取消本机识别');
    this.name = 'VisionAbortError';
  }
}

export function isVisionAbort(error: unknown) {
  return error instanceof VisionAbortError;
}

const MAX_ROAD_POINTS = 24;
const MAX_ROAD_COUNT = 60;
const MAX_BUILDING_COUNT = 200;

type Preset = {
  /** 植被判定：过绿指数阈值，越大越不容易把浅绿色地表当植被。 */
  green: number;
  /** 路面判定：饱和度上限（灰白色系）。 */
  satMax: number;
  /** 路面判定：非植被亮度的分位点。 */
  brightQuantile: number;
  /** 路面判定：局部高频能量上限（越高越宽松）。 */
  smoothLimit: number;
  /** 屋顶判定：植被密度上限，避免树冠边缘被判成屋顶。 */
  vegDensityMax: number;
  /** 最短道路像素链长（分析画布像素）。 */
  minRoadPx: number;
  /** 最小路面厚度（分析画布像素）。 */
  minRoadWidth: number;
  /** 最小建筑像素面积。 */
  minBuildingPx: number;
  /** 建筑外接框填充率下限，用于剔除不规则碎斑。 */
  minFill: number;
};

// 三档灵敏度只是同一套阈值的松紧，避免出现「换算法」的错觉。
// 参考量级：混凝土路面高频能量约 4–6，瓦屋顶约 9–12，菜地约 12–16。
const presets: Record<VisionSensitivity, Preset> = {
  conservative: { green: 14, satMax: 0.16, brightQuantile: 0.52, smoothLimit: 6.5, vegDensityMax: 0.02, minRoadPx: 14, minRoadWidth: 3.2, minBuildingPx: 150, minFill: 0.5 },
  balanced: { green: 16, satMax: 0.2, brightQuantile: 0.45, smoothLimit: 8, vegDensityMax: 0.06, minRoadPx: 11, minRoadWidth: 2.6, minBuildingPx: 95, minFill: 0.42 },
  eager: { green: 18, satMax: 0.26, brightQuantile: 0.38, smoothLimit: 9.5, vegDensityMax: 0.12, minRoadPx: 8, minRoadWidth: 2, minBuildingPx: 60, minFill: 0.34 },
};

type Pt = { x: number; y: number };

type Component = {
  area: number;
  perimeter: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  pixels: number[];
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function nextFrame() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('底图无法解码，请重新上传影像'));
    image.src = src;
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new VisionAbortError();
}

// 可分离滑动窗口均值；边缘按夹取处理，用于纹理与平滑度估计。
function boxAverage(src: Float32Array, w: number, h: number, radius: number) {
  const win = radius * 2 + 1;
  const horizontal = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      horizontal[row + x] = sum / win;
      sum += src[row + Math.min(w - 1, Math.max(0, x + radius + 1))];
      sum -= src[row + Math.min(w - 1, Math.max(0, x - radius))];
    }
  }
  const out = new Float32Array(src.length);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += horizontal[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      sum += horizontal[Math.min(h - 1, Math.max(0, y + radius + 1)) * w + x];
      sum -= horizontal[Math.min(h - 1, Math.max(0, y - radius)) * w + x];
    }
  }
  return out;
}

// 二值掩膜的窗口计数，用于快速膨胀/腐蚀。
function windowCount(mask: Uint8Array, w: number, h: number, radius: number) {
  const win = radius * 2 + 1;
  const horizontal = new Float32Array(mask.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += mask[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      horizontal[row + x] = sum;
      sum += mask[row + Math.min(w - 1, Math.max(0, x + radius + 1))];
      sum -= mask[row + Math.min(w - 1, Math.max(0, x - radius))];
    }
  }
  const out = new Float32Array(mask.length);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += horizontal[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum;
      sum += horizontal[Math.min(h - 1, Math.max(0, y + radius + 1)) * w + x];
      sum -= horizontal[Math.min(h - 1, Math.max(0, y - radius)) * w + x];
    }
  }
  return { counts: out, win };
}

function dilate(mask: Uint8Array, w: number, h: number, radius: number) {
  if (radius <= 0) return Uint8Array.from(mask);
  const { counts } = windowCount(mask, w, h, radius);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = counts[i] > 0 ? 1 : 0;
  return out;
}

function erode(mask: Uint8Array, w: number, h: number, radius: number) {
  if (radius <= 0) return Uint8Array.from(mask);
  const { counts, win } = windowCount(mask, w, h, radius);
  const full = win * win;
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = counts[i] >= full - 0.5 ? 1 : 0;
  return out;
}

const closeMask = (mask: Uint8Array, w: number, h: number, r: number) => erode(dilate(mask, w, h, r), w, h, r);
const openMask = (mask: Uint8Array, w: number, h: number, r: number) => dilate(erode(mask, w, h, r), w, h, r);

// 多数投票平滑：像素化边界会让细化后的中轴长出大量锯齿分支，先磨平再抽骨架。
function smoothMask(mask: Uint8Array, w: number, h: number, radius: number, passes: number) {
  let current = mask;
  const win = radius * 2 + 1;
  const half = (win * win) / 2;
  for (let pass = 0; pass < passes; pass++) {
    const { counts } = windowCount(current, w, h, radius);
    const next = new Uint8Array(current.length);
    for (let i = 0; i < current.length; i++) next[i] = counts[i] > half ? 1 : 0;
    current = next;
  }
  return current;
}

function histogram(values: Float32Array, select: Uint8Array | null) {
  const bins = new Float64Array(256);
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (select && !select[i]) continue;
    bins[Math.max(0, Math.min(255, Math.round(values[i])))]++;
    count++;
  }
  return { bins, count };
}

function quantile(hist: { bins: Float64Array; count: number }, q: number) {
  if (!hist.count) return 0;
  const target = hist.count * q;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist.bins[i];
    if (acc >= target) return i;
  }
  return 255;
}

// 四邻接连通域标注：同时给出面积、周长与外接框，供形状分类使用。
function labelComponents(mask: Uint8Array, w: number, h: number, minArea: number) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const components: Component[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    const pixels: number[] = [];
    let minX = w, maxX = -1, minY = h, maxY = -1, perimeter = 0;
    while (top) {
      const index = stack[--top];
      pixels.push(index);
      const x = index % w;
      const y = (index - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const visit = (next: number) => {
        if (!mask[next]) {
          perimeter++;
          return;
        }
        if (!seen[next]) {
          seen[next] = 1;
          stack[top++] = next;
        }
      };
      if (x > 0) visit(index - 1);
      else perimeter++;
      if (x < w - 1) visit(index + 1);
      else perimeter++;
      if (y > 0) visit(index - w);
      else perimeter++;
      if (y < h - 1) visit(index + w);
      else perimeter++;
    }
    if (pixels.length < minArea) continue;
    components.push({ area: pixels.length, perimeter: Math.max(1, perimeter), minX, maxX, minY, maxY, pixels });
  }
  return components;
}

// 倒角距离变换：路面骨架上的取值即为局部半宽。
function distanceTransform(mask: Uint8Array, w: number, h: number) {
  const far = 1e6;
  const d = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) d[i] = mask[i] ? far : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y > 0) best = Math.min(best, d[i - w] + 1);
      if (x > 0) best = Math.min(best, d[i - 1] + 1);
      if (x > 0 && y > 0) best = Math.min(best, d[i - w - 1] + 1.414);
      if (x < w - 1 && y > 0) best = Math.min(best, d[i - w + 1] + 1.414);
      d[i] = best;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y < h - 1) best = Math.min(best, d[i + w] + 1);
      if (x < w - 1) best = Math.min(best, d[i + 1] + 1);
      if (x < w - 1 && y < h - 1) best = Math.min(best, d[i + w + 1] + 1.414);
      if (x > 0 && y < h - 1) best = Math.min(best, d[i + w - 1] + 1.414);
      d[i] = best;
    }
  }
  return d;
}

const neighbours: [number, number][] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

// Zhang-Suen 细化的一轮（两个子迭代），返回被删除的像素数。
function thinRound(mask: Uint8Array, w: number, h: number) {
  let removed = 0;
  const pending: number[] = [];
  for (let step = 0; step < 2; step++) {
    pending.length = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const p2 = mask[i - w];
        const p3 = mask[i - w + 1];
        const p4 = mask[i + 1];
        const p5 = mask[i + w + 1];
        const p6 = mask[i + w];
        const p7 = mask[i + w - 1];
        const p8 = mask[i - 1];
        const p9 = mask[i - w - 1];
        const ring = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
        let occupied = 0;
        let transitions = 0;
        for (let k = 0; k < 8; k++) {
          occupied += ring[k];
          if (ring[k] === 0 && ring[k + 1] === 1) transitions++;
        }
        if (occupied < 2 || occupied > 6 || transitions !== 1) continue;
        if (step === 0) {
          if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
        } else if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
        pending.push(i);
      }
    }
    if (!pending.length) break;
    for (const i of pending) mask[i] = 0;
    removed += pending.length;
  }
  return removed;
}

// 剪除毛刺：细化后的骨架在粗糙边缘上会生出大量短枝，使主干被切碎成小段。
// 从所有端点向内收缩若干轮，短枝整体消失，主干只损失末端几像素。
export function pruneSkeleton(skeleton: Uint8Array, w: number, h: number, rounds: number) {
  for (let round = 0; round < rounds; round++) {
    const remove: number[] = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!skeleton[i]) continue;
        let occupied = 0;
        for (const [dy, dx] of neighbours) occupied += skeleton[i + dy * w + dx];
        if (occupied <= 1) remove.push(i);
      }
    }
    if (!remove.length) break;
    for (const i of remove) skeleton[i] = 0;
  }
}

// 骨架遍历：以度数 != 2 的像素为顶点，把骨架拆成折线。
// neighbours 的顺序左右对称，因此反向边走 index 7-k 的槽位。
// 导出以便单元测试与离线校核。
export function traceSkeleton(skeleton: Uint8Array, w: number, h: number) {
  for (let x = 0; x < w; x++) {
    skeleton[x] = 0;
    skeleton[(h - 1) * w + x] = 0;
  }
  for (let y = 0; y < h; y++) {
    skeleton[y * w] = 0;
    skeleton[y * w + w - 1] = 0;
  }
  const degree = new Uint8Array(skeleton.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!skeleton[i]) continue;
      let count = 0;
      for (const [dy, dx] of neighbours) if (skeleton[i + dy * w + dx]) count++;
      degree[i] = count;
    }
  }
  const used = new Uint8Array(skeleton.length * 8);
  const chains: Pt[][] = [];
  const point = (index: number): Pt => ({ x: index % w, y: Math.floor(index / w) });
  const walk = (start: number, firstStep: number) => {
    const path: Pt[] = [point(start)];
    let current = start + neighbours[firstStep][0] * w + neighbours[firstStep][1];
    used[start * 8 + firstStep] = 1;
    used[current * 8 + (7 - firstStep)] = 1;
    while (true) {
      path.push(point(current));
      if (degree[current] !== 2) break;
      let step = -1;
      for (let k = 0; k < 8; k++) {
        const next = current + neighbours[k][0] * w + neighbours[k][1];
        if (!skeleton[next] || used[current * 8 + k]) continue;
        step = k;
        break;
      }
      if (step < 0) break;
      const next = current + neighbours[step][0] * w + neighbours[step][1];
      used[current * 8 + step] = 1;
      used[next * 8 + (7 - step)] = 1;
      current = next;
    }
    if (path.length >= 2) chains.push(path);
  };
  for (let i = 0; i < skeleton.length; i++) {
    if (!skeleton[i] || degree[i] === 2) continue;
    for (let k = 0; k < 8; k++) {
      const next = i + neighbours[k][0] * w + neighbours[k][1];
      if (!skeleton[next] || used[i * 8 + k]) continue;
      walk(i, k);
    }
  }
  // 闭合环路（全为度 2 的像素）单独收尾。
  for (let i = 0; i < skeleton.length; i++) {
    if (!skeleton[i] || degree[i] !== 2) continue;
    for (let k = 0; k < 8; k++) {
      if (used[i * 8 + k] || !skeleton[i + neighbours[k][0] * w + neighbours[k][1]]) continue;
      walk(i, k);
      break;
    }
  }
  return chains;
}

function polylineLength(points: Pt[]) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

// Douglas-Peucker 抽稀，并按上限逐步放宽容差，保证不超过视觉契约的点数上限。
function simplify(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    if (end - start < 2) continue;
    const a = points[start];
    const b = points[end];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const norm = Math.hypot(dx, dy) || 1;
    let best = -1;
    let bestDistance = tolerance;
    for (let i = start + 1; i < end; i++) {
      const d = Math.abs(dy * (points[i].x - a.x) - dx * (points[i].y - a.y)) / norm;
      if (d > bestDistance) {
        best = i;
        bestDistance = d;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([start, best], [best, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function simplifyToLimit(points: Pt[], limit: number) {
  let tolerance = 1.2;
  let current = simplify(points, tolerance);
  while (current.length > limit && tolerance < 40) {
    tolerance *= 1.4;
    current = simplify(points, tolerance);
  }
  return current;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// 浏览器入口：解码底图 → 缩放到分析画布 → 交给纯像素流水线。
export async function recognizeLocally(image: string, options: LocalVisionOptions = {}): Promise<LocalVisionOutcome> {
  const report = options.onProgress ?? (() => {});
  report(0.02, '读取底图');
  const bitmap = await loadImage(image);
  throwIfAborted(options.signal);
  const maxSide = options.maxSide ?? 520;
  const ratio = Math.min(1, maxSide / Math.max(bitmap.naturalWidth || 1, bitmap.naturalHeight || 1));
  const w = Math.max(48, Math.round((bitmap.naturalWidth || 480) * ratio));
  const h = Math.max(48, Math.round((bitmap.naturalHeight || 320) * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前浏览器不支持影像分析，请更换浏览器后重试');
  context.drawImage(bitmap, 0, 0, w, h);
  const pixels = context.getImageData(0, 0, w, h).data;
  return analyzePixels(pixels, w, h, options);
}

// 纯像素流水线：输入 RGBA 缓冲即可运行，不依赖 DOM，便于离线校核与回归。
export async function analyzePixels(
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
  options: LocalVisionOptions = {},
): Promise<LocalVisionOutcome> {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const preset = presets[options.sensitivity ?? 'balanced'];
  const report = options.onProgress ?? (() => {});
  const signal = options.signal;
  const abort = () => throwIfAborted(signal);
  const total = w * h;

  report(0.16, '计算色彩与绿度');
  await nextFrame();
  const luma = new Float32Array(total);
  const saturation = new Float32Array(total);
  const vegetation = new Uint8Array(total);
  let vegetationCount = 0;
  for (let i = 0; i < total; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    saturation[i] = max > 0 ? (max - min) / max : 0;
    // 过绿指数 + 通道比较：树冠、菜地、草地等植被不参与建成面判定。
    if (2 * g - r - b > preset.green || (g > r + 12 && g > b + 12)) {
      vegetation[i] = 1;
      vegetationCount++;
    }
  }
  abort();

  report(0.32, '估计表面纹理');
  await nextFrame();
  // 高频能量：路面（混凝土）明显低于瓦屋顶与耕作地表，是区分二者的主特征。
  const smoothBase = boxAverage(luma, w, h, 2);
  const detail = new Float32Array(total);
  for (let i = 0; i < total; i++) detail[i] = Math.abs(luma[i] - smoothBase[i]);
  const texture = boxAverage(detail, w, h, 1);
  const vegetationFloat = new Float32Array(total);
  for (let i = 0; i < total; i++) vegetationFloat[i] = vegetation[i];
  // 植被密度：树冠边缘的高频不应被当成屋顶纹理。
  const vegetationDensity = boxAverage(vegetationFloat, w, h, 4);
  const noVegetation = new Uint8Array(total);
  for (let i = 0; i < total; i++) noVegetation[i] = vegetation[i] ? 0 : 1;
  const brightness = quantile(histogram(luma, noVegetation), preset.brightQuantile);
  // 平滑阈值取「灵敏度上限」与「影像自身分位」的较小值，避免全屏噪声影像过度判定。
  const smoothLimit = Math.min(preset.smoothLimit, Math.max(4.5, quantile(histogram(texture, noVegetation), 0.35)));
  const vegetationRatio = vegetationCount / total;
  const darkLimit = Math.max(28, brightness * 0.4);

  report(0.46, '分离路面与屋顶');
  await nextFrame();
  const hard = new Uint8Array(total);
  const roof = new Uint8Array(total);
  let pavedCount = 0;
  let builtCount = 0;
  for (let i = 0; i < total; i++) {
    if (vegetation[i] || luma[i] < darkLimit) continue;
    builtCount++;
    // 明亮、低饱和、较平滑：混凝土路面、硬化场地与浅色屋顶。像素级无法区分二者，
    // 因此只作为「硬化面」候选，真正的道路/建筑之分交给形态分析。
    if (saturation[i] <= preset.satMax && texture[i] <= smoothLimit * 1.6 && luma[i] >= brightness) {
      hard[i] = 1;
      pavedCount++;
      continue;
    }
    // 屋顶：远离植被边界的有纹理面，或蓝色系彩钢屋面。
    if (vegetationDensity[i] > preset.vegDensityMax) continue;
    const textured = texture[i] > smoothLimit * 1.15;
    const metal = saturation[i] > 0.25 && pixels[i * 4 + 2] > pixels[i * 4] - 8;
    if (textured || metal) roof[i] = 1;
  }
  // 檐口阴影与树影把路面和屋面连成一片，先闭合补齐阴影缝隙，再腐蚀断开粘连。
  const hardClosed = closeMask(hard, w, h, 2);
  const hardParts = labelComponents(erode(hardClosed, w, h, 2), w, h, 18);
  const roofMask = closeMask(roof, w, h, 2);
  abort();

  report(0.55, '提取道路骨架');
  await nextFrame();
  const maxBuildingArea = total * 0.025;
  const roadMask = new Uint8Array(total);
  const compactHard: Component[] = [];
  // 按形态把硬化面拆成「走廊（道路）」与「块状（建筑/场地）」。
  for (const part of hardParts) {
    const boxW = part.maxX - part.minX + 1;
    const boxH = part.maxY - part.minY + 1;
    const thickness = (2 * part.area) / part.perimeter;
    const elongation = Math.max(boxW, boxH) / Math.max(1, thickness);
    const fill = part.area / (boxW * boxH);
    if (thickness >= preset.minRoadWidth && elongation >= 2.6) {
      // 腐蚀后回胀，恢复真实路幅（限制在闭合掩膜内，避免糊到邻近屋面）。
      for (const index of part.pixels) {
        const x = index % w;
        const y = (index - x) / w;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const next = ny * w + nx;
            if (hardClosed[next]) roadMask[next] = 1;
          }
        }
      }
      continue;
    }
    if (part.area <= total * 0.006 && elongation < 2.6 && fill >= preset.minFill * 0.85) compactHard.push(part);
  }
  const distance = distanceTransform(roadMask, w, h);
  // 先磨平再细化：否则锯齿边界会让骨架碎成上百段短折线。
  const smoothedRoad = smoothMask(roadMask, w, h, 1, 2);
  const skeleton = Uint8Array.from(smoothedRoad);
  for (let round = 0; round < 48; round++) {
    const removed = thinRound(skeleton, w, h);
    if (round % 4 === 0) {
      report(0.55 + Math.min(0.25, round / 160), '提取道路骨架');
      await nextFrame();
      abort();
    }
    if (!removed) break;
  }
  pruneSkeleton(skeleton, w, h, Math.max(3, Math.round(preset.minRoadPx / 2)));
  options.onLayers?.({ paved: hard, roof: roofMask, road: roadMask, skeleton, thresholds: { brightness, smoothLimit, darkLimit, satMax: preset.satMax } });
  const chains = traceSkeleton(skeleton, w, h);

  const traced: { road: BlueprintResult['roads'][number]; lengthPx: number }[] = [];
  for (const chain of chains) {
    const lengthPx = polylineLength(chain);
    if (lengthPx < preset.minRoadPx) continue;
    const widthPx = median(chain.map((p) => distance[p.y * w + p.x] * 2));
    if (widthPx < preset.minRoadWidth) continue;
    const simplifiedPts = simplifyToLimit(chain, MAX_ROAD_POINTS);
    if (simplifiedPts.length < 2) continue;
    const coverage = lengthPx / w;
    traced.push({
      lengthPx,
      road: {
        points: simplifiedPts.map((p) => ({ x: clamp01(p.x / (w - 1)), y: clamp01(p.y / (h - 1)) })),
        width: clamp01(widthPx / w),
        confidence: coverage >= 0.06 && widthPx >= 4 ? 'high' : coverage >= 0.025 && widthPx >= 3 ? 'medium' : 'low',
      },
    });
  }
  // 主干优先：超出上限时保留最长的候选，而不是按遍历顺序截断。
  traced.sort((a, b) => b.lengthPx - a.lengthPx);
  const roads: BlueprintResult['roads'] = traced.slice(0, MAX_ROAD_COUNT).map((item) => item.road);

  report(0.82, '提取建筑轮廓');
  await nextFrame();
  abort();
  const buildings: BlueprintResult['buildings'] = [];
  const pushBuilding = (component: Component, maxAspect: number, maxArea: number, expand = 0) => {
    if (buildings.length >= MAX_BUILDING_COUNT) return;
    // 硬化面经过腐蚀拆分，外接框需要回胀以还原真实轮廓。
    const boxW = component.maxX - component.minX + 1 + expand * 2;
    const boxH = component.maxY - component.minY + 1 + expand * 2;
    if (component.area > maxArea) return;
    // 屋顶近似矩形：外接框填充率与长宽比即可过滤掉成片的田地与不规则碎斑。
    const fill = component.area / (boxW * boxH);
    if (fill < preset.minFill) return;
    const aspect = Math.max(boxW, boxH) / Math.max(1, Math.min(boxW, boxH));
    if (aspect > maxAspect) return;
    // 与已收录轮廓高度重合的碎斑（屋脊、天窗把屋顶切碎）直接丢弃。
    const x = (component.minX + component.maxX) / 2 / w;
    const y = (component.minY + component.maxY) / 2 / h;
    const bw = boxW / w;
    const bh = boxH / h;
    const duplicated = buildings.some((b) => {
      const overlapX = Math.min(x + bw / 2, b.x + b.w / 2) - Math.max(x - bw / 2, b.x - b.w / 2);
      const overlapY = Math.min(y + bh / 2, b.y + b.h / 2) - Math.max(y - bh / 2, b.y - b.h / 2);
      if (overlapX <= 0 || overlapY <= 0) return false;
      return (overlapX * overlapY) / Math.min(bw * bh, b.w * b.h) > 0.5;
    });
    if (duplicated) return;
    buildings.push({
      x: clamp01(x),
      y: clamp01(y),
      w: clamp01(bw),
      h: clamp01(bh),
      confidence: component.area >= 320 && fill >= 0.6 && aspect <= 1.9 ? 'high' : component.area >= 130 ? 'medium' : 'low',
    });
  };
  const roofComponents = labelComponents(roofMask, w, h, preset.minBuildingPx).sort((a, b) => b.area - a.area);
  for (const component of roofComponents) pushBuilding(component, 3.2, maxBuildingArea);
  for (const component of compactHard.sort((a, b) => b.area - a.area)) pushBuilding(component, 2.4, total * 0.006, 2);

  const pavedRatio = pavedCount / total;
  const notes: string[] = [];
  const empty = roads.length === 0 && buildings.length === 0;
  const readable = !empty && vegetationRatio < 0.995 && builtCount / total > 0.01;
  if (!readable) notes.push('影像中未找到可判读的建成面，请确认上传的是俯视正射影像，或提高识别灵敏度后重试。');
  else {
    notes.push('道路依据路面明度与平滑度提取；树冠、屋檐遮挡处会断开，需要手动补画。');
    notes.push('颜色接近路面的屋顶可能被并入道路，请以地图上的候选结果为准逐条确认或删除。');
    if (roads.some((r) => r.confidence === 'low') || buildings.some((b) => b.confidence === 'low')) notes.push('标注「低置信」的对象最容易误判，建议优先现场核对。');
    notes.push('本机分析只给出二维几何，路长路宽需标定尺度后再估算。');
  }
  const result: BlueprintResult = {
    image_readable: readable,
    summary: readable
      ? `本机影像分析：植被约 ${Math.round(vegetationRatio * 100)}%，硬化面约 ${Math.round(pavedRatio * 100)}%；提取候选道路 ${roads.length} 段、候选建筑 ${buildings.length} 处。`
      : '本机影像分析未能判读该影像的道路与建筑。',
    roads,
    buildings,
    missing_fields: notes.slice(0, 8),
  };
  const parsed = blueprintResult.safeParse(result);
  if (!parsed.success) throw new Error('本机识别结果超出契约范围，请降低灵敏度后重试');

  report(1, '整理候选');
  const summary: LocalVisionSummary = {
    analysis: { w, h },
    vegetationRatio,
    pavedRatio,
    builtRatio: builtCount / total,
    roads: roads.length,
    buildings: buildings.length,
    readable,
    sensitivity: options.sensitivity ?? 'balanced',
    elapsedMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started),
    notes,
  };
  return { result: parsed.data, summary };
}
