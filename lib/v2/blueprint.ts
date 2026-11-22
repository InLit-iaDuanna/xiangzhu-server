import { z } from 'zod';
import {
  IMAGE_WIDTH,
  imageBasis,
  distance,
  type Node,
  type Point,
  type Road,
  type Spatial,
} from '../spatial';

type Basis = { w: number; h: number };

// 视觉识别输出契约。坐标一律使用 0..1 归一化值，避免模型直接产出像素网格带来的漂移。
const unit = z.number().min(0).max(1);
const confidence = z.enum(['high', 'medium', 'low']);

export const blueprintResult = z.object({
  image_readable: z
    .boolean()
    .describe('是否实际看到了影像内容；影像被过滤、空白或不可读时必须为 false'),
  summary: z.string().max(600).describe('一句话说明影像类型与可辨识程度'),
  roads: z
    .array(
      z.object({
        points: z
          .array(z.object({ x: unit, y: unit }))
          .min(2)
          .max(24)
          .describe('道路中心线折线顶点，按行进顺序排列'),
        width: z
          .number()
          .min(0)
          .max(1)
          .nullable()
          .describe('可见路面宽度占图像宽度的比例；无法判断时为 null'),
        confidence,
      }),
    )
    .max(60),
  buildings: z
    .array(
      z.object({
        x: unit.describe('建筑中心横坐标'),
        y: unit.describe('建筑中心纵坐标'),
        w: z.number().min(0).max(1).describe('建筑外接宽度占图像宽度比例'),
        h: z.number().min(0).max(1).describe('建筑外接高度占图像高度比例'),
        confidence,
      }),
    )
    .max(200)
    .default([])
    .describe('本流程仅识别道路，建筑字段恒为空数组'),
  missing_fields: z.array(z.string().max(200)).max(8),
});
export type BlueprintResult = z.infer<typeof blueprintResult>;

export const blueprintInstruction = [
  '分析这张乡村正射/卫星俯视影像，只提取道路中心线，用于后续人工校正与路线标注。',
  '',
  '【目标场景特征（参考）】',
  '这是中国北方密集型村庄的典型正射俯视影像：成排成列的红瓦/蓝瓦顶房屋紧密排列，每两排房屋之间必有硬化巷道，房屋排东西向/南北向成行；外环通常有连接主路贯穿村庄；巷道最窄处也有 1-2 米，但仍要识别为路。请按这种"密集网格 + 外环主路"的特征充分识别。',
  '若影像属于空旷田野、稀疏散居或非密集村庄，按实际路网密度输出即可。',
  '',
  '【什么才算道路（必须同时满足）】',
  '1. 有连续的硬质铺装或压实路面（水泥、沥青、硬化土路、夯土路），颜色/纹理与两侧地表明显不同；',
  '2. 呈连贯的带状延伸，宽度沿途基本一致，两侧有可辨识的平行边界（路缘石、沟渠、建筑让出的通道、田埂挡墙）；',
  '3. 与其他道路相连或通向村口/建筑入口，是真实可通行的路径。',
  '即便最窄仅 1-2 米的巷道，只要满足以上三条就视为道路，必须输出。',
  '',
  '【这些绝对不是道路，一律不输出】',
  '- 农田里的田垄、犁沟、地界（成组平行细线、出现在大片整齐田块中）；',
  '- 建筑屋顶（包括长条形厂房/畜棚屋顶）与院墙、围墙、院户边界线；',
  '- 水渠、田埂、排水沟的边线；',
  '- 树冠、屋檐、电线杆、烟囱阴影投下的线；',
  '- 晒场、空地、菜园、鱼塘的边界；围栏、绿篱、栅栏。',
  '判别技巧：先看这条"线"两端是否连接到确定的路口或建筑入口；再看它的两侧是否是可耕种/可建设的地表。若两端悬空在农田或场地中间，它大概率不是路。',
  '',
  '【输出数量与覆盖（密集村庄）】',
  '1. 外环主路（贯穿村或贴村外侧、最宽最连续）：至少 1-2 条，必须完整从一端画到另一端；',
  '2. 村庄内部主街（横穿或纵穿村庄、把村庄分块）：按实际绘制；',
  '3. 建筑排之间的所有窄巷（即便很窄）：每个建筑排列之间画一条贯穿巷；',
  '4. 死胡同/丁字路/院落通巷：遇到尽头要收尾于建筑入口，不要延伸到建筑里。',
  '小村庄（< 30 户）通常也有 6-15 条道路，输出条数应与影像实际路网密度相当，宁可多画窄巷也不要漏。',
  '',
  '【位置精度（最重要）】每条折线的顶点必须落在该道路可见路面的正中心（不是路边、不是路缘、不偏不倚的中心线）；路口处两条折线必须共享同一交点顶点。宁可少画，不可画偏。',
  '每条道路必须完整：从可见范围的一端画到另一端（延伸至影像边界、村口或与其他道路的交汇处），不要只画中间一小段。',
  '避免碎片化：一条连续道路只输出一条折线，不要拆成多段短折线；折线顶点按行进顺序排列，直线段只需端点，转弯处与十字/丁字路口处必须加顶点（每条最多 24 个顶点）。',
  '只输出影像中实际可见的道路，不推测被树冠、屋檐、阴影遮挡的路段；院落内部连接、疑似穿越建筑的路径不要给出。',
  '所有坐标必须归一化到 0..1：x 除以影像宽度，y 除以影像高度，保留 3 位小数。',
  '宽度同样使用比例值（路面宽度 ÷ 影像宽度）；无法判断时填 null，不要猜测。',
  '置信度依据影像清晰度与遮挡程度判断；不确定时降低置信度而不是省略道路。',
  'buildings 字段恒返回空数组 []。',
  '若影像不可读或不是俯视影像，令 image_readable 为 false 并在 missing_fields 说明原因。',
].join('\n');

export type BlueprintRoad = BlueprintResult['roads'][number];
export type BlueprintBuilding = BlueprintResult['buildings'][number];

const SNAP_TOLERANCE = 14;

function toImage(p: Point, basis: Basis): Point {
  return { x: p.x * basis.w, y: p.y * basis.h };
}

function clampImage(p: Point, basis: Basis): Point {
  return {
    x: Math.max(0, Math.min(basis.w, p.x)),
    y: Math.max(0, Math.min(basis.h, p.y)),
  };
}

// 网格哈希，把节点吸附从 O(n²) 降到近似 O(n)。
class NodeIndex {
  private grid = new Map<string, string[]>();
  constructor(private nodes: Node[]) {
    nodes.forEach((n) => this.add(n));
  }
  private key(x: number, y: number) {
    return `${Math.floor(x / SNAP_TOLERANCE)}:${Math.floor(y / SNAP_TOLERANCE)}`;
  }
  add(node: Node) {
    const k = this.key(node.x, node.y);
    const list = this.grid.get(k);
    if (list) list.push(node.id);
    else this.grid.set(k, [node.id]);
  }
  nearest(p: Point): Node | null {
    const gx = Math.floor(p.x / SNAP_TOLERANCE),
      gy = Math.floor(p.y / SNAP_TOLERANCE);
    let best: Node | null = null,
      bestDistance = SNAP_TOLERANCE;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of this.grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
          const node = this.nodes.find((n) => n.id === id)!;
          const d = distance(node, p);
          if (d <= bestDistance) {
            best = node;
            bestDistance = d;
          }
        }
      }
    return best;
  }
}

function nextSequence(ids: Iterable<string>, prefix: string) {
  let max = 0;
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return () => `${prefix}-${String(++max).padStart(2, '0')}`;
}

export type BlueprintSummary = {
  roads: number;
  buildings: number;
  nodes: number;
  removedCandidates: number;
  lowConfidence: number;
  /** 与现有路网重复而跳过的段数，避免重复识别产生叠加线段。 */
  skipped: number;
};

// 道路宽度（米）= 可见宽度占影像宽度比例 × 影像宽度 × 尺度。尺度未知时保持 null，不做伪精确换算。
function widthFromRatio(width: number | null, scale: number) {
  if (width === null || !(scale > 0)) return null;
  return Math.round(width * IMAGE_WIDTH * scale * 10) / 10;
}

// 尺度标定后重算候选道路宽度，不改变几何与编号。
export function applyScale(base: Spatial, scale: number): Spatial {
  return {
    ...base,
    scale,
    calibration: {
      status: 'manual',
      source: '由研究范围面积或影像宽度标定',
      unit: 'm',
      scaleY: base.calibration?.scaleY,
    },
    roads: base.roads.map((r) =>
      typeof r.width_n === 'number'
        ? { ...r, width: widthFromRatio(r.width_n, scale) }
        : r,
    ),
  };
}

// 链式合并：识别折线被拆成「一段一直线」后，把彼此共线连续的路段合并回一条完整道路，
// 使一条巷道/主路只占一个编号（与人工标注习惯一致），减少杂乱短段。
// 规则：路口处直线延续则直穿合并（主路横穿巷道不断开）；转折 >18° 即断开保留折线形状；
// 闭环（环村路）合并会退化为弦，回退为原始分段。
const STRAIGHT_COS = Math.cos((18 * Math.PI) / 180);

function mergeChains(segments: Road[], nodeById: Map<string, Node>): Road[] {
  if (segments.length < 2) return segments;
  const adjacency = new Map<string, { road: Road; other: string }[]>();
  for (const r of segments) {
    adjacency.set(r.a, [...(adjacency.get(r.a) ?? []), { road: r, other: r.b }]);
    adjacency.set(r.b, [...(adjacency.get(r.b) ?? []), { road: r, other: r.a }]);
  }
  const used = new Set<string>();
  // 从 from→at 方向出发，沿「直线延续」一路行走；只选择共线（夹角 ≤18°）的后续路段。
  const walkDir = (from: string, at: string): { roads: Road[]; end: string } => {
    const roads: Road[] = [];
    for (;;) {
      const nxt = (adjacency.get(at) ?? []).find((e) => {
        if (used.has(e.road.id)) return false;
        const a = nodeById.get(from), m = nodeById.get(at), b = nodeById.get(e.other);
        if (!a || !m || !b) return false;
        const v1 = { x: m.x - a.x, y: m.y - a.y }, v2 = { x: b.x - m.x, y: b.y - m.y };
        const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
        if (!l1 || !l2) return true;
        return (v1.x * v2.x + v1.y * v2.y) / (l1 * l2) >= STRAIGHT_COS;
      });
      if (!nxt) break;
      used.add(nxt.road.id);
      roads.push(nxt.road);
      from = at;
      at = nxt.other;
    }
    return { roads, end: at };
  };
  const chains: Road[] = [];
  for (const r of segments) {
    if (used.has(r.id)) continue;
    used.add(r.id);
    const sideA = walkDir(r.b, r.a);
    const sideB = walkDir(r.a, r.b);
    const chain = [...sideA.roads].reverse();
    chain.push(r);
    chain.push(...sideB.roads);
    if (sideA.end !== sideB.end) {
      chains.push({ ...r, a: sideA.end, b: sideB.end });
    } else {
      chains.push(...chain);
    }
  }
  // 按几何长度降序编号：最长道路（通常是主路）排 R-01。
  const lengthOf = (r: Road) => {
    const a = nodeById.get(r.a), b = nodeById.get(r.b);
    return a && b ? distance(a, b) : 0;
  };
  chains.sort((x, y) => lengthOf(y) - lengthOf(x));
  return chains;
}

// 把一次视觉识别的归一化几何合并进场景：
// 1. 清空上一轮候选（保留用户已确认的道路与建筑）
// 2. 折线拆分为既有「两节点一段直线」结构，供路径与仿真引擎直接复用
// 3. 道路自动编号 R-01…，建筑标记为候选，等待用户逐条校正
export function applyBlueprint(
  base: Spatial,
  result: BlueprintResult,
  scale: number,
  meta: { model: string; materialId?: string; time?: string } = { model: '' },
): { spatial: Spatial; summary: BlueprintSummary } {
  // 归一化坐标按项目底图的真实比例展开；旧项目无 imageSize 时回落 3:2，行为不变。
  const basis = imageBasis(base);
  const removals = new Set(
    base.roads.filter((r) => r.status === 'candidate').map((r) => r.id),
  );
  const prunedSpatial: Spatial = {
    ...base,
    roads: base.roads.filter((r) => !removals.has(r.id)),
  };
  // 只保留仍被引用的节点；上一轮识别产生且已无人引用的节点一并清除。
  const referenced = new Set<string>();
  prunedSpatial.roads.forEach((r) => {
    referenced.add(r.a);
    referenced.add(r.b);
  });
  const nodes = prunedSpatial.nodes.filter(
    (n) => referenced.has(n.id) || !n.name.startsWith('识别节点'),
  );
  const index = new NodeIndex(nodes);
  const roads: Road[] = [];
  const roadId = nextSequence(
    base.roads.map((r) => r.id),
    'R',
  );
  const nodeId = nextSequence(
    base.nodes.map((n) => n.id).filter((id) => /^N-\d+$/.test(id)),
    'N',
  );
  let lowConfidence = 0;
  const point = (p: Point) => {
    const image = clampImage(toImage(p, basis), basis);
    const snapped = index.nearest(image);
    if (snapped) return snapped;
    const node: Node = {
      id: nodeId(),
      name: `识别节点 ${nodes.length + 1}`,
      ...image,
    };
    nodes.push(node);
    index.add(node);
    return node;
  };
  const seen = new Set<string>();
  let skipped = 0;
  for (const line of result.roads) {
    if (line.confidence === 'low') lowConfidence++;
    for (let i = 1; i < line.points.length; i++) {
      const a = point(line.points[i - 1]),
        b = point(line.points[i]);
      if (a.id === b.id) continue;
      const key = [a.id, b.id].sort().join('|');
      if (
        seen.has(key) ||
        base.roads.some(
          (r) =>
            (r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id),
        )
      ) {
        skipped++;
        continue;
      }
      seen.add(key);
      roads.push({
        id: roadId(),
        a: a.id,
        b: b.id,
        width: null,
        source: 'AI 影像识别（候选）',
        access: '未知',
        confirmed: false,
        steps: null,
        lit: null,
        status: 'candidate',
        widthSource: line.confidence === 'low' ? '图片判断（低置信）' : '图片判断',
        width_n: line.width,
      });
    }
  }
  // 链式合并碎片段并重编号：一条巷道/主路一个编号，最长道路（通常是主路）排最前。
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
  const merged = mergeChains(roads, nodeById);
  const renumber = nextSequence(base.roads.map((r) => r.id), 'R');
  for (const r of merged) r.id = renumber();
  // 合并后折线中间节点不再被引用，清理识别产生的孤立节点。
  const finalReferenced = new Set<string>();
  [...prunedSpatial.roads, ...merged].forEach((r) => {
    finalReferenced.add(r.a);
    finalReferenced.add(r.b);
  });
  const finalNodes = nodes.filter(
    (n) => finalReferenced.has(n.id) || !n.name.startsWith('识别节点'),
  );
  // 本流程只识别道路，不再生成建筑候选；已确认的建筑原样保留。
  const keptBuildings = base.buildings.filter((b) => b.status !== 'candidate');
  const spatial: Spatial = {
    ...base,
    nodes: finalNodes,
    roads: [...base.roads.filter((r) => r.status !== 'candidate'), ...merged],
    buildings: keptBuildings,
    blueprint: {
      result,
      model: meta.model,
      time: meta.time ?? new Date().toISOString(),
      materialId: meta.materialId,
    },
  };
  return {
    spatial: scale > 0 ? applyScale(spatial, scale) : spatial,
    summary: {
      roads: merged.length,
      buildings: 0,
      nodes: finalNodes.length - prunedSpatial.nodes.length,
      removedCandidates: removals.size + base.buildings.length - keptBuildings.length,
      lowConfidence,
      skipped,
    },
  };
}
