import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  completeStructuredText,
  getTextAIConfig,
  streamTextAI,
  textAIEndpoint,
} from '../server/text-ai';
import { configuredExecutor, execute } from '../server/cli';

const { runCodeBuddyMock } = vi.hoisted(() => ({ runCodeBuddyMock: vi.fn() }));
vi.mock('../server/codebuddy', () => ({
  runCodeBuddy: runCodeBuddyMock,
  stripMarkdownFence: (text: string) => text.replace(/^```(?:json)?\s*|\s*```$/g, ''),
}));

const MOCK_KEY = 'mock-only-text-key';

function setApiEnv(protocol: 'responses' | 'chat-completions'): void {
  vi.stubEnv('TEXT_AI_PROVIDER', 'openai-compatible');
  vi.stubEnv('TEXT_API_PROTOCOL', protocol);
  vi.stubEnv('TEXT_API_BASE_URL', 'https://mock-provider.invalid/v1/');
  vi.stubEnv('TEXT_API_KEY', MOCK_KEY);
  vi.stubEnv('TEXT_API_MODEL', 'mock-model');
  vi.stubEnv('TEXT_API_TIMEOUT_MS', '5000');
  vi.stubEnv('AI_EXECUTOR', '');
  vi.stubEnv('CODEX_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(text: string, splitAt = Math.floor(text.length / 2)): Response {
  const encoder = new TextEncoder();
  const chunks = [text.slice(0, splitAt), text.slice(splitAt)].filter(Boolean);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function mockFetch(response: Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  runCodeBuddyMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('text AI configuration', () => {
  it('defaults to API and gives TEXT_API_* precedence over legacy aliases', () => {
    vi.stubEnv('TEXT_API_PROVIDER', '');
    vi.stubEnv('AI_EXECUTOR', '');
    vi.stubEnv('TEXT_API_KEY', 'new-key');
    vi.stubEnv('CODEX_API_KEY', 'old-key');
    vi.stubEnv('TEXT_API_MODEL', 'new-model');
    vi.stubEnv('CODEX_API_MODEL', 'old-model');
    vi.stubEnv('TEXT_API_PROTOCOL', 'responses');

    expect(getTextAIConfig()).toMatchObject({
      provider: 'openai-compatible',
      protocol: 'responses',
      apiKey: 'new-key',
      model: 'new-model',
    });
    expect(configuredExecutor()).toBe('codex');
  });

  it('preserves explicit legacy executor choices and fails closed on invalid values', () => {
    vi.stubEnv('TEXT_AI_PROVIDER', '');
    vi.stubEnv('AI_EXECUTOR', 'codebuddy');
    expect(getTextAIConfig().provider).toBe('codebuddy');
    expect(configuredExecutor()).toBe('codebuddy');

    vi.stubEnv('AI_EXECUTOR', 'unexpected-provider');
    expect(() => getTextAIConfig()).toThrow(/AI_EXECUTOR 旧值无效/);
  });

  it('joins the selected API endpoint after the versioned base URL', () => {
    setApiEnv('chat-completions');
    const config = getTextAIConfig();
    expect(textAIEndpoint(config)).toBe('https://mock-provider.invalid/v1/chat/completions');
  });
});

describe('OpenAI-compatible streaming', () => {
  it.each(['responses', 'chat-completions'] as const)(
    'maps %s stream chunks into text deltas and builds its multimodal request',
    async (protocol) => {
      setApiEnv(protocol);
      const frame = protocol === 'responses'
        ? 'data: {"type":"response.output_text.delta","delta":"你好"}\n\ndata: {"type":"response.completed"}\n\n'
        : 'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
      const fetchMock = mockFetch(sseResponse(frame, 11));
      const deltas: string[] = [];
      await streamTextAI(
        '请看图',
        [{ mime: 'image/png', bytes: Buffer.from('synthetic-image') }],
        undefined,
        (delta) => deltas.push(delta),
        '乡筑 persona',
      );

      expect(deltas.join('')).toBe('你好');
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe(`https://mock-provider.invalid/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${MOCK_KEY}`);
      const request = JSON.parse(String(init?.body));
      if (protocol === 'responses') {
        expect(request.instructions).toBe('乡筑 persona');
        expect(request.input[0].content[0]).toMatchObject({ type: 'input_text', text: '请看图' });
        expect(request.input[0].content[1].type).toBe('input_image');
      } else {
        expect(request.messages[0]).toMatchObject({ role: 'system', content: '乡筑 persona' });
        expect(request.messages[1].content[0]).toMatchObject({ type: 'text', text: '请看图' });
        expect(request.messages[1].content[1].type).toBe('image_url');
      }
    },
  );

  it.each([
    [401, 'AUTH_REQUIRED'],
    [429, 'RATE_LIMITED'],
    [503, 'UPSTREAM_UNAVAILABLE'],
  ] as const)('maps HTTP %s to a safe error without provider fallback', async (status, code) => {
    setApiEnv('responses');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: MOCK_KEY } }, status)));
    await expect(streamTextAI('hello', [], undefined, () => undefined)).rejects.toMatchObject({ code });
    expect(runCodeBuddyMock).not.toHaveBeenCalled();
  });

  it('keeps the persona out of SSE deltas and does not expose upstream error text', async () => {
    setApiEnv('responses');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: MOCK_KEY } }, 401)));
    const error = await streamTextAI('hello', [], undefined, () => undefined).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(String(error)).not.toContain(MOCK_KEY);
  });

  it('distinguishes caller cancellation from the configured stream timeout', async () => {
    setApiEnv('responses');
    vi.stubEnv('TEXT_API_TIMEOUT_MS', '20');
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await expect(streamTextAI('hello', [], undefined, () => undefined)).rejects.toMatchObject({ code: 'TIMEOUT' });

    vi.stubEnv('TEXT_API_TIMEOUT_MS', '5000');
    const caller = new AbortController();
    const pending = streamTextAI('hello', [], caller.signal, () => undefined);
    setTimeout(() => caller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('reports a stream that ends without a provider completion event', async () => {
    setApiEnv('responses');
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    )));
    await expect(streamTextAI('hello', [], undefined, () => undefined))
      .rejects.toMatchObject({ code: 'UPSTREAM_INCOMPLETE' });
  });

  it('maps provider stream rejection categories without exposing upstream text', async () => {
    setApiEnv('responses');
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(
      'data: {"type":"error","error":{"code":"model_not_supported","message":"secret provider detail"}}\n\n',
    )));
    const error = await streamTextAI('hello', [], undefined, () => undefined)
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: 'UPSTREAM_REJECTED',
      message: '文本 AI 服务拒绝了请求，请检查模型、协议或请求参数。',
    });
    expect(String(error)).not.toContain('secret provider detail');
  });
});

describe('structured generation', () => {
  const schema = z.object({ answer: z.string() });

  it.each(['responses', 'chat-completions'] as const)(
    'sends %s JSON Schema and image input',
    async (protocol) => {
      setApiEnv(protocol);
      const payload = protocol === 'responses'
        ? { output_text: '{"answer":"ok"}', usage: { total_tokens: 3 } }
        : { choices: [{ message: { content: '{"answer":"ok"}' } }], usage: { total_tokens: 3 } };
      const fetchMock = mockFetch(jsonResponse(payload));
      const result = await completeStructuredText(
        '只按事实输出',
        z.toJSONSchema(schema),
        [{ mime: 'image/jpeg', bytes: Buffer.from('synthetic') }],
      );
      expect(result.text).toBe('{"answer":"ok"}');
      const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      if (protocol === 'responses') {
        expect(request.text.format).toMatchObject({ type: 'json_schema', strict: true });
        expect(request.input[0].content[1].type).toBe('input_image');
      } else {
        expect(request.response_format).toMatchObject({
          type: 'json_schema',
          json_schema: { strict: true, name: 'xiangzhu_result' },
        });
        expect(request.response_format.json_schema).not.toHaveProperty('type');
        expect(request.messages[1].content[1].type).toBe('image_url');
      }
    },
  );

  it('retries Chat Completions once without unsupported response_format', async () => {
    setApiEnv('chat-completions');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'unsupported_parameter', param: 'response_format' } }, 400))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '{"answer":"ok"}' } }] }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const result = await completeStructuredText('prompt', z.toJSONSchema(schema));
    expect(result.text).toBe('{"answer":"ok"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(retry).not.toHaveProperty('response_format');
  });

  it('validates and repairs structured output once before returning it', async () => {
    setApiEnv('responses');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ output_text: '{"answer":12}' }))
      .mockResolvedValueOnce(jsonResponse({ output_text: '{"answer":"fixed"}' }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await expect(execute('codex', { question: 'q' }, schema)).resolves.toEqual({ answer: 'fixed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('distinguishes structured API timeout from caller cancellation', async () => {
    setApiEnv('responses');
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
      else signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    vi.stubEnv('TEXT_API_TIMEOUT_MS', '10');
    await expect(completeStructuredText('prompt', z.toJSONSchema(schema)))
      .rejects.toMatchObject({ code: 'TIMEOUT' });

    vi.stubEnv('TEXT_API_TIMEOUT_MS', '5000');
    const caller = new AbortController();
    const pending = completeStructuredText('prompt', z.toJSONSchema(schema), [], caller.signal);
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not fall back to CodeBuddy when the API is unconfigured or rejects a request', async () => {
    setApiEnv('responses');
    vi.stubEnv('TEXT_API_KEY', '');
    expect(configuredExecutor()).toBe('codex');
    await expect(execute(configuredExecutor(), {}, schema)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(runCodeBuddyMock).not.toHaveBeenCalled();

    vi.stubEnv('TEXT_API_KEY', MOCK_KEY);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'secret text must not escape' } }, 401)));
    await expect(execute(configuredExecutor(), {}, schema)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(runCodeBuddyMock).not.toHaveBeenCalled();
  });
});
