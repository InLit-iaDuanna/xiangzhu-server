export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}
export async function request<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });
  // 读取原始文本：避免响应尾随空白/控制字符时 JSON.parse 抛错看不到内容。
  const raw = await response.text();
  let data: any;
  if (!raw) {
    throw new ApiError(response.status, `业务服务未连接（空响应，${response.status}）`);
  }
  try {
    data = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ApiError(
      response.status,
      `业务服务响应不是合法 JSON：${msg}；path=${path}`,
    );
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error ?? data.message ?? '请求失败',
      data.details,
    );
  return data;
}
export const api = (
  project: string,
  path: string,
  body?: unknown,
  method = body ? 'POST' : 'GET',
) =>
  request(`/api/v1/projects/${project}${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
