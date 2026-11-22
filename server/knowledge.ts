import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 工作台知识库（服务端检索层）。
 *
 * 数据来自 `knowledge/`（由 `npm run kb:sync` 从项目方归档知识包同步）：
 * - 乡村适老化案例库：100 条案例 + 16 条条件化规则 + 来源登记；
 * - 乡村公共空间扩展库：100 条参考卡 + 20 条条件化规则 + 来源登记。
 *
 * 设计要点：
 * 1. 兼容旧接口字段（id/title/text/category/authority/verified/source_path），
 *    `workflow.ts` 的 consultation 与 `app.ts` 的 /api/v1/knowledge 无需改动；
 * 2. 中文检索用「重叠 2/3-gram + 领域同义词扩展 + 分栏字段加权」，比整词匹配更稳；
 * 3. 只做检索，不做事实加工：来源、证据等级、适用边界原样保留，供模型引用时区分事实与推论；
 * 4. 结果里不含服务器本地路径（source_path 不下发），避免提示词泄漏本机信息。
 */

export type KnowledgeKind = 'case' | 'rule' | 'doc';

export type KnowledgeEntry = {
  id: string;
  kind: KnowledgeKind;
  library: string;
  title: string;
  /** 兼容既有调用方的字段。 */
  source_path: string;
  source_title: string;
  locator: string;
  text: string;
  category: string;
  authority: string;
  verified: boolean;
  /** 检索与引用扩展字段（案例）。 */
  region?: string;
  location?: string;
  period?: string;
  evidence?: string;
  record_status?: string;
  facts?: string;
  insight?: string;
  boundary?: string;
  operation?: string;
  evaluation?: string;
  source_org?: string;
  source_url?: string;
  scope_group?: string;
  /** 检索与引用扩展字段（规则）。 */
  condition?: string;
  action?: string;
  exception?: string;
  case_ids?: string[];
};

/** 检索命中的条目：对外不下发服务器本地路径，附检索分值（score 越大越相关）。 */
export type KnowledgeHit = Omit<KnowledgeEntry, 'source_path'> & { score?: number };

export type KnowledgeStats = {
  dir: string;
  ready: boolean;
  total: number;
  cases: number;
  rules: number;
  libraries: Array<{ name: string; cases: number; rules: number }>;
  loaded_at: string;
};

/** searchKnowledge 的可选参数。 */
export type SearchOptions = {
  kind?: KnowledgeKind | 'all';
  /** 低于该分值的结果不返回（默认 0：返回全部命中）。 */
  minScore?: number;
  /** 至少命中的查询词数（默认 0）。用于挡掉只靠单个泛词命中的弱相关结果。 */
  minTerms?: number;
};

const CACHE_TTL_MS = 60_000;
const DEFAULT_DIR = 'knowledge';
const LEGACY_JSON = 'work/knowledge.json';
const MAX_QUERY_TERMS = 60;

const HERE = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

let cache: { at: number; entries: KnowledgeEntry[]; dir: string } | null = null;

/** 测试与运维用：强制下次检索重新读取知识库文件。 */
export function resetKnowledgeCache(): void {
  cache = null;
}

function knowledgeDir(): string {
  const configured = (process.env.KNOWLEDGE_DIR ?? DEFAULT_DIR).trim() || DEFAULT_DIR;
  const candidates = path.isAbsolute(configured)
    ? [configured]
    : [path.resolve(process.cwd(), configured), path.resolve(HERE, '..', configured)];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function strList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function clip(text: string, max: number): string {
  const value = text.trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function joinParts(parts: Array<string | undefined>, separator = '；'): string {
  return parts.map((item) => (item ?? '').trim()).filter(Boolean).join(separator);
}

async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      // 单行损坏不影响整库加载，跳过。
    }
  }
  return records;
}

async function readJsonArray(file: string): Promise<Record<string, unknown>[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item),
        )
      : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 归档知识包的两个库字段不同，分别归一化成同一结构。
// ---------------------------------------------------------------------------

const AGE_LIBRARY = '乡村适老化案例库（100条）';
const SPACE_LIBRARY = '乡村公共空间参考库（100条）';

function normalizeAgeCase(record: Record<string, unknown>, locator: string): KnowledgeEntry | null {
  const id = str(record.case_id);
  if (!id) return null;
  const facts = clip(str(record.verified_actions), 300);
  const insight = clip(str(record.distilled_rule), 200);
  const boundary = clip(str(record.transfer_boundary), 160);
  const period = joinParts([str(record.reported_date), str(record.implementation_period)], ' · ');
  const recordStatus = str(record.record_status);
  return {
    id,
    kind: 'case',
    library: AGE_LIBRARY,
    title: str(record.name) || id,
    source_path: locator,
    source_title: str(record.source_title),
    locator,
    text: clip(joinParts([facts, insight ? `可迁移：${insight}` : '']), 320),
    category: joinParts([str(record.primary_topic), str(record.category)], ' / '),
    authority: '案例库整理（事实＋分析推论，非效果实证）',
    verified: false,
    region: str(record.province),
    location: str(record.location),
    period,
    evidence: str(record.evidence_access),
    record_status: joinParts([str(record.case_type), recordStatus]),
    facts,
    insight,
    boundary,
    operation: clip(joinParts([str(record.outcome_evidence), str(record.source_note)]), 200),
    source_org: str(record.source_publisher),
    source_url: str(record.source_url),
    scope_group: str(record.rural_scope),
  };
}

function normalizeAgeRule(record: Record<string, unknown>, locator: string): KnowledgeEntry | null {
  const rawId = str(record.rule_id);
  if (!rawId) return null;
  const condition = clip(str(record.when), 160);
  const action = clip(str(record.then), 200);
  const exception = clip(str(record.unless), 160);
  return {
    id: `AF-${rawId}`,
    kind: 'rule',
    library: AGE_LIBRARY,
    title: str(record.title) || rawId,
    source_path: locator,
    source_title: '条件化经验规则（适老库）',
    locator,
    text: clip(joinParts([condition, action, exception]), 280),
    category: '条件化规则',
    authority: str(record.rule_status) || '分析推论，非工程规范或效果定论',
    verified: false,
    condition,
    action,
    exception,
    case_ids: strList(record.case_ids),
  };
}

function normalizeSpaceCase(record: Record<string, unknown>, locator: string): KnowledgeEntry | null {
  const id = str(record.case_id);
  if (!id) return null;
  const sources = Array.isArray(record.sources)
    ? record.sources.filter(
        (item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
  const primary = sources[0] ?? {};
  const facts = clip(strList(record.source_facts).join('；'), 300);
  const insight = clip(joinParts([str(record.age_friendly_inference), str(record.spatial_summary)]), 220);
  const boundary = clip(str(record.transfer_boundary), 160);
  return {
    id,
    kind: 'case',
    library: SPACE_LIBRARY,
    title: str(record.name) || id,
    source_path: locator,
    source_title: str(primary.title) || str(record.name),
    locator,
    text: clip(joinParts([facts, insight ? `可迁移：${insight}` : '']), 320),
    category: joinParts([str(record.scope), str(record.category)], ' / '),
    authority: '参考库整理（事实＋适老化迁移推论，非效果实证）',
    verified: false,
    region: str(record.country),
    location: str(record.location),
    period: joinParts([num(record.publication_year), str(record.completion)], ' · '),
    evidence: str(record.evidence_level) || str(record.age_evidence),
    record_status: str(record.project_status),
    facts,
    insight,
    boundary,
    operation: clip(strList(record.operating_questions).join('；'), 240),
    evaluation: clip(strList(record.suggested_evaluation).join('；'), 160),
    source_org: str(primary.publisher) || str(record.designer),
    source_url: str(primary.url) || str(record.image_source_page),
    scope_group: str(record.scope_group),
  };
}

function normalizeSpaceRule(record: Record<string, unknown>, locator: string): KnowledgeEntry | null {
  const rawId = str(record.rule_id);
  if (!rawId) return null;
  const condition = clip(str(record.condition), 160);
  const action = clip(str(record.action), 200);
  const exception = clip(str(record.do_not), 160);
  return {
    id: `PS-${rawId}`,
    kind: 'rule',
    library: SPACE_LIBRARY,
    title: str(record.title) || rawId,
    source_path: locator,
    source_title: '条件化经验规则（公共空间库）',
    locator,
    text: clip(joinParts([condition, action, exception]), 280),
    category: '条件化规则',
    authority: str(record.status) || '分析推论，非工程规范或效果定论',
    verified: false,
    condition,
    action,
    exception,
    case_ids: strList(record.case_ids),
  };
}

/** 旧版 `work/knowledge.json`（自建条目）兼容加载，作为 doc 类目并入。 */
function normalizeLegacyDoc(record: Record<string, unknown>): KnowledgeEntry | null {
  const id = str(record.id);
  if (!id) return null;
  return {
    id,
    kind: 'doc',
    library: '自建知识条目',
    title: str(record.title) || id,
    source_path: str(record.source_path),
    source_title: str(record.source_title),
    locator: str(record.locator),
    text: str(record.text),
    category: str(record.category) || '自建条目',
    authority: str(record.authority) || '自建条目',
    verified: record.verified === true,
  };
}

async function loadEntries(): Promise<{ entries: KnowledgeEntry[]; dir: string }> {
  const dir = knowledgeDir();
  const ageDir = path.join(dir, 'rural_age_friendly_100');
  const spaceDir = path.join(dir, 'rural_public_space_expansion');
  const entries: KnowledgeEntry[] = [];

  const ageCases = await readJsonl(path.join(ageDir, 'references', 'cases.jsonl'));
  for (const [index, record] of ageCases.entries()) {
    const entry = normalizeAgeCase(record, `rural_age_friendly_100/references/cases.jsonl#L${index + 1}`);
    if (entry) entries.push(entry);
  }

  const ageRules = await readJsonl(path.join(ageDir, 'references', 'rules.jsonl'));
  for (const [index, record] of ageRules.entries()) {
    const entry = normalizeAgeRule(record, `rural_age_friendly_100/references/rules.jsonl#L${index + 1}`);
    if (entry) entries.push(entry);
  }

  const spaceCases = await readJsonl(path.join(spaceDir, 'data', 'cases.jsonl'));
  for (const [index, record] of spaceCases.entries()) {
    const entry = normalizeSpaceCase(record, `rural_public_space_expansion/data/cases.jsonl#L${index + 1}`);
    if (entry) entries.push(entry);
  }

  const spaceRules = await readJsonArray(path.join(spaceDir, 'references', 'distilled_rules.json'));
  for (const [index, record] of spaceRules.entries()) {
    const entry = normalizeSpaceRule(record, `rural_public_space_expansion/references/distilled_rules.json#${index + 1}`);
    if (entry) entries.push(entry);
  }

  const legacyPath = path.resolve(process.cwd(), process.env.KNOWLEDGE_PATH?.trim() || LEGACY_JSON);
  if (existsSync(legacyPath)) {
    for (const record of await readJsonArray(legacyPath)) {
      const entry = normalizeLegacyDoc(record);
      if (entry) entries.push(entry);
    }
  }

  return { entries, dir };
}

async function load(): Promise<{ entries: KnowledgeEntry[]; dir: string }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { entries: cache.entries, dir: cache.dir };
  }
  const loaded = await loadEntries();
  cache = { at: Date.now(), entries: loaded.entries, dir: loaded.dir };
  return loaded;
}

/** 全部知识条目（案例＋规则＋自建条目）。 */
export async function knowledgeEntries(): Promise<KnowledgeEntry[]> {
  return (await load()).entries;
}

/** 条件化规则（两个库合计 36 条，编号已加 AF-/PS- 前缀）。 */
export async function knowledgeRules(): Promise<KnowledgeEntry[]> {
  return (await load()).entries.filter((entry) => entry.kind === 'rule');
}

// ---------------------------------------------------------------------------
// 中文检索：重叠 n-gram + 领域同义词扩展 + 分栏字段加权。
// ---------------------------------------------------------------------------

/** 常见虚词/疑问词：以它们开头或组成的 2-gram 噪声大，直接丢弃。 */
const FUNCTION_CHARS = new Set([
  '的', '了', '呢', '吗', '吧', '啊', '呀', '在', '和', '与', '及', '或', '把', '被', '给', '对', '从',
  '向', '为', '以', '而', '并', '是', '不', '我', '你', '他', '它', '这', '那', '有', '个', '也', '就',
  '都', '还', '会', '要', '能', '请', '帮', '吗', '怎', '样',
]);

const STOP_WORDS = new Set([
  '什么', '怎么', '如何', '哪些', '这个', '那个', '我们', '你们', '他们', '可以', '需要', '是否',
  '以及', '如果', '就是', '还是', '一个', '没有', '不能', '不要', '请问', '帮我', '一下', '关于',
  '对于', '这里', '现在', '已经', '但是', '因为', '所以', '进行', '或者', '请问',
]);

/** 领域同义词扩展：命中左侧场景时，补充右侧做法词，权重减半。 */
const ALIAS_GROUPS: Array<{ test: RegExp; terms: string[] }> = [
  { test: /无障碍|轮椅|腿脚|行动不便|门槛|台阶|高差|跌倒|摔/, terms: ['坡道', '扶手', '无障碍', '高差', '防滑', '门槛'] },
  { test: /适老|老人|老年|长者|银龄|独居|空巢|高龄/, terms: ['适老', '老年人', '长者', '独居', '照护'] },
  { test: /助餐|吃饭|就餐|食堂|午饭|送饭|配餐|养老服务/, terms: ['助餐', '食堂', '送餐', '就餐', '幸福院'] },
  { test: /休憩|休息|座椅|坐凳|树荫|遮阳|遮雨|乘凉|晒太阳/, terms: ['座椅', '坐凳', '树荫', '遮雨', '休息点'] },
  { test: /厕所|如厕|卫生间|公厕|马桶|洗浴|洗澡/, terms: ['厕所', '如厕', '卫生间', '洗浴'] },
  { test: /就医|看病|卫生室|医务|转诊|家庭医生|急救|求助/, terms: ['就医', '卫生室', '转诊', '急救', '响应'] },
  { test: /出行|步行|走路|道路|路面|夜路|照明|串门|赶集/, terms: ['步行', '道路', '路面', '照明', '夜间', '通行'] },
  { test: /活动|广场|议事|聚会|聊天|下棋|文娱/, terms: ['活动', '广场', '议事', '聚集', '公共空间'] },
  { test: /运营|维护|保洁|管护|经费|成本|志愿|可持续/, terms: ['运营', '维护', '保洁', '成本', '责任', '可持续'] },
  { test: /改造|更新|翻建|修缮|再利用|闲置|旧房|旧屋/, terms: ['改造', '更新', '修缮', '再利用', '闲置'] },
  { test: /坡|山|水|沟|坎|台地|地形/, terms: ['坡道', '坡度', '台阶', '排水'] },
  { test: /冬|寒冷|风|雨|气候|酷热/, terms: ['气候', '避风', '遮雨', '保温'] },
];

function tokenize(query: string): Map<string, number> {
  const weights = new Map<string, number>();
  const add = (term: string, weight: number) => {
    if (term.length < 2 || STOP_WORDS.has(term)) return;
    weights.set(term, Math.max(weights.get(term) ?? 0, weight));
  };

  const normalized = query.toLowerCase();
  for (const match of normalized.matchAll(/[a-z][a-z0-9_-]{1,}/g)) add(match[0], 1);

  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    // 该正则只匹配 BMP 汉字，按 UTF-16 码元切片与按字符切片一致（不涉及代理对）。
    for (let size = 2; size <= 3; size++) {
      for (let i = 0; i + size <= run.length; i++) {
        const gram = run.slice(i, i + size);
        if (size === 2 && (FUNCTION_CHARS.has(gram[0]) || FUNCTION_CHARS.has(gram[1]))) continue;
        add(gram, size === 2 ? 0.8 : 1);
      }
    }
  }

  for (const group of ALIAS_GROUPS) {
    if (!group.test.test(normalized)) continue;
    for (const term of group.terms) add(term, 0.5);
  }

  return new Map(
    [...weights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_QUERY_TERMS),
  );
}

type WeightedField = { value: string; weight: number };

function entryFields(entry: KnowledgeEntry): WeightedField[] {
  if (entry.kind === 'rule') {
    return [
      { value: entry.title, weight: 6 },
      { value: entry.condition ?? '', weight: 3.2 },
      { value: entry.action ?? '', weight: 3.2 },
      { value: entry.exception ?? '', weight: 1.6 },
      { value: entry.text, weight: 0.5 },
    ];
  }
  if (entry.kind === 'doc') {
    return [
      { value: entry.title, weight: 5 },
      { value: entry.category, weight: 2 },
      { value: entry.text, weight: 2 },
      { value: entry.source_title, weight: 1 },
    ];
  }
  return [
    { value: entry.title, weight: 6 },
    { value: entry.category, weight: 3.4 },
    { value: entry.facts ?? '', weight: 3 },
    { value: entry.insight ?? '', weight: 2.5 },
    { value: joinParts([entry.region, entry.location], ' '), weight: 2 },
    { value: entry.boundary ?? '', weight: 1.6 },
    { value: entry.operation ?? '', weight: 1.3 },
    { value: entry.evaluation ?? '', weight: 1 },
    { value: joinParts([entry.source_title, entry.source_org], ' '), weight: 1 },
    { value: entry.period ?? '', weight: 0.4 },
    { value: entry.text, weight: 0.5 },
  ];
}

/** 证据与地域微调：国内乡村核心优先，A 级读取优先，B 级与国外参考降权。 */
function entryBoost(entry: KnowledgeEntry): number {
  let boost = 1;
  const group = entry.scope_group ?? '';
  if (group.includes('国内乡村核心') || group.includes('具体村庄')) boost *= 1.2;
  else if (group.startsWith('国内')) boost *= 1.05;
  else if (group.startsWith('国外')) boost *= 0.85;
  const evidence = (entry.evidence ?? '').toUpperCase();
  if (evidence.startsWith('A')) boost *= 1.05;
  else if (evidence.startsWith('B')) boost *= 0.95;
  return boost;
}

function scoreEntry(entry: KnowledgeEntry, terms: Map<string, number>): { score: number; matches: number } {
  if (!terms.size) return { score: 0, matches: 0 };
  const fields = entryFields(entry);
  let score = 0;
  let matches = 0;
  for (const [term, termWeight] of terms) {
    let hit = false;
    for (const { value, weight } of fields) {
      if (value && value.includes(term)) {
        score += weight * termWeight;
        hit = true;
      }
    }
    if (hit) matches += 1;
  }
  return { score: score * entryBoost(entry), matches };
}

function toPublic(entry: KnowledgeEntry): KnowledgeHit {
  const { source_path: _sourcePath, ...rest } = entry;
  return rest;
}

function search(entries: KnowledgeEntry[], query: string, limit: number, options: SearchOptions): KnowledgeHit[] {
  const terms = tokenize(query ?? '');
  const kind = options.kind ?? 'all';
  const minScore = options.minScore ?? 0;
  const minTerms = options.minTerms ?? 0;
  const pool = kind === 'all' ? entries : entries.filter((entry) => entry.kind === kind);

  if (!query.trim()) return pool.slice(0, limit).map((entry) => toPublic(entry));

  return pool
    .map((entry) => ({ entry, ...scoreEntry(entry, terms) }))
    .filter((item) => item.score > minScore && item.matches >= minTerms)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id, undefined, { numeric: true }))
    .slice(0, limit)
    .map(({ entry, score }) => ({ ...toPublic(entry), score: Math.round(score * 100) / 100 }));
}

/**
 * 语义无关的关键词检索（够用且可解释）：分值与命中字段相关，
 * 返回条目不含 source_path（本地路径不下发）。
 */
export async function searchKnowledge(query: string, limit = 6, options: SearchOptions = {}) {
  const { entries } = await load();
  return search(entries, query, limit, options);
}

/** 只检索条件化规则（供协作区对话、方案编写时做经验对照）。 */
export async function searchRules(query: string, limit = 3, options: SearchOptions = {}) {
  return searchKnowledge(query, limit, { ...options, kind: 'rule' });
}

/** 供 /api/v1/knowledge 状态与运维自检使用。 */
export async function knowledgeStats(): Promise<KnowledgeStats> {
  const { entries, dir } = await load();
  const byLibrary = new Map<string, { cases: number; rules: number }>();
  for (const entry of entries) {
    if (entry.kind === 'doc') continue;
    const current = byLibrary.get(entry.library) ?? { cases: 0, rules: 0 };
    if (entry.kind === 'case') current.cases += 1;
    else current.rules += 1;
    byLibrary.set(entry.library, current);
  }
  return {
    dir,
    ready: entries.some((entry) => entry.kind === 'case'),
    total: entries.length,
    cases: entries.filter((entry) => entry.kind === 'case').length,
    rules: entries.filter((entry) => entry.kind === 'rule').length,
    libraries: [...byLibrary.entries()].map(([name, counts]) => ({ name, ...counts })),
    loaded_at: new Date(cache?.at ?? Date.now()).toISOString(),
  };
}
