import { z } from 'zod';
import { basisHeight } from '../spatial';
export const roleSchema = z.enum([
  'recorder',
  'analyst',
  'reviewer',
  'manager',
]);
export type Role = z.infer<typeof roleSchema>;
export const kindSchema = z.enum([
  'feedback',
  'issue',
  'observation',
  'facility',
  'scenario',
  'persona',
  'evidence',
  'proposal',
  'review',
  'action',
  'followup',
]);
export type Kind = z.infer<typeof kindSchema>;
const text = z.string().trim().min(1).max(20000);
const ids = z.array(z.string()).max(100);
export const actionSchema = z.enum([
  'walk',
  'wait',
  'rest',
  'reroute',
  'return',
  'request_help',
  'finish',
]);
export const decisionSchema = z.object({
  action: actionSchema,
  target_id: z.string().nullable(),
  reason: text,
});
export const personaSchema = z.object({
  name: text,
  synthetic: z.literal(true),
  source: text,
  start: text,
  goal: text,
  departure: z.number().nonnegative().default(0),
  min_width: z.number().nonnegative().default(0),
  role: z.enum(['使用助行器', '耐力较弱', '独立步行']),
  speed: z.number().positive().nullable(),
  max_walk: z.number().positive().nullable(),
  familiarity: z.enum(['熟悉', '不熟悉']),
  habit: ids,
  known_roads: ids,
});
export const resourceSchema = z.object({
  id: text,
  node_id: text,
  kind: z.enum(['seat', 'meal']),
  capacity: z.number().int().positive().nullable(),
  opens: z.number().nonnegative().nullable(),
  closes: z.number().nonnegative().nullable(),
  duration: z.number().positive().nullable(),
  source: text,
});
export const patchSchema = z.object({
  road_id: text,
  steps: z.boolean().nullable().optional(),
  lit: z.boolean().nullable().optional(),
  width: z.number().positive().nullable().optional(),
  access: z
    .enum([
      '未知',
      '公开通行',
      '私人使用',
      '季节性通行',
      '条件通行',
      '不可通行',
    ])
    .optional(),
});
export const scenarioSchema = z
  .object({
    name: text,
    type: z.enum(['reality', 'engineering', 'service']),
    world_version: z.number().int().nonnegative(),
    environment: z.enum(['日常', '雨后', '夜间']),
    patches: z.array(patchSchema),
    resources: z.array(resourceSchema),
    personas: z.array(personaSchema).min(1).max(8),
    assumptions: ids,
    delivery: z.boolean().default(false),
  })
  .superRefine((s, ctx) => {
    if (s.type === 'reality' && (s.delivery || s.patches.length))
      ctx.addIssue({ code: 'custom', message: '现状情景不能包含方案变更' });
    if (new Set(s.resources.map((r) => r.id)).size !== s.resources.length)
      ctx.addIssue({ code: 'custom', message: '资源编号不能重复' });
    for (const r of s.resources)
      if (r.opens !== null && r.closes !== null && r.opens >= r.closes)
        ctx.addIssue({
          code: 'custom',
          message: '设施关闭时间必须晚于开放时间',
        });
  });
export type Scenario = z.infer<typeof scenarioSchema>;
export const schemas = {
  feedback: z.object({
    text,
    location: text,
    road_id: z.string(),
    consent: z.enum(['pending', 'allowed', 'withdrawn']),
    confirmed: z.boolean(),
    material_ids: ids,
    allow_model: z.boolean(),
  }),
  issue: z.object({
    feedback_id: text,
    road_id: z.string(),
    description: text,
    status: z.enum(['pending', 'verified', 'rejected']),
    missing_fields: ids,
  }),
  observation: z.object({
    material_ids: ids.default([]),
    issue_id: text,
    road_id: text,
    observed_at: text,
    source: text,
    patch: patchSchema,
    confirmed: z.boolean(),
  }),
  facility: resourceSchema.extend({
    material_ids: ids.default([]),
    name: text,
    confirmed: z.boolean(),
    observed_at: text,
  }),
  persona: personaSchema,
  scenario: scenarioSchema,
  evidence: z.object({
    title: text,
    url: z
      .string()
      .url()
      .refine((v) => /^https?:/.test(v)),
    locator: text,
    excerpt: text,
    claim: text,
    type: z.enum(['case', 'standard', 'simulation', 'followup']),
    stage: z.enum(['planned', 'built', 'in_use', 'measured', 'not_applicable']),
    tags: ids,
    conditions: text,
    limitations: text,
    verified: z.boolean(),
    material_ids: ids,
  }),
  proposal: z.object({
    title: text,
    issue_ids: ids,
    scenario_id: text,
    evidence_ids: ids,
    changes: z.array(patchSchema),
    tasks: z
      .array(
        z.object({
          title: text,
          type: z.enum([
            'engineering',
            'maintenance',
            'service',
            'verification',
          ]),
          description: text,
        }),
      )
      .min(1),
    missing_fields: ids,
    budget: text,
    status: z.enum(['draft', 'reviewed', 'approved', 'returned']),
    simulation_ids: ids,
  }),
  review: z.object({
    proposal_id: text,
    verdict: z.enum(['pass', 'conditional', 'return']),
    notes: text,
    evidence_ids: ids,
  }),
  action: z.object({
    proposal_id: text,
    title: text,
    type: z.enum(['engineering', 'maintenance', 'service', 'verification']),
    description: text,
    assignee: z.string(),
    status: z.enum(['unassigned', 'in_progress', 'followup', 'closed']),
    notes: z.string(),
  }),
  followup: z.object({
    action_id: text,
    text,
    result: z.enum(['resolved', 'unresolved', 'reopen']),
    material_ids: ids,
    observed_at: text,
  }),
};
export type RecordObject = {
  id: string;
  project_id: string;
  kind: Kind;
  version: number;
  world_version: number;
  source: string;
  data: any;
  created_by: string;
  created_at: string;
  updated_at: string;
  stale: boolean;
};
export const recordInput = z.object({
  id: z.string().uuid().optional(),
  base_version: z.number().int().nonnegative(),
  source: text,
  data: z.unknown(),
});
export const cliReply = z.object({
  summary: z.string(),
  missing_fields: ids,
  calls: z
    .array(
      z.object({
        name: z.enum([
          'project.get_context',
          'feedback.list_related',
          'spatial.calculate_route',
          'simulation.run',
          'evidence.search',
          'evidence.read_claim',
          'plan.propose_patch',
          'task.propose_action',
        ]),
        args: z.record(z.string(), z.unknown()),
      }),
    )
    .max(6),
  proposal: schemas.proposal.nullable(),
  verdict: z.enum(['pass', 'conditional', 'return']).nullable(),
});
export const statuses: Record<string, string> = {
  queued: '排队中',
  extracting: '整理反馈',
  waiting_verification: '等待核查',
  analyzing: '空间分析',
  evidence: '查阅证据',
  planning: '形成方案',
  reviewing: '独立复核',
  awaiting_approval: '等待确认',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  stale: '版本失效',
};
export const spatialInput = z
  .object({
    mode: z.enum(['empty', 'demo', 'upload']),
    version: z.number().int().nonnegative(),
    scale: z.number().positive(),
    calibration: z
      .object({
        status: z.enum(['unknown', 'demo', 'manual', 'verified']),
        source: text,
        unit: z.literal('m'),
        scaleY: z.number().positive().optional(),
      })
      .optional(),
    // 底图真实像素尺寸；缺省时纵向基准回落 3:2（667）。
    imageSize: z
      .object({ w: z.number().positive(), h: z.number().positive() })
      .optional(),
    nodes: z
      .array(
        z.object({
          id: text,
          name: z.string(),
          x: z.number().min(0).max(1000),
          // 纵向上限随底图比例变化，此处仅设宽裕护栏，精确范围由 superRefine 按 imageSize 校验。
          y: z.number().min(0).max(4000),
        }),
      )
      .max(10000),
    roads: z
      .array(
        z.object({
          id: text,
          a: text,
          b: text,
          width: z.number().positive().nullable(),
          source: text,
          access: z.enum([
            '未知',
            '公开通行',
            '私人使用',
            '季节性通行',
            '条件通行',
            '不可通行',
          ]),
          confirmed: z.boolean(),
          steps: z.boolean().nullable(),
          lit: z.boolean().nullable(),
          status: z.enum(['candidate', 'confirmed']).optional(),
          length_m: z.number().positive().nullable().optional(),
          widthSource: z.string().max(100).optional(),
          candidateId: z.string().max(120).optional(),
          width_n: z.number().min(0).max(1).nullable().optional(),
        }),
      )
      .max(20000),
    hazards: z.array(z.object({ id: text, road: z.string() }).passthrough()),
    buildings: z.array(z.unknown()),
    config: z.object({ start: z.string(), end: z.string() }).passthrough(),
    image: z.string().max(20_000_000),
    history: z.array(z.unknown()),
    audit: z.array(z.unknown()),
  })
  .passthrough()
  .superRefine((s, ctx) => {
    const ids = new Set(s.nodes.map((n) => n.id));
    if (
      ids.size !== s.nodes.length ||
      new Set(s.roads.map((r) => r.id)).size !== s.roads.length
    )
      ctx.addIssue({ code: 'custom', message: '地图对象编号重复' });
    if (s.roads.some((r) => !ids.has(r.a) || !ids.has(r.b) || r.a === r.b))
      ctx.addIssue({ code: 'custom', message: '道路端点无效' });
    if (s.hazards.some((h) => h.road && !s.roads.some((r) => r.id === h.road)))
      ctx.addIssue({ code: 'custom', message: '风险点关联道路不存在' });
    // 纵向上界始终按基准校验：无 imageSize 时基准回落 3:2（667）。
    const basisH = basisHeight(s.imageSize);
    if (s.nodes.some((n) => n.y > basisH))
      ctx.addIssue({ code: 'custom', message: '节点坐标超出底图范围' });
  });
