import { z } from 'zod';
export const streetMetadata = z.object({
  route: z.string().trim().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().max(100000),
  located_at: z.string().datetime(),
  note: z.string().max(1000).default(''),
  allow_model: z.boolean(),
  capture_id: z.string().uuid().optional(),
  captured_at: z.string().datetime().nullable().default(null),
  heading: z.number().min(0).max(360).nullable().optional(),
  speed: z.number().nonnegative().nullable().optional(),
  altitude: z.number().nullable().optional(),
  track: z
    .array(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracy: z.number().nonnegative(),
        located_at: z.string().datetime(),
      }),
    )
    .max(600)
    .optional(),
  interval: z.number().min(10).max(200).optional(),
});
export const streetFinding = z.object({
  image_readable: z
    .boolean()
    .describe('是否实际看到了图片内容，图片被过滤或不可读必须为false'),
  summary: z.string().max(1200),
  findings: z
    .array(
      z.object({
        observation: z.string().max(500),
        concern: z.string().max(500),
        verify: z.string().max(500),
      }),
    )
    .max(6),
  missing_fields: z.array(z.string().max(200)).max(8),
});
