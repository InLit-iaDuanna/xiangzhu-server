import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knowledgeStats, resetKnowledgeCache, searchKnowledge, searchRules } from '../server/knowledge';

/**
 * 知识库运维脚本：
 *   npm run kb:sync -- "<归档目录>"   从项目方归档知识包同步数据到 knowledge/
 *   npm run kb:check                  打印加载统计 + 检索自检样例
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'knowledge');

const COPY_PLAN: Array<{ from: string; to: string }> = [
  { from: 'rural_age_friendly_100/references/cases.jsonl', to: 'rural_age_friendly_100/references/cases.jsonl' },
  { from: 'rural_age_friendly_100/references/rules.jsonl', to: 'rural_age_friendly_100/references/rules.jsonl' },
  { from: 'rural_age_friendly_100/references/sources.json', to: 'rural_age_friendly_100/references/sources.json' },
  { from: 'rural_age_friendly_100/references/schema.json', to: 'rural_age_friendly_100/references/schema.json' },
  { from: 'rural_age_friendly_100/references/source_groups.json', to: 'rural_age_friendly_100/references/source_groups.json' },
  { from: 'rural_age_friendly_100/SKILL.md', to: 'rural_age_friendly_100/SKILL.md' },
  { from: 'rural_age_friendly_100/README.md', to: 'rural_age_friendly_100/README.md' },
  { from: 'rural_age_friendly_100/validation_report.json', to: 'rural_age_friendly_100/validation_report.json' },
  { from: 'rural_public_space_expansion/data/cases.jsonl', to: 'rural_public_space_expansion/data/cases.jsonl' },
  { from: 'rural_public_space_expansion/references/distilled_rules.json', to: 'rural_public_space_expansion/references/distilled_rules.json' },
  { from: 'rural_public_space_expansion/references/sources.json', to: 'rural_public_space_expansion/references/sources.json' },
  { from: 'rural_public_space_expansion/references/field_dictionary.json', to: 'rural_public_space_expansion/references/field_dictionary.json' },
  { from: 'rural_public_space_expansion/references/images.json', to: 'rural_public_space_expansion/references/images.json' },
  { from: 'rural_public_space_expansion/references/package_integrity.json', to: 'rural_public_space_expansion/references/package_integrity.json' },
  { from: 'rural_public_space_expansion/references/validation_report.json', to: 'rural_public_space_expansion/references/validation_report.json' },
  { from: 'rural_public_space_expansion/manifest.json', to: 'rural_public_space_expansion/manifest.json' },
  { from: 'rural_public_space_expansion/README.md', to: 'rural_public_space_expansion/README.md' },
  { from: 'rural_public_space_expansion/SKILL.md', to: 'rural_public_space_expansion/SKILL.md' },
  { from: 'deep-research-report-6.md', to: 'method/deep-research-report-6.md' },
];

function resolveSource(explicit?: string): string {
  const candidates = [
    explicit,
    path.join(ROOT, '归档'),
    path.join(ROOT, '..', '归档'),
  ].filter((item): item is string => Boolean(item));
  const found = candidates.find((item) => existsSync(item));
  if (!found) {
    throw new Error(`未找到归档知识包目录，请用 npm run kb:sync -- "<目录>" 指定。已尝试：${candidates.join('、')}`);
  }
  return path.resolve(found);
}

async function sync(source: string): Promise<void> {
  let copied = 0;
  for (const item of COPY_PLAN) {
    const from = path.join(source, item.from);
    if (!existsSync(from)) {
      console.warn(`跳过（源文件不存在）：${item.from}`);
      continue;
    }
    const to = path.join(TARGET, item.to);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    copied += 1;
  }
  resetKnowledgeCache();
  console.log(`已从 ${source} 同步 ${copied}/${COPY_PLAN.length} 个数据文件 → ${path.relative(ROOT, TARGET)}/`);
}

const SELF_CHECKS: Array<{ label: string; query: string }> = [
  { label: '入户无障碍', query: '老人入户门槛高差、台阶，需要坡道和扶手' },
  { label: '助餐运营', query: '村里长者食堂助餐点运营成本和志愿者' },
  { label: '公共空间休憩', query: '村口树荫座椅休息点，遮雨' },
  { label: '旧房改造安全', query: '闲置旧屋改造成活动室，结构安全和排水' },
  { label: '如厕洗浴', query: '卫生间如厕洗浴适老化改造' },
];

async function check(): Promise<void> {
  resetKnowledgeCache();
  const stats = await knowledgeStats();
  console.log('知识库加载：', JSON.stringify(stats, null, 2));
  if (!stats.ready) {
    console.error('知识库为空：请先运行 npm run kb:sync');
    process.exitCode = 1;
    return;
  }
  for (const item of SELF_CHECKS) {
    const cases = await searchKnowledge(item.query, 3, { kind: 'case', minScore: 1 });
    const rules = await searchRules(item.query, 2, { minScore: 1 });
    console.log(`\n[${item.label}] ${item.query}`);
    for (const entry of cases) {
      console.log(`  案例 ${entry.id}（${entry.region ?? ''}${entry.location ? '·' + entry.location : ''}）${entry.title} → ${'score' in entry ? entry.score : '-'}`);
    }
    for (const entry of rules) {
      console.log(`  规则 ${entry.id} ${entry.title}（${entry.condition ?? ''}）`);
    }
    if (!cases.length && !rules.length) console.log('  无命中');
  }
}

const [command, argument] = process.argv.slice(2);
if (command === 'sync') await sync(resolveSource(argument));
else if (command === 'check') await check();
else {
  console.log('用法：tsx scripts/kb.ts sync [归档目录] | check');
  process.exitCode = 1;
}
