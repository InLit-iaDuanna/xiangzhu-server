import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type CodeBuddyImage = { mime: string; bytes: Buffer };
export type CodeBuddyOutput = { text: string; usage: unknown; model: string };

const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_TIMEOUT_MS = 240_000;
const MAX_STDOUT_BYTES = 4_000_000;
const CLI_PACKAGE_REL = join('node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');

// 全局 npm 根目录推导结果缓存，避免每次调用都拉起 npm 子进程。
let globalRootCache: string | null | undefined;

function npmGlobalRoot(): string | undefined {
  if (globalRootCache !== undefined) return globalRootCache ?? undefined;
  const run = (bin: string, args: string[]) =>
    execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    // Windows 下 npm 是 .cmd，需经 cmd.exe 调用；命令固定，无可信输入进入 shell。
    globalRootCache =
      process.platform === 'win32'
        ? run('cmd.exe', ['/d', '/s', '/c', 'npm root -g'])
        : run('npm', ['root', '-g']);
  } catch {
    globalRootCache = null;
  }
  return globalRootCache ?? undefined;
}

export function resolveCodeBuddyEntry(): string {
  const override = process.env.CODEBUDDY_BIN;
  if (override && existsSync(override)) return override;
  if (process.env.APPDATA) {
    const candidate = join(process.env.APPDATA, 'npm', CLI_PACKAGE_REL);
    if (existsSync(candidate)) return candidate;
  }
  const root = npmGlobalRoot();
  if (root) {
    const candidate = join(root, '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    '未找到 CodeBuddy CLI 入口：请全局安装 @tencent-ai/codebuddy-code，或通过 CODEBUDDY_BIN 指定 bin/codebuddy 路径',
  );
}

export function buildStreamJsonMessage(
  prompt: string,
  images: CodeBuddyImage[] = [],
): string {
  const content: unknown[] = [{ type: 'text', text: prompt }];
  for (const image of images)
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mime,
        data: image.bytes.toString('base64'),
      },
    });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : trimmed;
}

export function parseCodeBuddyOutput(stdout: string): CodeBuddyOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('CodeBuddy CLI 输出不是合法 JSON');
  }
  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const result = findEntry(entries, (entry) => entry.type === 'result');
  if (!result) throw new Error('CodeBuddy CLI 输出缺少 result 条目');
  if (result.is_error === true)
    throw new Error(
      `CodeBuddy CLI 返回错误：${asText(result.result).slice(0, 500)}`,
    );
  const assistant = findEntry(
    entries,
    (entry) => entry.type === 'message' && entry.role === 'assistant',
  );
  return {
    text: stripMarkdownFence(asText(result.result)),
    usage: result.usage ?? assistant?.usage ?? null,
    model: asText(result.model) || asText(assistant?.model),
  };
}

type CliEntry = Record<string, unknown>;

function findEntry(
  entries: unknown[],
  predicate: (entry: CliEntry) => boolean,
): CliEntry | undefined {
  for (const entry of entries)
    if (entry && typeof entry === 'object' && predicate(entry as CliEntry))
      return entry as CliEntry;
  return undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
}

export async function runCodeBuddy(
  prompt: string,
  signal: AbortSignal | undefined,
  images: CodeBuddyImage[] = [],
): Promise<CodeBuddyOutput> {
  signal?.throwIfAborted();
  const entry = resolveCodeBuddyEntry();
  const model = process.env.CODEBUDDY_MODEL ?? DEFAULT_MODEL;
  const timeout = Number(process.env.CODEBUDDY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'json',
    '--model',
    model,
    '--tools',
    '',
    '--no-session-persistence',
  ];
  const fallback = process.env.CODEBUDDY_FALLBACK_MODEL;
  if (fallback) args.push('--fallback-model', fallback);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    const child = await new Promise<ChildProcessWithoutNullStreams>(
      (resolve, reject) => {
        const spawned = spawn(process.execPath, [entry, ...args], {
          cwd: process.cwd(),
          env: { ...process.env, CODEBUDDY_SKIP_GIT_BASH_CHECK: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
        spawned.once('spawn', () => resolve(spawned));
        spawned.once('error', reject);
      },
    );
    let stdout = '';
    let stderr = '';
    return await new Promise<CodeBuddyOutput>((resolve, reject) => {
      const abort = () => {
        child.kill();
        reject(
          new Error(signal?.aborted ? 'CodeBuddy CLI 已取消' : 'CodeBuddy CLI 超时'),
        );
      };
      combined.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > MAX_STDOUT_BYTES) abort();
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      child.on('error', (error) => {
        combined.removeEventListener('abort', abort);
        reject(error);
      });
      child.on('close', (code) => {
        combined.removeEventListener('abort', abort);
        if (code !== 0) {
          reject(
            new Error(
              `CodeBuddy CLI 退出码 ${code}：${stderr || stdout.slice(-500) || '无输出'}`,
            ),
          );
          return;
        }
        try {
          resolve(parseCodeBuddyOutput(stdout));
        } catch (error) {
          reject(
            new Error(
              `${error instanceof Error ? error.message : String(error)}；stderr：${stderr.slice(-500) || '无'}`,
            ),
          );
        }
      });
      child.stdin.end(buildStreamJsonMessage(prompt, images));
    });
  } finally {
    clearTimeout(timer);
  }
}
