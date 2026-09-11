import { describe, expect, it } from 'vitest';
import {
  calculateRoute,
  demoSpatial,
  emptySpatial,
  evaluateSite,
  hasMetricScale,
  roadLengthMeters,
  scaleFromArea,
  scaleFromWidth,
  defaultConfig,
} from '../lib/spatial';

describe('hasMetricScale / scaleFromArea（尺度标定）', () => {
  it('未标定的空场景不算米制尺度', () => {
    expect(hasMetricScale(emptySpatial())).toBe(false);
  });
  it('演示场景带 demo 标定，算米制尺度', () => {
    expect(hasMetricScale(demoSpatial())).toBe(true);
  });
  it('scaleFromArea：非正面积返回 null；1000×667 基准下 667000m² 恰好 1 m/单位', () => {
    expect(scaleFromArea(0)).toBeNull();
    expect(scaleFromArea(-5)).toBeNull();
    expect(scaleFromArea(1000 * 667)).toBeCloseTo(1, 6);
  });
  it('scaleFromWidth：宽度换算', () => {
    expect(scaleFromWidth(0)).toBeNull();
    expect(scaleFromWidth(500)).toBeCloseTo(0.5, 6);
  });
});

describe('roadLengthMeters（路长估算：实测优先 → 标定派生）', () => {
  it('未标定时返回 null（提示先去标定）', () => {
    const s = emptySpatial();
    expect(
      roadLengthMeters(s, { a: 'x', b: 'y', length_m: null }),
    ).toBeNull();
  });
  it('标定后按 节点平面距离 × 尺度 派生：n1→n2 横向 256 像素 × 0.5 = 128m', () => {
    const s = demoSpatial();
    const r = s.roads[0]; // n1(159,195) → n2(415,195)
    expect(r.a).toBe('n1');
    expect(r.b).toBe('n2');
    expect(roadLengthMeters(s, r)).toBeCloseTo(128, 6);
  });
  it('用户实测值优先于几何派生值', () => {
    const s = demoSpatial();
    expect(
      roadLengthMeters(s, { a: 'n1', b: 'n2', length_m: 99 }),
    ).toBe(99);
  });
  it('节点缺失时返回 null', () => {
    const s = demoSpatial();
    expect(roadLengthMeters(s, { a: 'nope', b: 'n2' })).toBeNull();
  });
});

describe('calculateRoute（路径测试）', () => {
  it('起点或终点不存在时不可达', () => {
    const s = demoSpatial();
    const result = calculateRoute(s, { ...defaultConfig, start: 'nX' }, 'shortest');
    expect(result.reachable).toBe(false);
  });
  it('最短路径：n1 → n8 在演示路网上可达', () => {
    const s = demoSpatial();
    const result = calculateRoute(
      s,
      { ...defaultConfig, start: 'n1', end: 'n8' },
      'shortest',
    );
    expect(result.reachable).toBe(true);
    expect(result.nodes[0]).toBe('n1');
    expect(result.nodes.at(-1)).toBe('n8');
    expect(result.roads.length).toBeGreaterThan(0);
  });
  it('习惯路线首尾与起终点不一致时失败', () => {
    const s = demoSpatial();
    const result = calculateRoute(
      s,
      { ...defaultConfig, start: 'n2', end: 'n8' },
      'habit',
    );
    expect(result.reachable).toBe(false);
  });
  it('习惯路线（defaultConfig.habit 本身）可达', () => {
    const s = demoSpatial();
    const result = calculateRoute(s, defaultConfig, 'habit');
    expect(result.reachable).toBe(true);
    expect(result.nodes).toEqual(['n1', 'n2', 'n4', 'n5', 'n8']);
  });
});

describe('evaluateSite（选址测试前置条件）', () => {
  it('道路未全部确认时返回“资料不足”灰档', () => {
    const s = demoSpatial(); // 演示道路默认 confirmed: false
    const facility: import('../lib/spatial').Facility = {
      x: 500,
      y: 300,
      name: '休息点',
      size: '小',
      angle: 0,
    };
    const result = evaluateSite(s, facility);
    expect(result.status).toBe('gray');
    expect(result.label).toBe('资料不足');
  });
  it('设施轮廓超出研究范围返回红档', () => {
    const s = demoSpatial();
    s.roads = s.roads.map((r) => ({ ...r, confirmed: true }));
    const facility: import('../lib/spatial').Facility = {
      x: 995,
      y: 300,
      name: '越界点',
      size: '大',
      angle: 0,
    };
    const result = evaluateSite(s, facility);
    expect(result.status).toBe('red');
    expect(result.label).toBe('超出研究范围');
  });
});
