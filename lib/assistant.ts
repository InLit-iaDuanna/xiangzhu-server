/**
 * 协作区 AI 的前端调用层。
 *
 * 请求经由开发服务器中间件 `/api/assistant` 转发给本机 CodeBuddy CLI，
 * 服务端以 SSE 逐段回推文本，这里负责解析并回调给界面。
 */

import {
  OFFICE_EXTENSIONS,
  extractOfficeText,
  type OfficeExtension,
} from './ooxml';

export type AssistantTurn = { role: 'user' | 'assistant'; text: string };

export type AssistantStatus = {
  available: boolean;
  cliPath: string | null;
  version: string | null;
};

export type AssistantProjectContext = {
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

export type AssistantPlanContext = {
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

/** 工作台推进状态，决定助手这一步该做什么。 */
export type AssistantFlowContext = {
  stage?: string;
  archiveReady?: boolean;
  missingFields?: string[];
  missingSlots?: string[];
  /** 允许从文档回填的空字段：键名与档案表单一一对应。 */
  fillableFields?: { key?: string; label?: string }[];
  photoCount?: number;
  /** 进入调试前需要与用户对齐的疑点。 */
  openIssues?: string[];
  debugIntegrated?: boolean;
  debugConfirmed?: boolean;
  debugRunCount?: number;
  debugMarkCount?: number;
  nextActionLabel?: string;
};

export type AssistantContext = {
  panel?: string;
  panelTitle?: string;
  project?: AssistantProjectContext;
  plan?: AssistantPlanContext;
  flow?: AssistantFlowContext;
};

export class AssistantError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AssistantError';
    this.code = code;
  }
}

/**
 * 附件能力边界：
 * - image：以多模态图片块发送，模型可以直接看图；
 * - text：读取为纯文本内联进提示词（含 docx / xlsx / pptx 的正文提取）；
 * - file：暂不支持解析该格式，仅把文件名与类型告知模型。
 */
export type AssistantAttachmentKind = 'image' | 'text' | 'file';

export type AssistantAttachment = {
  kind: AssistantAttachmentKind;
  name: string;
  mime: string;
  /** 图片附件：base64（不含 data: 前缀）。 */
  data?: string;
  /** 文本附件：原文。 */
  text?: string;
};

/** 可直接读取为纯文本的扩展名。 */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'geojson',
  'xml',
  'yml',
  'yaml',
  'log',
  'ini',
  'conf',
  'sql',
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'ts',
  'tsx',
]);

const OOXML_EXTENSIONS = new Set<string>(OFFICE_EXTENSIONS);

/** 提取出的文档正文长度上限，避免单次请求携带过长文本。 */
const MAX_EXTRACTED_CHARS = 80_000;

export const ATTACHMENT_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.tsv,.json,.xml,.yml,.yaml,.log';

export const MAX_ATTACHMENT_COUNT = 8;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export type DraftAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AssistantAttachmentKind;
  /** 图片缩略图，直接复用 base64，避免额外的对象 URL 生命周期管理。 */
  preview?: string;
  data?: string;
  text?: string;
};

function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

export function classifyFile(file: File): AssistantAttachmentKind {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('text/')) return 'text';
  if (file.type === 'application/json' || file.type === 'application/xml') {
    return 'text';
  }
  if (TEXT_EXTENSIONS.has(fileExtension(file.name))) return 'text';
  if (OOXML_EXTENSIONS.has(fileExtension(file.name))) return 'text';
  return 'file';
}

function canDecodeImage(dataUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve(true);
    probe.onerror = () => resolve(false);
    probe.src = dataUrl;
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** 把用户选择的文件读成可传输的附件；无法读取的格式退回为 file 类型。 */
export async function readAttachment(file: File): Promise<DraftAttachment> {
  const kind = classifyFile(file);
  const base: DraftAttachment = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    kind,
  };

  try {
    if (kind === 'image') {
      const data = arrayBufferToBase64(await file.arrayBuffer());
      const preview = `data:${base.mime};base64,${data}`;
      // 先确认能解码：损坏或伪造的图片会让模型直接拒绝整次请求。
      if (!(await canDecodeImage(preview))) return { ...base, kind: 'file' };
      return { ...base, data, preview };
    }

    if (kind === 'text') {
      const extension = fileExtension(file.name);
      if (OOXML_EXTENSIONS.has(extension)) {
        const extracted = await extractOfficeText(
          await file.arrayBuffer(),
          extension as OfficeExtension,
        );
        if (!extracted.trim()) return { ...base, kind: 'file' };
        return { ...base, text: extracted.slice(0, MAX_EXTRACTED_CHARS) };
      }

      const text = await file.text();
      return { ...base, text };
    }
  } catch {
    // 读取失败（文件被移走、权限变化等）时退化为仅登记文件名，避免中断整批附件。
    return { ...base, kind: 'file' };
  }

  return base;
}

export function toPayloadAttachments(
  drafts: DraftAttachment[],
): AssistantAttachment[] {
  return drafts.map((item) => ({
    kind: item.kind,
    name: item.name,
    mime: item.mime,
    data: item.data,
    text: item.text,
  }));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export { formatFileSize };

// V3 统一 AI 通道：改走 fastify 后端（经 /api 代理到 :4100），不再依赖 Vite 插件。
const ENDPOINT = '/api/v1/assistant';

export async function getAssistantStatus(
  signal?: AbortSignal,
): Promise<AssistantStatus> {
  try {
    const response = await fetch(`${ENDPOINT}/status`, { signal });
    if (!response.ok) return { available: false, cliPath: null, version: null };
    const data = (await response.json()) as Partial<AssistantStatus>;
    return {
      available: Boolean(data.available),
      cliPath: data.cliPath ?? null,
      version: data.version ?? null,
    };
  } catch {
    return { available: false, cliPath: null, version: null };
  }
}

/**
 * 文档回填数据块。模型把它附在回答末尾，界面解析后自动填入档案，
 * 并在展示时整段去掉，因此正文里不会出现这些字段的复述。
 */
const ARCHIVE_FILL_PATTERN = /<archive-fill>([\s\S]*?)(?:<\/archive-fill>|$)/;

/** 去掉回填数据块；流式尚未闭合时也会截掉，避免半截标签闪现在正文里。 */
export function stripArchiveFill(text: string): string {
  return text.replace(ARCHIVE_FILL_PATTERN, '').trimEnd();
}

/** 解析回填数据；格式异常时返回空对象，不影响正常回答。 */
export function parseArchiveFill(text: string): Record<string, string> {
  const match = /<archive-fill>([\s\S]*?)<\/archive-fill>/.exec(text);
  if (!match) return {};

  try {
    const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) {
        result[key] = value.trim();
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        result[key] = String(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}

export type StreamAssistantOptions = {
  messages: AssistantTurn[];
  context?: AssistantContext;
  attachments?: AssistantAttachment[];
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onThinking?: (text: string) => void;
  onStatus?: (status: string | null) => void;
};

export async function streamAssistant(
  options: StreamAssistantOptions,
): Promise<void> {
  const { messages, context, attachments, signal, onDelta, onThinking, onStatus } =
    options;

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, context, attachments }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AssistantError(
      'NETWORK',
      '无法连接本地 AI 服务，请确认开发服务器正在运行。',
    );
  }

  if (!response.ok || !response.body) {
    throw new AssistantError(
      'HTTP_ERROR',
      `AI 服务返回异常（HTTP ${response.status}）。`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let failure: AssistantError | null = null;

  const consume = (block: string) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (!data) return;

    let event: { type?: string; text?: string; status?: string | null; code?: string; message?: string };
    try {
      event = JSON.parse(data) as typeof event;
    } catch {
      return;
    }

    if (event.type === 'delta' && typeof event.text === 'string') {
      onDelta(event.text);
      return;
    }
    if (event.type === 'thinking' && typeof event.text === 'string') {
      onThinking?.(event.text);
      return;
    }
    if (event.type === 'status') {
      onStatus?.(event.status ?? null);
      return;
    }
    if (event.type === 'error') {
      failure = new AssistantError(
        event.code ?? 'UNKNOWN',
        event.message ?? 'AI 调用失败',
      );
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (block.trim()) consume(block);
      index = buffer.indexOf('\n\n');
    }
  }

  if (buffer.trim()) consume(buffer);
  if (failure) throw failure;
}
