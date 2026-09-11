import { createActor, createMachine } from 'xstate';
import {
  calculateRoute,
  hasMetricScale,
  metricDistance,
  roadEvents,
  type Spatial,
} from '../spatial';
import { decisionSchema, scenarioSchema, type Scenario } from './schema';
export const ENGINE_VERSION = 'v2-discrete-1';
const states = [
  'walk',
  'wait',
  'rest',
  'reroute',
  'return',
  'request_help',
  'finish',
] as const;
const machine = createMachine({
  id: 'resident',
  initial: 'wait',
  states: Object.fromEntries(
    states.map((state) => [
      state,
      {
        on: Object.fromEntries(states.map((next) => [next, { target: next }])),
      },
    ]),
  ),
});
export type Decision = {
  action: (typeof states)[number];
  target_id: string | null;
  reason: string;
};
export type ChoiceContext = {
  persona: Scenario['personas'][number];
  node_id: string;
  time: number;
  observations: string[];
  legal: Omit<Decision, 'reason'>[];
};
export type SimEvent = {
  seq: number;
  time: number;
  persona_id: string;
  node_id: string;
  action: string;
  target_id: string | null;
  reason: string;
  accepted: boolean;
  position: { x: number; y: number };
};
export type SimResult = {
  engine_version: string;
  world_version: number;
  mode: 'rules' | 'ai' | 'replay';
  scenario: Scenario;
  decisions: Decision[];
  events: SimEvent[];
  metrics: {
    completed: number;
    distance: number | null;
    max_continuous_walk: number | null;
    waiting: number | null;
    conflicts: number;
    rejected: number;
    missing_fields: string[];
  };
  trajectories: Record<string, string[]>;
};
export type Decide = (context: ChoiceContext) => Promise<Decision>;
export async function simulate(
  world: Spatial,
  input: Scenario,
  options: { decide?: Decide; replay?: Decision[]; signal?: AbortSignal } = {},
): Promise<SimResult> {
  const scenario = scenarioSchema.parse(input);
  if (scenario.world_version !== world.version)
    throw new Error('场景版本已失效');
  const s = structuredClone(world);
  for (const patch of scenario.patches) {
    const r = s.roads.find((r) => r.id === patch.road_id);
    if (!r) throw new Error('方案引用不存在的道路');
    const { road_id, ...fields } = patch;
    Object.assign(r, fields);
  }
  const ids = new Set(s.nodes.map((n) => n.id));
  for (const p of scenario.personas)
    if (!ids.has(p.start) || !ids.has(p.goal))
      throw new Error('角色起终点不存在');
  for (const r of scenario.resources)
    if (!ids.has(r.node_id)) throw new Error('资源位置不存在');
  const result: SimResult = {
    engine_version: ENGINE_VERSION,
    world_version: s.version,
    mode: options.replay ? 'replay' : options.decide ? 'ai' : 'rules',
    scenario,
    decisions: [],
    events: [],
    metrics: {
      completed: 0,
      distance: 0,
      max_continuous_walk: 0,
      waiting: 0,
      conflicts: 0,
      rejected: 0,
      missing_fields: [],
    },
    trajectories: {},
  };
  const missing = new Set<string>();
  if (!hasMetricScale(s)) missing.add('scale');
  const resources = new Map(
    scenario.resources.map((r) => [r.id, { ...r, occupied: [] as number[] }]),
  );
  let replayIndex = 0;
  const people = scenario.personas.map((p, i) => ({
    p,
    id: `npc-${i + 1}`,
    node: p.start,
    t: p.departure,
    done: false,
    walked: 0,
    total: 0,
    visited: [p.start],
    observations: [] as string[],
    actor: createActor(machine).start(),
    needsDecision: true,
    events: 0,
  }));
  const append = (a: (typeof people)[number], d: Decision, accepted = true) => {
    const n = s.nodes.find((n) => n.id === a.node)!;
    result.events.push({
      seq: result.events.length,
      time: a.t,
      persona_id: a.id,
      node_id: a.node,
      action: d.action,
      target_id: d.target_id,
      reason: d.reason,
      accepted,
      position: { x: n.x, y: n.y },
    });
    if (accepted) a.actor.send({ type: d.action });
  };
  try {
    while (people.some((a) => !a.done)) {
      options.signal?.throwIfAborted();
      const a = people
        .filter((a) => !a.done)
        .sort((x, y) => x.t - y.t || x.id.localeCompare(y.id))[0];
      if (++a.events > 256) {
        missing.add(`${a.id}:event_budget`);
        append(a, {
          action: 'request_help',
          target_id: null,
          reason: '达到事件预算，保留未完成状态',
        });
        a.done = true;
        continue;
      }
      const terminal: Omit<Decision, 'reason'> = {
        action: 'request_help',
        target_id: null,
      };
      let legal: Omit<Decision, 'reason'>[] = [
        terminal,
        { action: 'return', target_id: a.p.start },
      ];
      let reason = '';
      let next: string | undefined;
      let length = 0;
      let resource: ReturnType<typeof resources.get>;
      let resourceKind: 'seat' | 'meal' | undefined;
      if (!hasMetricScale(s) || a.p.speed === null) {
        missing.add(!hasMetricScale(s) ? 'scale' : `${a.id}:speed`);
        reason = '缺少尺度或速度，无法推进物理时间';
        legal = [terminal];
      } else if (scenario.delivery) {
        legal = [{ action: 'finish', target_id: a.p.goal }, terminal];
        reason = '服务方案假设送餐已覆盖此合成角色；不计为步行到达';
      } else if (a.node === a.p.goal) {
        resourceKind = 'meal';
      } else if (a.p.max_walk !== null && a.walked >= a.p.max_walk) {
        resourceKind = 'seat';
      } else {
        const seen = s.roads.filter(
          (r) =>
            a.p.known_roads.includes(r.id) || r.a === a.node || r.b === a.node,
        );
        const observed = seen
          .filter((r) => r.a === a.node || r.b === a.node)
          .flatMap((r) =>
            roadEvents(s, r, {
              ...s.config,
              role: a.p.role,
              environment: scenario.environment,
            }),
          );
        a.observations = observed.map((e) => `${e.road}: ${e.kind}`);
        const known = {
          ...s,
          roads: seen.filter(
            (r) => r.width === null || r.width >= a.p.min_width,
          ),
        };
        const cfg = {
          ...s.config,
          start: a.node,
          end: a.p.goal,
          environment: scenario.environment,
          role: a.p.role,
          familiarity: a.p.familiarity,
          habit: a.p.habit,
        };
        const route = calculateRoute(
          known,
          cfg,
          a.p.habit.length && a.node === a.p.start ? 'habit' : 'safe',
        );
        next = route.nodes[1];
        const road = seen.find((r) => r.id === route.roads[0]);
        if (
          road &&
          (road.steps === null ||
            road.access === '未知' ||
            road.width === null ||
            !road.confirmed ||
            (scenario.environment === '夜间' && road.lit === null))
        ) {
          missing.add(`${road.id}:unverified_conditions`);
          next = undefined;
          reason = '前方道路属性待核查';
        }
        if (next) {
          length = metricDistance(
            s,
            s.nodes.find((n) => n.id === a.node)!,
            s.nodes.find((n) => n.id === next)!,
          );
          if (a.p.max_walk !== null && a.walked + length > a.p.max_walk) {
            if (a.walked === 0) {
              legal = [terminal];
              reason = '单段道路超过角色连续步行限制';
              missing.add(`${a.id}:segment_exceeds_endurance`);
            } else resourceKind = 'seat';
            next = undefined;
          } else legal.unshift({ action: 'walk', target_id: next });
        } else if (!reason) reason = '当前感知范围内没有可执行路线';
        if (observed.length) a.needsDecision = true;
        // A reroute explicitly abandons the habit path, while keeping the same observed road set.
        if (!next && a.p.habit.length && reason !== '前方道路属性待核查') {
          const alternate = calculateRoute(
            known,
            { ...cfg, habit: [] },
            'safe',
          );
          if (alternate.reachable)
            legal.unshift({ action: 'reroute', target_id: a.p.goal });
        }
      }
      if (resourceKind) {
        resource = [...resources.values()].find(
          (r) => r.node_id === a.node && r.kind === resourceKind,
        );
        if (
          !resource ||
          resource.capacity === null ||
          resource.opens === null ||
          resource.closes === null ||
          resource.duration === null
        ) {
          missing.add(`${a.node}:${resourceKind}_configuration`);
          legal = [terminal];
          reason = '设施时段、容量或服务时长未明确';
        } else {
          resource.occupied = resource.occupied.filter((t) => t > a.t);
          if (a.t + resource.duration > resource.closes) {
            reason = '本次服务将超过关闭时间';
            legal = [terminal, { action: 'return', target_id: a.p.start }];
          } else if (
            a.t < resource.opens ||
            resource.occupied.length >= resource.capacity
          ) {
            if (resource.occupied.length >= resource.capacity)
              result.metrics.conflicts++;
            legal.unshift({ action: 'wait', target_id: resource.id });
            reason = '等待设施开放或空出服务位';
            a.needsDecision = true;
          } else {
            legal.unshift({
              action: resourceKind === 'seat' ? 'rest' : 'finish',
              target_id: resource.id,
            });
            reason = '资源可用';
          }
        }
      }
      let d: Decision;
      if (a.needsDecision && (options.decide || options.replay)) {
        const context: ChoiceContext = {
          persona: a.p,
          node_id: a.node,
          time: a.t,
          observations: [...a.observations, reason].filter(Boolean),
          legal,
        };
        d = decisionSchema.parse(
          options.replay
            ? options.replay[replayIndex++]
            : await options.decide!(context),
        );
        result.decisions.push(d);
        a.needsDecision = false;
      } else d = { ...legal[0], reason: reason || '程序按合法路线推进' };
      if (
        !legal.some((x) => x.action === d.action && x.target_id === d.target_id)
      ) {
        append(a, d, false);
        result.metrics.rejected++;
        missing.add(`${a.id}:illegal_decision`);
        a.done = true;
        continue;
      }
      append(a, d);
      switch (d.action) {
        case 'walk':
          a.t += length / a.p.speed!;
          a.node = next!;
          a.walked += length;
          a.total += length;
          a.visited.push(a.node);
          result.metrics.max_continuous_walk = Math.max(
            result.metrics.max_continuous_walk!,
            a.walked,
          );
          break;
        case 'wait': {
          const end = Math.max(
            resource!.opens!,
            resource!.occupied.length >= resource!.capacity!
              ? Math.min(...resource!.occupied)
              : a.t,
          );
          result.metrics.waiting! += end - a.t;
          a.t = end;
          break;
        }
        case 'rest':
          resource!.occupied.push(a.t + resource!.duration!);
          a.t += resource!.duration!;
          a.walked = 0;
          break;
        case 'reroute':
          a.p = { ...a.p, habit: [] };
          break;
        case 'finish':
          if (resource) {
            resource.occupied.push(a.t + resource.duration!);
            a.t += resource.duration!;
          }
          result.metrics.completed++;
          a.done = true;
          break;
        case 'return': {
          const back = calculateRoute(
            {
              ...s,
              roads: s.roads.filter(
                (r) =>
                  a.p.known_roads.includes(r.id) ||
                  (a.visited.includes(r.a) && a.visited.includes(r.b)),
              ),
            },
            {
              ...s.config,
              start: a.node,
              end: a.p.start,
              role: a.p.role,
              environment: scenario.environment,
            },
            'safe',
          );
          if (!back.reachable || back.unknown || back.length === null) {
            missing.add(`${a.id}:return_route`);
          } else {
            a.total += back.length;
            a.t += back.length / a.p.speed!;
            a.visited.push(...back.nodes.slice(1));
            a.node = a.p.start;
          }
          a.done = true;
          break;
        }
        case 'request_help':
          a.done = true;
          break;
      }
    }
  } finally {
    people.forEach((a) => a.actor.stop());
  }
  for (const a of people) {
    result.trajectories[a.id] = a.visited;
    result.metrics.distance! += a.total;
  }
  if (missing.has('scale')) {
    result.metrics.distance = null;
    result.metrics.max_continuous_walk = null;
    result.metrics.waiting = null;
  }
  if ([...missing].some((x) => x.endsWith(':speed')))
    result.metrics.waiting = null;
  result.metrics.missing_fields = [...missing].sort();
  if (options.replay && replayIndex !== options.replay.length)
    throw new Error('决策日志与输入不匹配');
  return result;
}
export function exampleScenarios(world: Spatial): Scenario[] {
  const personas = Array.from({ length: 6 }, (_, i) => ({
    name: [
      '助行器使用者',
      '中途需要休息',
      '偏好熟悉路线',
      '早到用餐者',
      '拄杖出行者',
      '晚到用餐者',
    ][i],
    synthetic: true as const,
    source: '合成测试假设，不代表真实老人',
    departure: i < 3 ? 0 : (i - 2) * 120,
    min_width: i % 3 === 0 ? 1.5 : 0,
    start: world.nodes[0]?.id ?? 'n1',
    goal:
      world.nodes.find((n) => n.name.includes('助餐'))?.id ??
      world.nodes.at(-1)?.id ??
      'n8',
    role: (['使用助行器', '耐力较弱', '独立步行'] as const)[i % 3],
    speed: 0.8,
    max_walk: i % 3 === 1 ? 180 : 600,
    familiarity: '熟悉' as const,
    habit: [],
    known_roads: world.roads.map((r) => r.id),
  }));
  const common = {
    world_version: world.version,
    environment: '雨后' as const,
    personas,
    resources: world.resources?.length
      ? world.resources
      : [
          {
            id: 'meal',
            node_id: personas[0].goal,
            kind: 'meal' as const,
            capacity: 2,
            opens: 0,
            closes: 7200,
            duration: 300,
            source: '演示假设：两个服务位',
          },
        ],
    assumptions: [
      '全部角色、速度、开放时段及容量为合成假设',
      '角色预先了解示例路网',
    ],
    delivery: false,
  };
  return [
    { ...common, name: '现状', type: 'reality', patches: [] },
    {
      ...common,
      name: '工程改善',
      type: 'engineering',
      patches: world.roads
        .filter((r) => r.steps)
        .map((r) => ({ road_id: r.id, steps: false, width: 2 })),
      resources: [
        ...common.resources,
        {
          id: 'seat',
          node_id: world.nodes[1]?.id ?? personas[0].start,
          kind: 'seat',
          capacity: 1,
          opens: 0,
          closes: 7200,
          duration: 120,
          source: '候选休息点假设',
        },
      ],
    },
    {
      ...common,
      name: '服务调整',
      type: 'service',
      patches: [],
      delivery: true,
      assumptions: [
        ...common.assumptions,
        '送餐覆盖所有合成角色，仅检验出行需求变化，不推算送餐运力',
      ],
    },
  ];
}
