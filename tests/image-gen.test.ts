import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateImages } from '../server/image-gen';

const MOCK_KEY = 'mock-only-image-key';

function setImageEnv(): void {
  vi.stubEnv('IMAGE_EXECUTOR', 'openai-compatible');
  vi.stubEnv('IMAGE_API_BASE_URL', 'https://mock-image.invalid/v1/');
  vi.stubEnv('IMAGE_API_KEY', MOCK_KEY);
  vi.stubEnv('IMAGE_MODEL', 'mock-image-model');
  vi.stubEnv('IMAGE_API_TIMEOUT_MS', '5000');
}

function setChugaoEnv(): void {
  vi.stubEnv('IMAGE_EXECUTOR', 'chugao');
  vi.stubEnv('IMAGE_API_BASE_URL', 'https://chugao.invalid/api/v1');
  vi.stubEnv('IMAGE_API_KEY', MOCK_KEY);
  vi.stubEnv('IMAGE_MODEL', 'gpt-image-2');
  vi.stubEnv('IMAGE_API_TIMEOUT_MS', '5000');
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('OpenAI-compatible image generation', () => {
  it('uses images/edits for a reference and returns its generated base64', async () => {
    setImageEnv();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ data: [{ b64_json: 'mock-image-data' }] }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const result = await generateImages({
      prompt: '合成场景测试',
      reference: { mime: 'image/png', base64: Buffer.from('synthetic').toString('base64') },
      count: 1,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://mock-image.invalid/v1/images/edits');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${MOCK_KEY}`);
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('model')).toBe('mock-image-model');
    expect((init.body as FormData).get('n')).toBe('1');
    expect(result).toEqual([{ mime: 'image/png', base64: 'mock-image-data' }]);
  });

  it('fails explicitly on reference edits errors without switching to generations', async () => {
    setImageEnv();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ error: { message: MOCK_KEY } }, 401));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await expect(generateImages({
      prompt: '合成场景测试',
      reference: { mime: 'image/jpeg', base64: Buffer.from('synthetic').toString('base64') },
      count: 1,
    })).rejects.toThrow('生图服务鉴权失败');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/images/edits');
  });

  it.each([
    [401, '生图服务鉴权失败'],
    [429, '生图服务限流'],
    [503, '生图服务暂时不可用'],
  ] as const)('maps image API HTTP %s to a safe error', async (status, message) => {
    setImageEnv();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ error: { message: MOCK_KEY } }, status));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const error = await generateImages({ prompt: '合成场景测试', count: 1 })
      .catch((reason: unknown) => reason);
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain(MOCK_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses images/generations only when no reference image was provided', async () => {
    setImageEnv();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ data: [{ b64_json: 'generated' }] }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await expect(generateImages({ prompt: '合成场景测试', count: 1 })).resolves.toEqual([
      { mime: 'image/png', base64: 'generated' },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://mock-image.invalid/v1/images/generations');
  });

  it('clamps requested image count to six parallel single-image requests', async () => {
    setImageEnv();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ data: [{ b64_json: 'generated' }] }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const result = await generateImages({ prompt: '合成场景测试', count: 99 });
    expect(result).toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ n: 1 });
    }
  });

  it('rejects unsupported or oversized reference input before making a request', async () => {
    setImageEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await expect(generateImages({
      prompt: '合成场景测试',
      reference: { mime: 'image/gif', base64: 'aGVsbG8=' },
      count: 1,
    })).rejects.toThrow('仅支持 PNG、JPEG 或 WebP');
    await expect(generateImages({
      prompt: '合成场景测试',
      reference: { mime: 'image/png', base64: 'a'.repeat(14 * 1024 * 1024) },
      count: 1,
    })).rejects.toThrow('不能超过 10 MB');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts pending provider requests on timeout', async () => {
    setImageEnv();
    vi.stubEnv('IMAGE_API_TIMEOUT_MS', '10');
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
      else signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await expect(generateImages({ prompt: '合成场景测试', count: 1 })).rejects.toThrow('超时');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts pending provider requests when the caller cancels', async () => {
    setImageEnv();
    const caller = new AbortController();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
      else signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const pending = generateImages({ prompt: '合成场景测试', count: 1, signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toThrow('生图请求已取消');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid provider response without returning an empty success', async () => {
    setImageEnv();
    vi.stubGlobal('fetch', vi.fn(async () => response({ data: [{}] })) as unknown as typeof fetch);
    await expect(generateImages({ prompt: '合成场景测试', count: 1 }))
      .rejects.toThrow('未返回图片数据');
  });
});

describe('Chugao image generation', () => {
  it('uses the Chugao generations contract and maps nested image data', async () => {
    setChugaoEnv();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({
      ok: true,
      data: {
        status: 'SUCCEEDED',
        images: [{ b64_json: 'chugao-image', mimeType: 'image/png' }],
      },
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await expect(generateImages({ prompt: '合成场景测试', count: 1 })).resolves.toEqual([
      { mime: 'image/png', base64: 'chugao-image' },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://chugao.invalid/api/v1/generations?wait=false');
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({ modelId: 'gpt-image-2', n: 1, size: '1024x1024' });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(`Bearer ${MOCK_KEY}`);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toMatch(/^xiangzhu-/);
  });

  it('uploads a reference image before a Chugao reference generation', async () => {
    setChugaoEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ data: { key: 'ref-key' } }))
      .mockResolvedValueOnce(response({ data: { status: 'SUCCEEDED', images: [{ b64_json: 'edited' }] } }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await expect(generateImages({
      prompt: '参考图改造',
      reference: { mime: 'image/png', base64: Buffer.from('synthetic').toString('base64') },
      count: 1,
    })).resolves.toEqual([{ mime: 'image/png', base64: 'edited' }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://chugao.invalid/api/v1/uploads');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://chugao.invalid/api/v1/generations?wait=false');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ referenceImageKeys: ['ref-key'] });
  });

  it('polls a Chugao 202 task until the image is available', async () => {
    setChugaoEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'task-1', status: 'QUEUED' } }), { status: 202 }))
      .mockResolvedValueOnce(response({ data: { id: 'task-1', status: 'SUCCEEDED', images: [{ b64_json: 'polled' }] } }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await expect(generateImages({ prompt: '轮询测试', count: 1 })).resolves.toEqual([
      { mime: 'image/png', base64: 'polled' },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/generations?wait=false');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/generations/task-1');
  });
});
