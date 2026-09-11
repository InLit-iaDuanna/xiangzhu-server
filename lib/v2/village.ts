import { z } from 'zod';
export const villageSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().min(3).max(300),
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  coordinate_system: z.literal('GCJ-02'),
  source: z.enum(['腾讯地图地址解析', '腾讯地图地点检索']),
  adcode: z.string().max(20).default(''),
  notes: z.string().max(2000).default(''),
  confirmed: z.literal(true),
});
export const initializationSchema = z.object({
  goal: z.string().trim().max(1000).default(''),
  area: z.string().trim().max(500).default(''),
  route: z.string().max(500).default(''),
  observations: z.string().max(2000).default(''),
  focus: z
    .array(z.enum(['步行通行', '休息设施', '助餐服务', '夜间照明', '公共活动']))
    .max(5)
    .default([]),
});
