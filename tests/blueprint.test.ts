import { describe, expect, it } from 'vitest';
import {
  applyBlueprint,
  type BlueprintResult,
} from '../lib/v2/blueprint';
import { emptySpatial } from '../lib/spatial';

// 归一化坐标（0..1）：与视觉识别输出契约一致；空场景基准为 1000×667 像素。
function result(roads: BlueprintResult['roads']): BlueprintResult {
  return {
    image_readable: true,
    summary: '测试影像',
    roads,
    buildings: [],
    missing_fields: [],
  };
}

describe('applyBlueprint（AI 转译 + mergeChains 链式合并）', () => {
  it('共线折线被合并为一条道路：一条巷道只占一个编号', () => {
    const base = emptySpatial();
    // 三个共线顶点 (0.1,0.5) (0.3,0.5) (0.5,0.5)：先拆成两段，再合并回一条。
    const r = result([
      {
        points: [
          { x: 0.1, y: 0.5 },
          { x: 0.3, y: 0.5 },
          { x: 0.5, y: 0.5 },
        ],
        width: 0.04,
        confidence: 'high',
      },
    ]);
    const { spatial, summary } = applyBlueprint(base, r, 0, { model: 'test' });
    expect(summary.roads).toBe(1);
    expect(spatial.roads).toHaveLength(1);
    expect(spatial.roads[0].status).toBe('candidate');
    expect(spatial.roads[0].id).toBe('R-01');
  });

  it('夹角超过 18° 的折线在拐点断开，保留折线形状', () => {
    const base = emptySpatial();
    // (0.1,0.5)→(0.3,0.5) 横向，(0.3,0.5)→(0.3,0.2) 纵向：90° 拐角不合并。
    const r = result([
      {
        points: [
          { x: 0.1, y: 0.5 },
          { x: 0.3, y: 0.5 },
          { x: 0.3, y: 0.2 },
        ],
        width: 0.04,
        confidence: 'high',
      },
    ]);
    const { spatial, summary } = applyBlueprint(base, r, 0, { model: 'test' });
    expect(summary.roads).toBe(2);
    expect(spatial.roads).toHaveLength(2);
  });

  it('按长度降序重编号：最长的道路排 R-01', () => {
    const base = emptySpatial();
    const r = result([
      {
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.2, y: 0.2 },
        ],
        width: 0.02,
        confidence: 'high',
      },
      {
        points: [
          { x: 0.1, y: 0.8 },
          { x: 0.9, y: 0.8 },
        ],
        width: 0.06,
        confidence: 'high',
      },
    ]);
    const { spatial } = applyBlueprint(base, r, 0, { model: 'test' });
    expect(spatial.roads).toHaveLength(2);
    // 0.8 倍宽度（长路）应排第一。
    expect(spatial.roads[0].id).toBe('R-01');
    expect(spatial.roads[0].a).not.toBe(spatial.roads[0].b);
  });

  it('合并后清理折线中间的孤立识别节点', () => {
    const base = emptySpatial();
    const r = result([
      {
        points: [
          { x: 0.1, y: 0.5 },
          { x: 0.3, y: 0.5 },
          { x: 0.5, y: 0.5 },
        ],
        width: 0.04,
        confidence: 'high',
      },
    ]);
    const { spatial } = applyBlueprint(base, r, 0, { model: 'test' });
    // 合并为一条后仅剩两个端点节点。
    expect(spatial.nodes).toHaveLength(2);
  });

  it('无道路时输出空结果且不改动节点', () => {
    const base = emptySpatial();
    const { spatial, summary } = applyBlueprint(
      base,
      result([]),
      0,
      { model: 'test' },
    );
    expect(summary.roads).toBe(0);
    expect(spatial.nodes).toHaveLength(0);
    expect(spatial.roads).toHaveLength(0);
  });

  it('scale>0 时把宽度比例换算为米（applyScale）', () => {
    const base = emptySpatial();
    const r = result([
      {
        points: [
          { x: 0.1, y: 0.5 },
          { x: 0.5, y: 0.5 },
        ],
        width: 0.04,
        confidence: 'high',
      },
    ]);
    const { spatial } = applyBlueprint(base, r, 0.5, { model: 'test' });
    // 0.04 × 1000 × 0.5 = 20 米。
    expect(spatial.roads[0].width).toBeCloseTo(20, 6);
  });
});
