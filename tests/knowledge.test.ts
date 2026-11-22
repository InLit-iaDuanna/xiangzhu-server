import { beforeAll, describe, expect, it } from 'vitest';
import {
  knowledgeStats,
  resetKnowledgeCache,
  searchKnowledge,
  searchRules,
} from '../server/knowledge';
import { retrieveAssistantKnowledge } from '../server/assistant';

// 知识库来自 knowledge/ 目录（由 npm run kb:sync 从归档知识包同步）。
beforeAll(() => {
  resetKnowledgeCache();
});

describe('知识库加载', () => {
  it('两个案例库共 200 条案例、36 条规则', async () => {
    const stats = await knowledgeStats();
    expect(stats.ready).toBe(true);
    expect(stats.cases).toBe(200);
    expect(stats.rules).toBe(36);
    expect(stats.libraries).toHaveLength(2);
    expect(stats.libraries.map((item) => item.cases)).toEqual([100, 100]);
  });

  it('案例条目保留事实、推论、边界与出处，供引用核对', async () => {
    const [top] = await searchKnowledge('老人入户门槛高差 需要坡道和扶手', 1, { kind: 'case' });
    expect(top).toBeDefined();
    expect(top.id).toMatch(/^R\d{3}$|^P\d{4}$/);
    expect(top.kind).toBe('case');
    expect(top.facts).toBeTruthy();
    expect(top.insight).toBeTruthy();
    expect(top.boundary).toBeTruthy();
    expect(top.evidence).toBeTruthy();
    expect(top.source_url).toMatch(/^https?:\/\//);
  });

  it('检索结果不下发服务器本地路径', async () => {
    const results = await searchKnowledge('卫生间如厕洗浴改造', 3);
    expect(results.length).toBeGreaterThan(0);
    for (const entry of results) expect(entry).not.toHaveProperty('source_path');
  });
});

describe('中文检索', () => {
  it('助餐问题命中食堂/助餐案例，并带出助餐规则', async () => {
    const cases = await searchKnowledge('村里长者食堂助餐点 午饭 运营成本', 3, {
      kind: 'case',
      minTerms: 2,
    });
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.map((entry) => `${entry.title}${entry.facts}`).join()).toMatch(
      /食堂|助餐|送餐|配餐/,
    );

    const rules = await searchRules('助餐点 运营成本 人力', 3, { minTerms: 2 });
    expect(rules.map((entry) => entry.id)).toContain('AF-D10');
  });

  it('旧建筑再利用命中「基础安全先行」规则', async () => {
    const rules = await searchRules('闲置旧屋改造活动室 结构安全 排水', 3, { minTerms: 2 });
    expect(rules.map((entry) => entry.id)).toContain('PS-D05');
  });

  it('与乡村改造无关的寒暄不命中，避免注入无关内容', async () => {
    expect(await searchKnowledge('你好', 5, { minScore: 6, minTerms: 2 })).toEqual([]);
  });
});

describe('协作区知识注入', () => {
  it('与改造相关的问题会带出【知识库参考】，含案例编号与出处', async () => {
    const block = await retrieveAssistantKnowledge({
      messages: [{ role: 'user', text: '老人入户有高差，装坡道和扶手要注意什么？' }],
      context: { panel: 'plans', panelTitle: '方案', flow: { stage: 'plans' } },
    });
    expect(block).not.toBeNull();
    expect(block!.text).toContain('【知识库参考');
    expect(block!.text).toContain('适用边界');
    expect(block!.text).toMatch(/https?:\/\//);
    expect(block!.caseIds.length).toBeGreaterThan(0);
  });

  it('寒暄不注入知识库', async () => {
    const block = await retrieveAssistantKnowledge({
      messages: [{ role: 'user', text: '你好' }],
    });
    expect(block).toBeNull();
  });
});
