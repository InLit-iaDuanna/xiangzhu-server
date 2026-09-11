import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/**
 * 协作区 AI 的服务端桥接（V3 统一 AI 通道）。
 *
 * 从 plugins/assistant-api.ts（Vite 中间件）整体迁移：接收对话请求 → 以子进程方式
 * 拉起 `codebuddy -p` → 把 CLI 的 stream-json 事件转成 SSE 增量文本回推给页面。
 * 迁移后的差异：
 * - 路由挂在 fastify（:4100），前端经 /api/v1/assistant 代理访问；
 * - 免登录（stub auth）下 preHandler 自动放行；
 * - thinking_delta 不再转发（内部调试内容会泄漏本机路径等，见 handleLine 注释）；
 * - env 由 `npm run api` 的 --env-file=.env.local 提供，无需插件版 loadLocalEnv。
 */

const CLI_PACKAGE = '@tencent-ai/codebuddy-code';
const CLI_ENTRY_RELATIVE = path.join('bin', 'codebuddy');
// 携带长文档时模型需要更长思考时间，超时上限相应放宽。
const DEFAULT_TIMEOUT_MS = 300_000;

/** 单个文本附件内联进提示词时的字符上限，避免撑爆上下文。 */
const MAX_TEXT_ATTACHMENT_CHARS = 60_000;

const MAX_ATTACHMENTS = 12;

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

type ChatRequestBody = {
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

function buildPrompt(body: ChatRequestBody): string {
  const messages = (body.messages ?? []).filter(
    (item): item is ChatTurn =>
      !!item && (item.role === 'user' || item.role === 'assistant') &&
      typeof item.text === 'string',
  );

  const latest = messages[messages.length - 1];
  const question = clean(latest?.text);
  const history = messages.slice(0, -1);
  const context = formatContext(body.context);

  const sections: string[] = [];
  if (context) sections.push(`【当前工作区上下文】\n${context}`);

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

  if (!sections.length) return question;
  sections.push(`【用户本轮提问】\n${question}`);
  return sections.join('\n\n');
}

/** 组装发给 CLI 的 stream-json 用户消息内容块。 */
function buildUserBlocks(
  body: ChatRequestBody,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const attachments = normalizeAttachments(body.attachments);
  const images = attachments.filter(
    (item) => clean(item.kind) === 'image' && typeof item.data === 'string' && item.data,
  );

  const prompt = buildPrompt(body);
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

/** 在 fastify 上以 SSE 方式执行一次对话（reply.hijack 后直接写原始响应）。 */
async function handleChat(app: FastifyInstance, body: ChatRequestBody, raw: import('node:http').ServerResponse) {
  const res = raw;

  const writeEvent = (payload: StreamPayload) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const blocks = buildUserBlocks(body);
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
    const cliEntry = resolveCliEntry();
    return {
      available: Boolean(cliEntry),
      cliPath: cliEntry ?? null,
      version: cliEntry ? (readCliVersion(cliEntry) ?? null) : null,
    };
  });

  app.post('/api/v1/assistant/chat', async (req, reply) => {
    // SSE：接管原始响应，fastify 不再序列化。
    reply.hijack();
    const body = (req.body ?? {}) as ChatRequestBody;
    await handleChat(app, body, reply.raw);
  });
}
