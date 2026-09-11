import { randomUUID } from 'node:crypto';
import { schemas, recordInput, type Kind, type Role } from '../lib/v2/schema';
import { normalizeSpatial, type Spatial } from '../lib/spatial';
import { audit, HttpError, one, transaction, type DB } from './db';
const writers: Record<Kind, Role[]> = {
  facility: ['recorder', 'analyst', 'manager'],
  feedback: ['recorder', 'analyst', 'manager'],
  issue: ['recorder', 'analyst', 'manager'],
  observation: ['recorder', 'analyst', 'manager'],
  scenario: ['analyst', 'manager'],
  persona: ['analyst', 'manager'],
  evidence: ['analyst', 'reviewer', 'manager'],
  proposal: ['analyst', 'manager'],
  review: ['reviewer', 'manager'],
  action: ['recorder', 'manager'],
  followup: ['recorder', 'manager'],
};
export async function authorize(
  db: DB,
  user: string,
  project: string,
  roles?: Role[],
) {
  const m = await one(
    db,
    'SELECT role FROM members WHERE project_id=$1 AND user_id=$2',
    [project, user],
  );
  if (!m || (roles && !roles.includes(m.role))) {
    await audit(db, user, project, 'denied');
    throw new HttpError(403, '没有此项目的访问或操作权限');
  }
  return m.role as Role;
}
export async function projectContext(db: DB, id: string) {
  const p = await one(db, 'SELECT * FROM projects WHERE id=$1', [id]);
  if (!p) throw new HttpError(404, '项目不存在');
  return p;
}
export async function getRecord(
  db: DB,
  project: string,
  id: string,
  kind?: Kind,
) {
  const r = await one(
    db,
    'SELECT * FROM records WHERE project_id=$1 AND id=$2',
    [project, id],
  );
  if (!r || (kind && r.kind !== kind))
    throw new HttpError(404, '业务对象不存在');
  return r;
}
async function validateReferences(db: DB, project: string, kind: Kind, d: any) {
  const refs: [string, Kind][] = [];
  if (kind === 'issue') refs.push([d.feedback_id, 'feedback']);
  if (kind === 'observation') refs.push([d.issue_id, 'issue']);
  if (kind === 'review') refs.push([d.proposal_id, 'proposal']);
  if (kind === 'followup') refs.push([d.action_id, 'action']);
  if (kind === 'proposal') {
    refs.push([d.scenario_id, 'scenario']);
    for (const id of d.issue_ids) refs.push([id, 'issue']);
    for (const id of d.evidence_ids) refs.push([id, 'evidence']);
    for (const id of d.simulation_ids) {
      const run = await one(
        db,
        "SELECT id FROM runs WHERE id=$1 AND project_id=$2 AND type='simulation' AND status='completed'",
        [id, project],
      );
      if (!run) throw new HttpError(422, '推演记录不存在或尚未完成');
    }
  }
  for (const [id, k] of refs) await getRecord(db, project, id, k);
  const p = await projectContext(db, project);
  if (d.road_id && !p.spatial.roads.some((r: any) => r.id === d.road_id))
    throw new HttpError(422, '关联道路不存在');
  for (const id of d.material_ids ?? []) {
    const m = await one(
      db,
      "SELECT id FROM materials WHERE id=$1 AND project_id=$2 AND consent='allowed'",
      [id, project],
    );
    if (!m) throw new HttpError(422, '材料不存在或未授权');
  }
  if (
    kind === 'facility' &&
    !p.spatial.nodes.some((n: any) => n.id === d.node_id)
  )
    throw new HttpError(422, '设施节点不存在');
  if (kind === 'observation' && d.patch.road_id !== d.road_id)
    throw new HttpError(422, '观察与道路变更不匹配');
}
export async function saveRecord(
  db: DB,
  user: string,
  project: string,
  kind: Kind,
  raw: unknown,
  id?: string,
  within = false,
) {
  await authorize(db, user, project, writers[kind]);
  const input = recordInput.parse(raw),
    data = schemas[kind].parse(input.data);
  const work = async (tx: DB) => {
    const p = await one(tx, 'SELECT * FROM projects WHERE id=$1 FOR UPDATE', [
      project,
    ]);
    await validateReferences(tx, project, kind, data);
    const existing = id ? await getRecord(tx, project, id, kind) : null;
    if (existing && existing.version !== input.base_version)
      throw new HttpError(409, '记录已被他人修改', { current: existing });
    if (!existing && input.base_version !== 0)
      throw new HttpError(409, '新记录基础版本必须为0');
    if (kind === 'action' && !existing)
      throw new HttpError(422, '行动只能由确认方案生成');
    if (
      kind === 'evidence' &&
      (data as any).verified &&
      !['reviewer', 'manager'].includes(await authorize(tx, user, project))
    )
      throw new HttpError(403, '证据需要复核人员确认');
    if (kind === 'proposal' && (data as any).status !== 'draft')
      throw new HttpError(422, '方案状态由复核与确认操作推进');
    if (kind === 'proposal' && existing && existing.data.status === 'approved')
      throw new HttpError(409, '已确认方案不可覆盖，请创建新方案');
    if (kind === 'scenario' && (data as any).world_version !== p.version)
      throw new HttpError(409, '场景基于旧现实版本');
    if (kind === 'review' && existing)
      throw new HttpError(422, '复核记录不可覆盖，请提交新复核');
    if (kind === 'review') {
      const proposal = await getRecord(
        tx,
        project,
        (data as any).proposal_id,
        'proposal',
      );
      if (proposal.created_by === user)
        throw new HttpError(403, '请由另一位成员独立复核');
      if (proposal.stale || proposal.world_version !== p.version)
        throw new HttpError(409, '方案已失效');
      await tx.query(
        "UPDATE records SET data=jsonb_set(data,'{status}',to_jsonb($1::text)),version=version+1 WHERE id=$2",
        [
          (data as any).verdict === 'return' ? 'returned' : 'reviewed',
          proposal.id,
        ],
      );
    }
    if (
      kind === 'action' &&
      (data as any).assignee &&
      !(await one(
        tx,
        'SELECT user_id FROM members WHERE project_id=$1 AND user_id=$2',
        [project, (data as any).assignee],
      ))
    )
      throw new HttpError(422, '行动负责人不在此项目');
    if (kind === 'action' && existing) {
      const transitions: Record<string, string[]> = {
        unassigned: ['in_progress'],
        in_progress: ['followup'],
        followup: ['in_progress'],
        closed: [],
      };
      if (
        (data as any).status !== existing.data.status &&
        !transitions[existing.data.status].includes((data as any).status)
      )
        throw new HttpError(422, '该行动状态转换需要回访或不允许');
      if (
        ['proposal_id', 'title', 'type', 'description'].some(
          (k) => (data as any)[k] !== existing.data[k],
        )
      )
        throw new HttpError(422, '行动不能更换所属方案');
    }
    const recordId = id ?? input.id ?? randomUUID();
    if (existing)
      await tx.query(
        'UPDATE records SET data=$1,source=$2,version=version+1,updated_at=now(),stale=false,world_version=$3 WHERE id=$4',
        [JSON.stringify(data), input.source, p.version, recordId],
      );
    else
      await tx.query(
        'INSERT INTO records(id,project_id,kind,world_version,source,data,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          recordId,
          project,
          kind,
          p.version,
          input.source,
          JSON.stringify(data),
          user,
        ],
      );
    if (kind === 'followup') {
      const d = data as any;
      const action = await getRecord(tx, project, d.action_id, 'action');
      if (d.result === 'resolved' && action.data.status !== 'followup')
        throw new HttpError(422, '行动需先进入待回访');
      await tx.query(
        "UPDATE records SET data=jsonb_set(data,'{status}',to_jsonb($1::text)),version=version+1,updated_at=now() WHERE id=$2",
        [d.result === 'resolved' ? 'closed' : 'in_progress', d.action_id],
      );
    }
    if (existing && kind === 'scenario')
      await tx.query(
        "UPDATE runs SET status='stale',cancel_requested=true WHERE project_id=$1 AND input->>'scenario_id'=$2 AND status NOT IN ('failed','cancelled')",
        [project, recordId],
      );
    if (existing && ['evidence', 'scenario', 'issue'].includes(kind))
      await tx.query(
        "UPDATE records SET stale=true WHERE project_id=$1 AND kind='proposal' AND (data->'evidence_ids' ? $2 OR data->'issue_ids' ? $2 OR data->>'scenario_id'=$2)",
        [project, recordId],
      );
    await audit(tx, user, project, existing ? 'update' : 'create', recordId, {
      kind,
    });
    return getRecord(tx, project, recordId);
  };
  return within ? work(db) : transaction(db, work);
}
export async function saveWorld(
  db: DB,
  user: string,
  project: string,
  base: number,
  world: Spatial,
  source: string,
) {
  await authorize(db, user, project, ['analyst', 'manager']);
  return transaction(db, (tx) =>
    commitWorld(tx, user, project, base, world, source),
  );
}
export async function commitWorld(
  tx: DB,
  user: string,
  project: string,
  base: number,
  world: Spatial,
  source: string,
) {
  const p = await one(tx, 'SELECT * FROM projects WHERE id=$1 FOR UPDATE', [
    project,
  ]);
  if (p.version !== base) throw new HttpError(409, '现实版本已变化');
  const spatial = normalizeSpatial({ ...world, version: base + 1 });
  if (p.mode === 'reality' && spatial.mode === 'demo')
    throw new HttpError(422, '不能将演示地图写入现实项目');
  await tx.query('UPDATE projects SET spatial=$1,version=$2 WHERE id=$3', [
    JSON.stringify(spatial),
    base + 1,
    project,
  ]);
  await tx.query(
    'INSERT INTO world_versions(project_id,version,spatial,source,created_by) VALUES($1,$2,$3,$4,$5)',
    [project, base + 1, JSON.stringify(spatial), source, user],
  );
  await tx.query(
    "UPDATE records SET stale=true WHERE project_id=$1 AND kind IN ('scenario','proposal') AND world_version<>$2",
    [project, base + 1],
  );
  await tx.query(
    "UPDATE runs SET status='stale',cancel_requested=true,updated_at=now() WHERE project_id=$1 AND world_version<>$2 AND status NOT IN ('failed','cancelled')",
    [project, base + 1],
  );
  await audit(tx, user, project, 'world.commit', project, {
    base_version: base,
    version: base + 1,
    source,
  });
  return projectContext(tx, project);
}
export async function confirmProposal(
  db: DB,
  user: string,
  project: string,
  id: string,
  base: number,
  requestId: string,
) {
  await authorize(db, user, project, ['manager']);
  return transaction(db, async (tx) => {
    const p = await one(tx, 'SELECT * FROM projects WHERE id=$1 FOR UPDATE', [
      project,
    ]);
    const done = await one(
      tx,
      'SELECT * FROM confirmations WHERE project_id=$1 AND (request_id=$2 OR proposal_id=$3)',
      [project, requestId, id],
    );
    if (done) {
      if (done.proposal_id !== id)
        throw new HttpError(409, '请求编号已用于其他方案');
      return done.result;
    }
    const r = await getRecord(tx, project, id, 'proposal');
    if (r.version !== base || r.stale || r.world_version !== p.version)
      throw new HttpError(409, '方案或现实版本已经变化');
    const review = (
      await tx.query(
        "SELECT * FROM records WHERE project_id=$1 AND kind='review' AND data->>'proposal_id'=$2 ORDER BY created_at DESC",
        [project, id],
      )
    ).rows[0];
    if (
      !review ||
      review.created_by === r.created_by ||
      review.data.verdict !== 'pass' ||
      review.created_at < r.updated_at
    )
      throw new HttpError(422, '需要当前版本的独立通过复核');
    if (r.data.missing_fields.length)
      throw new HttpError(422, '方案仍有待核查资料');
    if (
      !r.data.evidence_ids.length &&
      r.data.tasks.some((t: any) => t.type !== 'verification')
    )
      throw new HttpError(422, '正式措施需要证据');
    for (const eid of r.data.evidence_ids) {
      const e = await getRecord(tx, project, eid, 'evidence');
      if (!e.data.verified) throw new HttpError(422, '引用证据尚未核验');
    }
    const actions = [];
    for (const t of r.data.tasks) {
      const aid = randomUUID();
      await tx.query(
        "INSERT INTO records(id,project_id,kind,world_version,source,data,created_by) VALUES($1,$2,'action',$3,'用户确认方案',$4,$5)",
        [
          aid,
          project,
          p.version,
          JSON.stringify({
            ...t,
            proposal_id: id,
            assignee: '',
            status: 'unassigned',
            notes: '',
          }),
          user,
        ],
      );
      actions.push(aid);
    }
    await tx.query(
      "UPDATE records SET data=jsonb_set(data,'{status}','\"approved\"'),version=version+1,updated_at=now() WHERE id=$1",
      [id],
    );
    const result = { action_ids: actions, proposal_id: id };
    await tx.query('INSERT INTO confirmations VALUES($1,$2,$3,$4)', [
      project,
      id,
      requestId,
      JSON.stringify(result),
    ]);
    await audit(tx, user, project, 'proposal.confirm', id, result);
    return result;
  });
}
