import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from './db';

// Tencent's required SN protocol, not an application checksum or integrity gate.
// https://lbs.qq.com/faq/serverFaq/webServiceKey
export function signedTencentUrl(
  path: string,
  params: Record<string, string>,
  key: string,
  sk: string,
) {
  const entries = Object.entries({ ...params, key }).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const raw = entries.map(([k, v]) => `${k}=${v}`).join('&');
  const sig = createHash('md5')
    .update(`${path}?${raw}${sk}`, 'utf8')
    .digest('hex');
  const query = new URLSearchParams(entries);
  query.set('sig', sig);
  return `https://apis.map.qq.com${path}?${query}`;
}
export function registerTencentMap(app: FastifyInstance) {
  app.get('/api/v1/map/config', async () => ({
    configured: !!process.env.TENCENT_MAP_KEY,
    coordinate_system: 'GCJ-02',
  }));
  app.get('/api/v1/map/geocode', async (req) => {
    const { address, region } = z
      .object({
        address: z.string().min(3).max(200),
        region: z.string().max(80).optional(),
      })
      .parse(req.query);
    const key = process.env.TENCENT_MAP_KEY,
      sk = process.env.TENCENT_MAP_SK;
    if (!key || !sk) throw new HttpError(503, '腾讯地址服务尚未配置');
    const response = await fetch(
      signedTencentUrl(
        '/ws/geocoder/v1/',
        { address, ...(region ? { region } : {}) },
        key,
        sk,
      ),
      { signal: AbortSignal.timeout(15000) },
    );
    const data = (await response.json()) as any;
    if (data.status !== 0)
      throw new HttpError(
        502,
        `腾讯地址服务返回 ${data.status}：${data.message}`,
      );
    return {
      source: '腾讯地图地址解析',
      coordinate_system: 'GCJ-02',
      result: data.result,
    };
  });
  app.get('/api/v1/map/search', async (req) => {
    const { keyword } = z
      .object({ keyword: z.string().trim().min(2).max(80) })
      .parse(req.query);
    const key = process.env.TENCENT_MAP_KEY,
      sk = process.env.TENCENT_MAP_SK;
    if (!key || !sk) throw new HttpError(503, '腾讯地点服务尚未配置');
    const response = await fetch(
      signedTencentUrl(
        '/ws/place/v1/suggestion',
        {
          keyword,
          page_size: '6',
          page_index: '1',
          get_ad: '1',
        },
        key,
        sk,
      ),
      { signal: AbortSignal.timeout(15000) },
    );
    const data = (await response.json()) as any;
    if (data.status !== 0)
      throw new HttpError(
        502,
        `腾讯地点服务返回 ${data.status}：${data.message}`,
      );
    return {
      results: data.data.map((p: any) => ({
        id: p.id,
        title: p.title,
        address: p.address,
        location: p.location,
        ad_info: { adcode: String(p.adcode ?? '') },
        source: '腾讯地图地点检索',
      })),
    };
  });
  app.post('/api/v1/map/translate', async (req) => {
    const { points } = z
      .object({
        points: z
          .array(
            z.object({
              lat: z.number().min(-90).max(90),
              lng: z.number().min(-180).max(180),
            }),
          )
          .min(1)
          .max(40),
      })
      .parse(req.body);
    const key = process.env.TENCENT_MAP_KEY,
      sk = process.env.TENCENT_MAP_SK;
    if (!key || !sk) throw new HttpError(503, '腾讯坐标转换尚未配置');
    const response = await fetch(
      signedTencentUrl(
        '/ws/coord/v1/translate',
        {
          locations: points.map((p) => `${p.lat},${p.lng}`).join(';'),
          type: '1',
        },
        key,
        sk,
      ),
      { signal: AbortSignal.timeout(15000) },
    );
    const data = (await response.json()) as any;
    if (data.status !== 0)
      throw new HttpError(
        502,
        `腾讯坐标转换返回 ${data.status}：${data.message}`,
      );
    return { points: data.locations, coordinate_system: 'GCJ-02' };
  });
  // Fixed upstreams only; clients cannot choose a host or supply credentials.
  app.get('/api/v1/map/delegate', delegate);
  app.get('/api/v1/map/delegate/*', delegate);
  async function delegate(req: any, reply: any) {
    const key = process.env.TENCENT_MAP_KEY;
    if (!key) throw new HttpError(503, '腾讯地图尚未配置');
    const suffix = req.params['*'] ?? '';
    const upstream =
      suffix === 'checkKey'
        ? 'https://apikey.map.qq.com/mkey/index.php/mkey/check'
        : suffix === ''
          ? 'https://pr.map.qq.com/pingd'
          : null;
    if (!upstream) throw new HttpError(404, '未开放此地图服务');
    const url = new URL(upstream);
    const query = new URL(req.url, 'http://localhost').searchParams;
    for (const [k, v] of query)
      if (!['key', 'apikey', 'sig'].includes(k)) url.searchParams.set(k, v);
    url.searchParams.set('key', key);
    if (!suffix) url.searchParams.set('appid', 'jsapi_v3');
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    reply
      .header('Cache-Control', 'no-store')
      .type(response.headers.get('content-type') ?? 'application/json')
      .code(response.status);
    return reply.send(await response.text());
  }
}
