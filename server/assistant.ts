import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { searchKnowledge, searchRules, type KnowledgeHit } from './knowledge';
import { generateImages, imageGenAvailable, imageGenConfig, imageGenGuide } from './image-gen';
import { getTextAIConfig, streamTextAI, TextAIError } from './text-ai';

/**
 * 协作区 AI 的服务端桥接（V3 统一 AI 通道）。
 *
 * 接收对话请求 → 复用统一文本 AI 配置路由到 API 或显式选择的 CodeBuddy → SSE 回推文本。
 * 迁移后的差异：
 * - 路由挂在 fastify（:4100），前端经 /api/v1/assistant 代理访问；
 * - 免登录（stub auth）下 preHandler 自动放行；
 * - 不转发 provider 内部 reasoning/thinking 事件；
 * - env 由 `npm run api` 的 --env-file=.env.local 提供，无需插件版 loadLocalEnv。
 */

const CLI_PACKAGE = '@tencent-ai/codebuddy-code';
const CLI_ENTRY_RELATIVE = path.join('bin', 'codebuddy');
// 携带长文档时模型需要更长思考时间，超时上限相应放宽。
const DEFAULT_TIMEOUT_MS = 300_000;

/** 单个文本附件内联进提示词时的字符上限，避免撑爆上下文。 */
const MAX_TEXT_ATTACHMENT_CHARS = 60_000;

const MAX_ATTACHMENTS = 12;
const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CHAT_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;

/**
 * 知识库检索参数。阈值来自 `npm run kb:check` 的自检：相关命中通常 >15 分且至少命中 2 个词，
 * 寒暄或与乡村改造无关的问题不会命中任何条目，因此不会向提示词注入无关内容。
 */
const KNOWLEDGE_CASE_LIMIT = 4;
const KNOWLEDGE_RULE_LIMIT = 3;
const KNOWLEDGE_MIN_SCORE = 6;
const KNOWLEDGE_MIN_TERMS = 2;
/** 工作区上下文参与检索的字符上限，避免档案长文本稀释本轮问题。 */
const KNOWLEDGE_CONTEXT_CHARS = 200;

/**
 * CLI 未登录时会把鉴权报错当作正文输出，这类文本不能展示成"AI 的回答"。
 */
const AUTH_ERROR_PATTERNS = [
  'authentication required',
  'please use /login',
  'invalid api key',
  'unauthorized',
  'not logged in',
];

const INFRA_ERROR_PATTERNS = [
  ...AUTH_ERROR_PATTERNS,
  'insufficient balance',
  'quota exceeded',
  'rate limit',
];

function isAuthError(text: string): boolean {
  const normalized = text.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isInfraError(text: string): boolean {
  const normalized = text.toLowerCase();
  return INFRA_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * 模型服务端也会把错误当正文回吐（例如 "400 Please start a new conversation..."），
 * 这类开头同样不能展示成回答。
 */
const FAILURE_LEAD_PATTERN =
  /^([45]\d{2}\b|authentication required|please use \/login|invalid api key|unauthorized|not logged in|insufficient balance|quota exceeded|rate limit|invalid_request_error|please start a new conversation)/;

/** 判断已收到的开头片段是失败文案、仍需等待，还是可以正常放行。 */
function leadState(text: string): 'failure' | 'pending' | 'ok' {
  const sample = text.trimStart().toLowerCase();
  if (!sample) return 'pending';
  if (FAILURE_LEAD_PATTERN.test(sample)) return 'failure';

  const head = sample.trimEnd();
  // 可能是 "400" / "500" 这类状态码前缀，再等等。
  if (/^[45]?\d{0,2}$/.test(head)) return 'pending';
  if (
    head.length < 24 &&
    INFRA_ERROR_PATTERNS.some((pattern) => pattern.startsWith(head))
  ) {
    return 'pending';
  }
  return 'ok';
}

const AUTH_HINT =
  'CodeBuddy CLI 尚未登录：请先在终端运行 codebuddy 并完成 /login，再回到工作台使用 AI 功能。';

const HERE = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

const PERSONA_FILE = path.join(HERE, 'assistant-persona.md');

function assistantPersona(): string {
  try {
    return existsSync(PERSONA_FILE) ? readFileSync(PERSONA_FILE, 'utf8') : '';
  } catch {
    return '';
  }
}

type ChatRole = 'user' | 'assistant';

type ChatTurn = { role: ChatRole; text: string };

type ProjectContext = {
  name?: string;
  address?: string;
  facilities?: string[];
  photoCount?: number;
  markCount?: number;
  confirmedMarkCount?: number;
  debugScenarioCount?: number;
  debugRunCount?: number;
  planCount?: number;
  /** 现有方案摘要（序号从 1 起，供 plan.open / plan.setCurrent 引用）。 */
  planSummaries?: { index?: number; title?: string }[];
  fields?: Record<string, string>;
};

type PlanContext = {
  title?: string;
  scene?: string;
  scope?: string;
  references?: string;
  innovation?: string;
  compliance?: string;
  implementation?: string;
  cost?: string;
  maintenance?: string;
  verification?: string;
  tradeoffs?: string;
  body?: string;
};

/**
 * 工作台推进状态。由前端按同一套判据算好后下发，
 * 助手据此决定"这一步该做什么"，避免跳步直接产出方案。
 */
type FlowContext = {
  stage?: string;
  archiveReady?: boolean;
  missingFields?: string[];
  missingSlots?: string[];
  /** 允许从文档回填的空字段：键名与界面表单一一对应。 */
  fillableFields?: { key?: string; label?: string }[];
  photoCount?: number;
  /** 进入调试前需要与用户对齐的疑点。 */
  openIssues?: string[];
  debugConfirmed?: boolean;
  debugIntegrated?: boolean;
  debugRunCount?: number;
  debugMarkCount?: number;
  nextActionLabel?: string;
};

type AssistantContext = {
  panel?: string;
  panelTitle?: string;
  project?: ProjectContext;
  plan?: PlanContext;
  flow?: FlowContext;
};

const STAGE_LABELS: Record<string, string> = {
  archive: '建档',
  debug: '调试',
  plans: '方案',
};

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function formatFlow(flow: FlowContext | undefined): string {
  if (!flow) return '';

  const lines: string[] = [];
  const stage = clean(flow.stage);

  lines.push(`当前阶段：${STAGE_LABELS[stage] ?? '建档'}`);

  const missingFields = (flow.missingFields ?? []).filter(Boolean);
  const missingSlots = (flow.missingSlots ?? []).filter(Boolean);
  lines.push(`档案完备度：${flow.archiveReady ? '已齐备' : '未完成'}`);

  if (missingFields.length) {
    lines.push(
      `待补档案字段（不用逐项追问，用户会自己补）：${missingFields.join('、')}`,
    );
  }

  const fillable = (flow.fillableFields ?? []).filter((item) =>
    clean(item?.key),
  );
  if (fillable.length) {
    lines.push(
      `可回填的空字段（键=名称）：${fillable
        .map((item) => `${clean(item.key)}=${clean(item.label)}`)
        .join('、')}`,
    );
  }
  if (missingSlots.length) {
    lines.push(`待补图片库影像：${missingSlots.join('、')}`);
  }
  if (typeof flow.photoCount === 'number') {
    lines.push(`图片库现有影像：${flow.photoCount} 张`);
  }
  const openIssues = (flow.openIssues ?? []).filter(Boolean);
  if (openIssues.length) {
    lines.push(
      `待对齐疑点（只在用户要求对齐时逐条列出，不要主动展开）：${openIssues.join('；')}`,
    );
  }

  lines.push(
    flow.debugConfirmed
      ? '调试进入状态：用户已确认进入调试'
      : '调试进入状态：尚未确认，需先与用户对齐疑点',
  );
  lines.push(
    flow.debugIntegrated
      ? `调试分析：已进行 ${flow.debugRunCount ?? 0} 次，空间问题标记 ${flow.debugMarkCount ?? 0} 个`
      : '调试分析模块：尚未接入本版本工作台',
  );
  if (clean(flow.nextActionLabel)) {
    lines.push(`下一步应做：${clean(flow.nextActionLabel)}`);
  }

  return lines.join('\n');
}

/**
 * 附件载荷。kind 语义与前端一致：
 * image -> 多模态图片块；text -> 内联进提示词的纯文本；file -> 仅登记文件名。
 */
type AttachmentPayload = {
  kind?: string;
  name?: string;
  mime?: string;
  data?: string;
  text?: string;
};

export type ChatRequestBody = {
  messages?: ChatTurn[];
  context?: AssistantContext;
  attachments?: AttachmentPayload[];
};

function normalizeAttachments(raw: unknown): AttachmentPayload[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is AttachmentPayload =>
        !!item && typeof item === 'object' && !Array.isArray(item),
    )
    .slice(0, MAX_ATTACHMENTS);
}

const IMAGE_MIME_PATTERN = /^image\/(png|jpeg|jpg|webp|gif)$/i;

function safeImageMime(mime: string | undefined): string {
  const value = clean(mime).toLowerCase();
  if (value === 'image/jpg') return 'image/jpeg';
  if (IMAGE_MIME_PATTERN.test(value)) return value;
  return 'image/png';
}

/** Validate and decode chat images before either AI executor sees the payload. */
export function parseAssistantImages(raw: unknown): { mime: string; bytes: Buffer }[] {
  const attachments = normalizeAttachments(raw).filter(
    (item) => clean(item.kind) === 'image',
  );
  const decoded: { mime: string; bytes: Buffer }[] = [];
  let totalBytes = 0;

  for (const item of attachments) {
    const data = item.data;
    if (typeof data !== 'string' || !data) {
      throw new TextAIError('ATTACHMENT_INVALID', '图片附件数据无效，请重新添加后再试。');
    }
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    if (data.length % 4 !== 0) {
      throw new TextAIError('ATTACHMENT_INVALID', '图片附件数据无效，请重新添加后再试。');
    }
    const imageBytes = (data.length / 4) * 3 - padding;
    if (imageBytes > MAX_CHAT_IMAGE_BYTES) {
      throw new TextAIError('ATTACHMENT_TOO_LARGE', '单张对话图片不能超过 8 MB。');
    }
    totalBytes += imageBytes;
    if (totalBytes > MAX_CHAT_TOTAL_IMAGE_BYTES) {
      throw new TextAIError('ATTACHMENTS_TOO_LARGE', '本轮对话图片合计不能超过 24 MB，请减少图片后重试。');
    }

    const payloadEnd = data.length - padding;
    if (
      (padding && data.slice(payloadEnd).length !== padding) ||
      data.slice(0, payloadEnd).includes('=') ||
      !/^[A-Za-z0-9+/]*$/.test(data.slice(0, payloadEnd))
    ) {
      throw new TextAIError('ATTACHMENT_INVALID', '图片附件数据无效，请重新添加后再试。');
    }

    decoded.push({ mime: safeImageMime(item.mime), bytes: Buffer.from(data, 'base64') });
  }

  return decoded;
}

type StreamPayload =
  | { type: 'delta'; text: string }
  | { type: 'status'; status: string | null }
  | { type: 'done'; sessionId?: string; turns?: number }
  | { type: 'error'; code: string; message: string };

function resolveCliEntry(): string | null {
  const override = process.env.CODEBUDDY_CLI_ENTRY?.trim();
  if (override && existsSync(override)) return override;

  const candidates: string[] = [];

  try {
    const resolveFrom = createRequire(import.meta.url);
    candidates.push(resolveFrom.resolve(`${CLI_PACKAGE}/${CLI_ENTRY_RELATIVE}`));
  } catch {
    // 未作为依赖安装时忽略，继续走全局安装路径探测。
  }

  const nodeModulesRoots = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    path.join(os.homedir(), '.local', 'share', 'npm', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    path.join(process.cwd(), 'node_modules'),
    path.join(process.cwd(), '..', 'node_modules'),
  ];

  for (const root of nodeModulesRoots) {
    candidates.push(
      path.join(root, ...CLI_PACKAGE.split('/'), CLI_ENTRY_RELATIVE),
    );
  }

  return candidates.find((item) => existsSync(item)) ?? null;
}

function resolveNodeBin(): string {
  const override = process.env.CODEBUDDY_NODE_BIN?.trim();
  if (override && existsSync(override)) return override;
  return process.execPath;
}

function readCliVersion(cliEntry: string): string | undefined {
  try {
    const manifest = path.join(path.dirname(cliEntry), '..', 'package.json');
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      version?: string;
    };
    return parsed.version;
  } catch {
    return undefined;
  }
}

function formatContext(context: AssistantContext | undefined): string {
  if (!context) return '';

  const lines: string[] = [];
  const panelTitle = clean(context.panelTitle);
  if (panelTitle) lines.push(`当前资料板块：${panelTitle}`);

  // 工作流状态放在最前面，助手应当先据此判断这一步该做什么。
  const flow = formatFlow(context.flow);
  if (flow) lines.push('【工作流状态】', flow);

  const project = context.project;
  if (project) {
    const name = clean(project.name);
    const address = clean(project.address);
    if (name) lines.push(`项目名称：${name}`);
    if (address) lines.push(`项目地址：${address}`);

    const stats: string[] = [];
    if (project.facilities?.length) {
      stats.push(`${project.facilities.length} 类设施`);
    }
    if (typeof project.photoCount === 'number') {
      stats.push(`${project.photoCount} 份影像资料`);
    }
    if (typeof project.markCount === 'number') {
      stats.push(`${project.markCount} 个空间问题标记`);
    }
    if (typeof project.confirmedMarkCount === 'number') {
      stats.push(`其中已确认 ${project.confirmedMarkCount} 个`);
    }
    if (typeof project.debugRunCount === 'number') {
      stats.push(`${project.debugRunCount} 条调试任务`);
    }
    if (typeof project.planCount === 'number') {
      stats.push(`${project.planCount} 个候选方案`);
    }
    if (stats.length) lines.push(`已记录：${stats.join('、')}`);

    if (project.facilities?.length) {
      lines.push(`已登记设施：${project.facilities.join('、')}`);
    }

    const planSummaries = (project.planSummaries ?? []).filter(
      (item) => clean(item?.title),
    );
    if (planSummaries.length) {
      lines.push(
        `现有方案：${planSummaries
          .map((item, i) => `${i + 1}. ${clean(item.title)}`)
          .join('；')}`,
      );
    }

    const fields = project.fields ?? {};
    const labelled: Array<[string, string]> = [
      ['userRequirements', '村民与使用需求'],
      ['designGoals', '设计目标'],
      ['openQuestions', '待核问题'],
      ['elderPersona', '重点老人画像'],
      ['mobilityConstraints', '行动能力限制'],
      ['testGoal', '调试目标'],
      ['fieldNotes', '现场记录'],
    ];
    for (const [key, label] of labelled) {
      const value = clean(fields[key]);
      if (value) lines.push(`${label}：${value}`);
    }
  }

  const plan = context.plan;
  if (plan) {
    const labelled: Array<[keyof PlanContext, string]> = [
      ['title', '方案名称'],
      ['scene', '问题场景'],
      ['scope', '适用空间'],
      ['references', '知识依据'],
      ['innovation', '做法要点'],
      ['compliance', '合规校核'],
      ['implementation', '实施边界'],
      ['cost', '成本判断'],
      ['maintenance', '维护要求'],
      ['verification', '验证方式'],
      ['tradeoffs', '取舍说明'],
      ['body', '方案正文'],
    ];
    const entries: string[] = [];
    for (const [key, label] of labelled) {
      const value = clean(plan[key]);
      if (value) entries.push(`${label}：${value}`);
    }
    if (entries.length) lines.push('当前方案：', ...entries);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 知识库检索：按本轮问题从 knowledge/ 检索案例与条件化规则，注入提示词。
// ---------------------------------------------------------------------------

type KnowledgeBlock = { text: string; caseIds: string[]; ruleIds: string[] };

function normalizeMessages(raw: unknown): ChatTurn[] {
  return (Array.isArray(raw) ? raw : []).filter(
    (item): item is ChatTurn =>
      !!item &&
      typeof item === 'object' &&
      ((item as ChatTurn).role === 'user' || (item as ChatTurn).role === 'assistant') &&
      typeof (item as ChatTurn).text === 'string',
  );
}

/**
 * 检索用的查询文本：本轮问题为主，最近一轮用户发言与工作区字段作为补充（截断，
 * 避免档案长文本把问题本身稀释掉）。
 */
function buildKnowledgeQuery(body: ChatRequestBody): string {
  const messages = normalizeMessages(body.messages);
  const recent = messages.filter((turn) => turn.role === 'user').slice(-2);
  const question = recent.map((turn) => clean(turn.text)).filter(Boolean).join('\n');

  const parts: string[] = [];
  const project = body.context?.project;
  if (project) {
    const fields = project.fields ?? {};
    parts.push(
      ...[
        fields.userRequirements,
        fields.designGoals,
        fields.elderPersona,
        fields.mobilityConstraints,
        fields.testGoal,
        fields.fieldNotes,
        fields.openQuestions,
      ].filter(Boolean) as string[],
    );
    if (project.facilities?.length) parts.push(project.facilities.join('、'));
  }
  const plan = body.context?.plan;
  if (plan) {
    parts.push(
      ...[plan.title, plan.scene, plan.scope, plan.innovation, plan.body].filter(Boolean) as string[],
    );
  }

  const context = parts.join('\n').slice(0, KNOWLEDGE_CONTEXT_CHARS);
  return [question, context].filter(Boolean).join('\n');
}

function formatKnowledgeCase(entry: KnowledgeHit): string[] {
  const where = [entry.region, entry.location].filter(Boolean).join('·');
  const lines = [
    `- ${entry.id} ${entry.title}${where ? `（${where}${entry.period ? '，' + entry.period : ''}）` : ''}`,
  ];
  if (entry.facts) lines.push(`  案例事实：${entry.facts}`);
  if (entry.insight) lines.push(`  可迁移推论：${entry.insight}`);
  if (entry.boundary) lines.push(`  适用边界：${entry.boundary}`);
  if (entry.source_url) {
    lines.push(
      `  出处：${[entry.source_org, entry.source_title].filter(Boolean).join(' ')} ${entry.source_url}`,
    );
  }
  return lines;
}

function formatKnowledge(entries: KnowledgeHit[]): KnowledgeBlock | null {
  const cases = entries.filter((entry) => entry.kind === 'case');
  const rules = entries.filter((entry) => entry.kind === 'rule');
  if (!cases.length && !rules.length) return null;

  const lines: string[] = [
    '【知识库参考（本地案例库检索结果，仅限本轮回答使用）】',
    '使用要求：优先依据下面的案例事实作答；引用时在正文标注编号（案例 R###/P####，规则 AF-D##/PS-D##）与出处；' +
      '「案例事实」与「可迁移推论」分开表述，「适用边界」外的做法不得照搬；' +
      '库内没有的尺寸、造价、覆盖率、成效数据一律不得编造，需要现场核验的写「待核实」。',
  ];

  if (cases.length) {
    lines.push('相关案例：');
    for (const entry of cases) lines.push(...formatKnowledgeCase(entry));
  }
  if (rules.length) {
    lines.push('相关条件化经验规则（分析推论，非规范条文）：');
    for (const entry of rules) {
      const parts = [
        entry.condition ? `当：${entry.condition}` : '',
        entry.action ? `做：${entry.action}` : '',
        entry.exception ? `例外：${entry.exception}` : '',
      ].filter(Boolean);
      lines.push(`- ${entry.id} ${entry.title}（${parts.join('；')}）`);
    }
  }

  return {
    text: lines.join('\n'),
    caseIds: cases.map((entry) => entry.id),
    ruleIds: rules.map((entry) => entry.id),
  };
}

/** 检索并组装本轮的知识库参考块（导出供单测直接验证提示词内容）。 */
export async function retrieveAssistantKnowledge(body: ChatRequestBody): Promise<KnowledgeBlock | null> {
  const query = buildKnowledgeQuery(body);
  if (query.trim().length < 4) return null;
  try {
    const [cases, rules] = await Promise.all([
      searchKnowledge(query, KNOWLEDGE_CASE_LIMIT, {
        kind: 'case',
        minScore: KNOWLEDGE_MIN_SCORE,
        minTerms: KNOWLEDGE_MIN_TERMS,
      }),
      searchRules(query, KNOWLEDGE_RULE_LIMIT, {
        minScore: KNOWLEDGE_MIN_SCORE,
        minTerms: KNOWLEDGE_MIN_TERMS,
      }),
    ]);
    return formatKnowledge([...cases, ...rules]);
  } catch {
    // 知识库是增强项：检索失败不阻断对话。
    return null;
  }
}

/** 组装【工作台操作】段：<workspace-actions> 协议说明 + 依当前上下文动态生成的可用动作清单。 */
function buildActionsSection(body: ChatRequestBody): string {
  const context = body.context;
  const flow = context?.flow;
  const project = context?.project;

  const planSummaries = (project?.planSummaries ?? []).filter((item) =>
    clean(item?.title),
  );
  const planList = planSummaries.length
    ? planSummaries.map((item, index) => `${index + 1}. ${clean(item.title)}`).join('；')
    : '';

  const actions: string[] = [];
  actions.push(
    '- navigate {panel}：切换板块。panel ∈ home|workspace|archive|debug|plans',
  );

  const fillable = (flow?.fillableFields ?? []).filter((item) => clean(item?.key));
  actions.push(
    `- update_project {patch:{fields:{键:值}}}：回填档案字段。只写用户本轮明确给出的字段，键必须是下面列出的可回填空字段：${fillable.length ? fillable.map((item) => `${clean(item.key)}=${clean(item.label)}`).join('、') : '（当前没有可回填的空字段，不要输出此动作）'}`,
  );

  if (flow?.archiveReady && !flow?.debugConfirmed) {
    actions.push(
      '- update_debug {patch:{debugEntry:"confirmed"}}：确认档案无误，正式进入调试阶段（通常与 navigate {panel:"debug"} 一起输出）',
    );
  }

  if (project) {
    const photoCount =
      typeof project.photoCount === 'number' ? project.photoCount : 0;
    actions.push(
      `- run_elder_test {persona_ids?, photo_index?, task?}：打开老人视角测试并自动开跑（缺省全选老人角色、用图片库第 1 张照片）。${photoCount ? `当前图片库有 ${photoCount} 张影像。` : '注意：当前图片库为空，跑测试前需先有项目照片。'}`,
    );
  }

  actions.push(
    '- create_plan {plan:{title, body, ...}}：把分析/讨论稿生成方案并存入方案区（会自动切换过去）',
  );

  if (planList) {
    actions.push(
      `- select_plan {plan_index}：切换查看第几个方案（从 1 起）。现有方案：${planList}`,
    );
    actions.push('- set_current_plan {plan_index}：把第几个方案设为当前方案');
  }

  return [
    '【工作台操作】',
    '你可以通过 <workspace-actions>[...]</workspace-actions> 块直接操作工作台界面。块内是严格 JSON 数组，每个元素是一个动作对象（type + 参数字段），例如：',
    '<workspace-actions>[{"type":"run_elder_test","photo_index":0}]</workspace-actions>',
    '硬性规则：凡是你在正文里说「已帮你/我来/正在做」的界面操作（切板块、确认进入调试、跑测试、生成或切换方案、回填字段），都必须同时在动作块里给出对应动作——**只说不做视为失败**；没有界面操作意图时不要输出块。',
    '正文照常写给用户看，动作块不展示、不要在正文复述；动作按执行顺序排列；清单里没有的动作不要输出。',
    '当前可用动作：',
    ...actions,
  ].join('\n');
}

function buildPrompt(
  body: ChatRequestBody,
  knowledge?: KnowledgeBlock | null,
  includeActionInstructions = true,
): string {
  const messages = normalizeMessages(body.messages);
  const latest = messages[messages.length - 1];
  const question = clean(latest?.text);
  const history = messages.slice(0, -1);
  const context = formatContext(body.context);

  const sections: string[] = [];
  if (context) sections.push(`【当前工作区上下文】\n${context}`);

  // OpenAI-compatible text providers receive the dynamic action protocol in
  // the system message (see buildTextSystemPrompt).  Keeping it out of the
  // user message prevents providers with automatic image-tool routing from
  // mistaking words such as “生成/图片” in the protocol for an image request.
  if (includeActionInstructions) sections.push(buildActionsSection(body));

  if (knowledge?.text) sections.push(knowledge.text);

  if (history.length) {
    const transcript = history
      .map((turn) => `${turn.role === 'user' ? '用户' : '助手'}：${clean(turn.text)}`)
      .filter((line) => line.length > 3)
      .join('\n');
    if (transcript) sections.push(`【对话历史】\n${transcript}`);
  }

  const attachments = normalizeAttachments(body.attachments);
  const images = attachments.filter((item) => clean(item.kind) === 'image');
  const textual = attachments.filter(
    (item) => clean(item.kind) === 'text' && typeof item.text === 'string',
  );
  const opaque = attachments.filter((item) => clean(item.kind) === 'file');

  if (images.length) {
    sections.push(
      `【随本轮消息附上的图片】\n${images
        .map((item, index) => `${index + 1}. ${clean(item.name) || '未命名图片'}`)
        .join('\n')}\n请结合图片内容回答用户的问题。`,
    );
  }

  if (opaque.length) {
    sections.push(
      `【本轮附上的文件】\n${opaque
        .map((item) => `- ${clean(item.name)}（${clean(item.mime) || '未知类型'}）`)
        .join('\n')}\n这些文件的内容当前无法被读取，若用户需要分析，请说明需要其提供文本或截图。`,
    );
  }

  for (const item of textual) {
    const content = (item.text ?? '').slice(0, MAX_TEXT_ATTACHMENT_CHARS);
    sections.push(`【文件内容：${clean(item.name) || '未命名文件'}】\n${content}`);
  }

  sections.push(
    '【工作台协作规则】\n' +
      '你的目标是帮助用户形成可执行的建设方案，而不是把对话卡在固定流程。资料不完整时，明确区分“已知”和“待核实”，但仍可基于现有信息先给出讨论稿、方案骨架、优先级和下一步动作；不要因为缺字段而拒绝回答。\n' +
      '你可以通过末尾的 <workspace-actions> JSON 数组请求工作台动作。只在用户明确表达意图或你正在把本轮结论落入工作台时使用动作；每个动作都必须是高层、可逆、与当前项目相关的操作。支持：navigate（切换板块，panel 为 home/workspace/archive/debug/plans）、update_project（patch 只能包含 name/address/facilities/fields）、update_plan（planId 加 patch，只更新方案文本字段）、create_plan（plan 为完整或部分方案字段）、update_debug（patch 只能包含 debugScenarios/debugEntry）。动作块必须放在回答最后，格式严格为 <workspace-actions>[...]</workspace-actions>，不要在正文解释标签；没有动作时省略。\n' +
      '当用户只说“帮我做方案”“我什么都没填”或类似目标时，直接根据项目名称、地址、已知设施、老人画像和常见适老化原则产出一份带待核实标注的讨论稿，并用 create_plan 动作写入方案区；不要只回复缺失字段清单。',
  );

  if (!sections.length) return question;
  sections.push(`【用户本轮提问】\n${question}`);
  return sections.join('\n\n');
}

function buildTextSystemPrompt(body: ChatRequestBody): string {
  return [assistantPersona(), buildActionsSection(body)]
    .filter((part) => part.trim())
    .join('\n\n');
}

/** 组装发给 CLI 的 stream-json 用户消息内容块。 */
function buildUserBlocks(
  body: ChatRequestBody,
  knowledge?: KnowledgeBlock | null,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const attachments = normalizeAttachments(body.attachments);
  const images = attachments.filter(
    (item) => clean(item.kind) === 'image' && typeof item.data === 'string' && item.data,
  );

  const prompt = buildPrompt(body, knowledge);
  if (prompt) {
    blocks.push({ type: 'text', text: prompt });
  } else if (images.length) {
    blocks.push({ type: 'text', text: '请帮我看看本轮附上的图片。' });
  }

  for (const item of images) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: safeImageMime(item.mime),
        data: item.data,
      },
      ...(clean(item.name) ? { original_filename: clean(item.name) } : {}),
    });
  }

  return blocks;
}

/**
 * CodeBuddy 偶尔会完成正文却漏掉动作标签。只对用户明确表达的导航/产出方案
 * 意图做安全兜底，动作仍然经过前端白名单执行；不从正文猜测档案字段或删除操作。
 */
function inferActionBlock(body: ChatRequestBody, responseText: string): string {
  const latest = normalizeMessages(body.messages).at(-1);
  const question = clean(latest?.text).replace(/\s+/g, '');
  if (!question) return '';

  const panel = question.includes('方案')
    ? 'plans'
    : question.includes('调试') || question.includes('场景')
      ? 'debug'
      : question.includes('档案') || question.includes('建档')
        ? 'archive'
        : null;
  const actions: Record<string, unknown>[] = [];
  if (panel && /(切到|切换到|去|打开|进入|回到|跳到)/.test(question)) {
    actions.push({ type: 'navigate', panel });
  }

  const wantsPlan =
    /(生成|做一份|产出|制定|设计|规划|建设方案|改造方案|讨论稿|直接帮我)/.test(
      question,
    ) && /方案|改造|建设|规划/.test(question);
  const visibleText = responseText
    .replace(/<workspace-actions>[\s\S]*?<\/workspace-actions>/g, '')
    .replace(/<archive-fill>[\s\S]*?<\/archive-fill>/g, '')
    .trim();
  if (wantsPlan && visibleText.length >= 80) {
    const refining = /(优化|修改|补充|完善|调整|改写)/.test(question);
    actions.push(
      refining && (body.context?.project?.planCount ?? 0) > 0
        ? { type: 'update_plan', patch: { body: visibleText } }
        : {
            type: 'create_plan',
            plan: {
              title: 'AI 适老化建设讨论稿',
              body: visibleText,
              verification: '现场尺度、权属、排水、照度、消防与施工条件待核实。',
            },
          },
    );
  }

  return actions.length
    ? `<workspace-actions>${JSON.stringify(actions)}</workspace-actions>`
    : '';
}

function emitInferredAction(body: ChatRequestBody, responseText: string, emit: (text: string) => void) {
  if (responseText.includes('<workspace-actions>')) return;
  const block = inferActionBlock(body, responseText);
  if (block) emit(`\n\n${block}`);
}

/** 在 fastify 上以 SSE 方式执行一次对话（reply.hijack 后直接写原始响应）。 */
async function handleChat(app: FastifyInstance, body: ChatRequestBody, raw: import('node:http').ServerResponse) {
  const res = raw;

  const writeEvent = (payload: StreamPayload) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let chatImages: { mime: string; bytes: Buffer }[];
  try {
    chatImages = parseAssistantImages(body.attachments);
  } catch (error) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    writeEvent({
      type: 'error',
      code: error instanceof TextAIError ? error.code : 'ATTACHMENT_INVALID',
      message: error instanceof Error ? error.message : '图片附件无效，请重新添加后再试。',
    });
    res.end();
    return;
  }

  const knowledge = await retrieveAssistantKnowledge(body);
  const blocks = buildUserBlocks(body, knowledge);
  if (!blocks.length) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    writeEvent({
      type: 'error',
      code: 'EMPTY_PROMPT',
      message: '请输入要咨询的内容',
    });
    res.end();
    return;
  }

  let textConfig;
  try {
    textConfig = getTextAIConfig();
  } catch (error) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    writeEvent({
      type: 'error',
      code: error instanceof TextAIError ? error.code : 'CONFIG_INVALID',
      message: error instanceof Error ? error.message : '文本 AI 配置无效。',
    });
    res.end();
    return;
  }

  if (textConfig.provider === 'openai-compatible') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const controller = new AbortController();
    let streamedText = '';
    let settled = false;
    const finish = (payload: StreamPayload) => {
      if (settled) return;
      settled = true;
      writeEvent(payload);
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', abortOnDisconnect);
    writeEvent({ type: 'status', status: 'connecting' });
    try {
      await streamTextAI(
        buildPrompt(body, knowledge, false),
        chatImages,
        controller.signal,
        (delta) => {
          streamedText += delta;
          writeEvent({ type: 'delta', text: delta });
        },
        buildTextSystemPrompt(body),
      );
      emitInferredAction(body, streamedText, (text) => writeEvent({ type: 'delta', text }));
      finish({ type: 'done' });
    } catch (error) {
      if (controller.signal.aborted) return;
      finish({
        type: 'error',
        code: error instanceof TextAIError ? error.code : 'MODEL_ERROR',
        message: error instanceof Error ? error.message : 'AI 调用失败，请稍后重试。',
      });
    } finally {
      res.off('close', abortOnDisconnect);
    }
    return;
  }

  // CLI 的 stream-json 输入协议：stdin 每行一条 UserMessage。
  const inputLine = `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: blocks },
  })}\n`;

  const cliEntry = resolveCliEntry();
  if (!cliEntry) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    writeEvent({
      type: 'error',
      code: 'CLI_NOT_FOUND',
      message:
        '未找到 CodeBuddy CLI。请先安装并确保 codebuddy 可用，或用 CODEBUDDY_CLI_ENTRY 指定入口文件路径。',
    });
    res.end();
    return;
  }

  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--max-turns',
    '1',
    '--permission-mode',
    'dontAsk',
    // 纯咨询场景：不启用任何内置工具，避免 CLI 去读写工程文件。
    '--tools=',
  ];

  if (existsSync(PERSONA_FILE)) {
    args.push('--system-prompt-file', PERSONA_FILE);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const child = spawn(resolveNodeBin(), [cliEntry, ...args], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CODEBUDDY_STARTUP_PROFILE: '0',
    },
  });

  let stdoutBuffer = '';
  let stderrText = '';
  let streamedText = '';
  let sessionId: string | undefined;
  let turns: number | undefined;
  let settled = false;
  let timedOut = false;
  let sawDelta = false;
  // 文本闸门：先扣住开头一小段，确认不是基础设施报错再放行。
  let gate: 'hold' | 'open' | 'suppress' = 'hold';
  let heldText = '';
  let failureText = '';

  function flushGate() {
    if (gate !== 'hold' || !heldText) return;
    gate = 'open';
    const pending = heldText;
    heldText = '';
    streamedText += pending;
    writeEvent({ type: 'delta', text: pending });
  }

  function emitText(chunk: string) {
    if (!chunk) return;

    if (gate === 'suppress') return;

    if (gate === 'hold') {
      heldText += chunk;
      const state = leadState(heldText);
      if (state === 'pending') return;

      if (state === 'failure') {
        gate = 'suppress';
        failureText = heldText.trim();
        heldText = '';
        return;
      }

      gate = 'open';
      const pending = heldText;
      heldText = '';
      streamedText += pending;
      writeEvent({ type: 'delta', text: pending });
      return;
    }

    streamedText += chunk;
    writeEvent({ type: 'delta', text: chunk });
  }

  const timeoutMs =
    Number(process.env.CODEBUDDY_ASSISTANT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15_000);

  function finish(payload: StreamPayload) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    writeEvent(payload);
    if (!res.writableEnded) res.end();
  }

  function handleLine(line: string) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // 非 JSON 的横幅或进度输出，直接忽略。
      return;
    }

    const type = parsed.type;

    if (type === 'system') {
      const subtype = parsed.subtype;
      if (subtype === 'init' && typeof parsed.session_id === 'string') {
        sessionId = parsed.session_id;
      }
      // 只在真正进入上下文压缩时才提示，避免推送无意义的空状态。
      if (subtype === 'status' && parsed.status === 'compacting' && !streamedText) {
        writeEvent({ type: 'status', status: 'compacting' });
      }
      return;
    }

    if (type === 'stream_event') {
      const event = parsed.event as
        | {
            type?: string;
            delta?: { type?: string; text?: string; thinking?: string };
          }
        | undefined;
      if (event?.type !== 'content_block_delta') return;

      const delta = event.delta;
      if (
        delta?.type === 'text_delta' &&
        typeof delta.text === 'string' &&
        delta.text.length
      ) {
        sawDelta = true;
        emitText(delta.text);
      } else if (
        delta?.type === 'thinking_delta' &&
        typeof delta.thinking === 'string' &&
        delta.thinking.length
      ) {
        // 不再原样转发 thinking_delta：CodeBuddy CLI 会把工具调用/记忆加载等内部
        // 调试内容（文件系统路径、工具 schema 等）作为 thinking 段输出，原样展示
        // 会泄漏本机信息。模型推理与正文生成不依赖该事件，丢弃仅影响前端折叠展示，
        // 不影响 AI 回答。后续若需要展示有意义的思考过程，应先做服务端内容过滤。
      }
      return;
    }

    if (type === 'assistant') {
      // 未开启增量时的兜底：部分环境下可能只推送整条 assistant 消息。
      if (sawDelta) return;
      const message = parsed.message as
        | { content?: Array<{ type?: string; text?: string }> }
        | undefined;
      const text = (message?.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('');
      if (text.trim()) emitText(text);
      return;
    }

    if (type === 'result') {
      if (typeof parsed.session_id === 'string') sessionId = parsed.session_id;
      if (typeof parsed.num_turns === 'number') turns = parsed.num_turns;

      if (parsed.is_error === true || parsed.subtype !== 'success') {
        const errors = Array.isArray(parsed.errors)
          ? parsed.errors.filter((item): item is string => typeof item === 'string')
          : [];
        const detail =
          errors.join('；') || failureText || stderrText.trim() || '模型调用失败';

        if (isAuthError(detail) || isAuthError(stderrText)) {
          finish({ type: 'error', code: 'AUTH_REQUIRED', message: AUTH_HINT });
          return;
        }

        if (FAILURE_LEAD_PATTERN.test(detail.trimStart().toLowerCase())) {
          finish({
            type: 'error',
            code: 'PROVIDER_REJECTED',
            message:
              '模型拒绝了本次请求，通常是附件格式不受支持或内容过长，请调整后重试。',
          });
          return;
        }

        const infra = isInfraError(detail) || isInfraError(stderrText);
        finish({
          type: 'error',
          code: infra ? 'CLI_UNAVAILABLE' : 'MODEL_ERROR',
          message: infra ? `AI 服务暂时不可用：${detail}` : detail,
        });
        return;
      }

      const result = typeof parsed.result === 'string' ? parsed.result : '';
      if (!streamedText && result.trim()) {
        gate = 'open';
        emitText(result);
      }
      emitInferredAction(body, streamedText || result, emitText);
      finish({ type: 'done', sessionId, turns });
      return;
    }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line) handleLine(line);
      index = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk;
    if (stderrText.length > 8192) stderrText = stderrText.slice(-8192);
  });

  child.on('error', (error: Error) => {
    finish({
      type: 'error',
      code: 'SPAWN_FAILED',
      message: `无法启动 CodeBuddy CLI：${error.message}`,
    });
  });

  child.on('close', () => {
    if (settled) return;
    if (stdoutBuffer.trim()) handleLine(stdoutBuffer.trim());
    if (settled) return;

    if (timedOut) {
      finish({
        type: 'error',
        code: 'TIMEOUT',
        message: `模型响应超时（超过 ${Math.round(timeoutMs / 1000)} 秒），请重试或缩短问题。`,
      });
      return;
    }

    flushGate();
    if (settled) return;

    const stderr = stderrText.trim();
    if (isAuthError(stderr) || isAuthError(failureText)) {
      finish({ type: 'error', code: 'AUTH_REQUIRED', message: AUTH_HINT });
      return;
    }

    if (!streamedText.trim()) {
      const detail = failureText || stderr;
      finish({
        type: 'error',
        code: detail ? 'CLI_UNAVAILABLE' : 'EMPTY_RESPONSE',
        message: detail
          ? `AI 服务暂时不可用：${detail}`
          : '模型没有返回内容，请重试。',
      });
      return;
    }

    emitInferredAction(body, streamedText, emitText);
    finish({ type: 'done', sessionId, turns });
  });

  const abort = () => {
    if (!settled) child.kill();
  };
  res.on('close', () => {
    if (!res.writableEnded) abort();
  });

  child.stdin.end(inputLine, 'utf8');
}

/** 在 fastify 上注册协作区 AI 路由（status + chat SSE）。 */
export function registerAssistant(app: FastifyInstance) {
  app.get('/api/v1/assistant/status', async () => {
    let textAI: {
      provider: 'openai-compatible' | 'codebuddy' | null;
      protocol: 'responses' | 'chat-completions' | null;
      configured: boolean;
      available: boolean;
      model: string | null;
    };
    try {
      const config = getTextAIConfig();
      const cliEntry = config.provider === 'codebuddy' ? resolveCliEntry() : null;
      const configured = config.provider === 'codebuddy' ? Boolean(cliEntry) : config.configured;
      textAI = {
        provider: config.provider,
        protocol: config.provider === 'openai-compatible' ? config.protocol : null,
        configured,
        // This is local configuration readiness, not a live provider health check.
        available: configured,
        model: config.provider === 'codebuddy'
          ? (process.env.CODEBUDDY_MODEL?.trim() || 'deepseek-v4-flash')
          : config.model,
      };
    } catch {
      textAI = {
        provider: null,
        protocol: null,
        configured: false,
        available: false,
        model: null,
      };
    }
    const image = imageGenConfig();
    const imageConfigured = imageGenAvailable();
    return {
      available: textAI.available,
      textAI,
      imageGen: {
        executor: image.executor,
        configured: imageConfigured,
        available: imageConfigured,
        model: image.model,
        count: image.count,
      },
    };
  });

  app.post('/api/v1/assistant/chat', async (req, reply) => {
    // SSE：接管原始响应，fastify 不再序列化。
    reply.hijack();
    const body = (req.body ?? {}) as ChatRequestBody;
    await handleChat(app, body, reply.raw);
  });

  // AI 效果图：多版采样生成（现状照片 + 设计要求 → N 版概念效果图）。
  // 未配置生图模型时返回 configured:false 与配置指引，前端据此降级提示。
  app.post('/api/v1/assistant/render', async (req, reply) => {
    const body = (req.body ?? {}) as {
      photos?: { mime?: string; base64?: string }[];
      prompt?: string;
      count?: number;
    };
    if (!imageGenAvailable()) {
      return await reply.code(200).send({ configured: false, guide: imageGenGuide() });
    }
    const first = (body.photos ?? []).find(p => p.base64);
    const reference = first ? { mime: first.mime ?? 'image/png', base64: first.base64! } : null;
    const base = (body.prompt ?? '').trim();
    if (!base) return await reply.code(400).send({ error: '缺少设计要求（prompt）' });
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.on('close', abortOnDisconnect);
    try {
      const images = await generateImages({
        prompt: base,
        reference,
        count: Math.min(6, Math.max(1, Number(body.count) || imageGenConfig().count)),
        signal: controller.signal,
      });
      return await reply.code(200).send({
        configured: true,
        images: images.map(im => ({ mime: im.mime, base64: im.base64 })),
      });
    } catch (e) {
      if (controller.signal.aborted && (reply.raw.destroyed || !reply.raw.writable)) return;
      const message = e instanceof Error ? e.message : '效果图生成失败，请稍后重试';
      const isInputError = /缺少设计要求|不能超过|格式仅支持|数据格式无效/.test(message);
      return await reply.code(isInputError ? 400 : 502).send({
        error: message,
      });
    } finally {
      reply.raw.off('close', abortOnDisconnect);
    }
  });
}
