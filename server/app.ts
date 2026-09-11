import { registerStreet } from './street';
import { registerAssistant } from './assistant';
import { searchKnowledge, knowledgeEntries } from './knowledge';
import { villageSchema, initializationSchema } from '../lib/v2/village';
import { registerTencentMap } from './tencent-map';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  kindSchema,
  recordInput,
  roleSchema,
  spatialInput,
} from '../lib/v2/schema';
import { emptySpatial, normalizeSpatial, type Spatial } from '../lib/spatial';
import { exampleScenarios } from '../lib/v2/simulation';
import {
  authorize,
  projectContext,
  getRecord,
  saveRecord,
  saveWorld,
  commitWorld,
  confirmProposal,
} from './store';
import { audit, HttpError, one, transaction, type DB } from './db';
export type Auth = {
  handler: (r: Request) => Promise<Response>;
  api: { getSession: (o: { headers: Headers }) => Promise<any> };
};
export async function buildApp(
  db: DB,
  auth: Auth,
  options: {
    storage: string;
    origins: string[];
    createAccount?: (v: {
      email: string;
      name: string;
      password: string;
    }) => Promise<{ user: { id: string } }>;
  },
) {
  const app = Fastify({
    logger: {
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'password',
        'token',
      ],
    },
    bodyLimit: 48 * 1024 * 1024,
  });
  await app.register(cors, { origin: options.origins, credentials: true });
  await app.register(multipart, {
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await mkdir(options.storage, { recursive: true });
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof z.ZodError)
      return reply
        .code(422)
        .send({ error: '输入格式不正确', details: err.issues });
    reply.code(err.statusCode ?? 500).send({
      error: err.statusCode ? err.message : '服务处理失败，请查看运行记录',
      details: err.details,
    });
  });
  app.all('/api/auth/*', async (req, reply) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(',') : value);
    const response = await auth.handler(
      new Request(
        new URL(req.url, process.env.AUTH_URL ?? 'http://localhost:4100'),
        {
          method: req.method,
          headers,
          ...(!['GET', 'HEAD'].includes(req.method)
            ? { body: JSON.stringify(req.body) }
            : {}),
        },
      ),
    );
    reply.status(response.status);
    response.headers.forEach((v, k) => {
      if (k !== 'set-cookie') reply.header(k, v);
    });
    if (response.headers.getSetCookie().length)
      reply.header('set-cookie', response.headers.getSetCookie());
    return reply.send(await response.text());
  });
  app.get('/api/v1/health', async () => {
    await db.query('SELECT 1');
    return { status: 'ok', version: '2.0.0' };
  });
  app.post('/api/v1/invitations/accept', async (req) => {
    const b = z
      .object({
        token: z.string(),
        email: z.string().email(),
        name: z.string().min(1),
        password: z.string().min(12),
      })
      .parse(req.body);
    if (!options.createAccount) throw new HttpError(503, '账户创建不可用');
    return transaction(db, async (tx) => {
      const invitation = await one(
        tx,
        'SELECT * FROM invitations WHERE token=$1 FOR UPDATE',
        [b.token],
      );
      if (
        !invitation ||
        invitation.email !== b.email ||
        invitation.consumed ||
        new Date(invitation.expires_at) < new Date()
      )
        throw new HttpError(400, '邀请已失效或邮箱不匹配');
      const result = await options.createAccount!({
        email: b.email,
        name: b.name,
        password: b.password,
      });
      await tx.query('INSERT INTO members VALUES($1,$2,$3)', [
        invitation.project_id,
        result.user.id,
        invitation.role,
      ]);
      await tx.query('UPDATE invitations SET consumed=true WHERE token=$1', [
        b.token,
      ]);
      return { ok: true };
    });
  });
  app.addHook('preHandler', async (req) => {
    if (
      !req.url.startsWith('/api/v1/') ||
      req.url.startsWith('/api/v1/health') ||
      req.url === '/api/v1/invitations/accept'
    )
      return;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (v) headers.set(k, String(v));
    const session = await auth.api.getSession({ headers });
    if (!session) throw new HttpError(401, '请先登录');
    (req as any).user = session.user.id;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && !options.origins.includes(origin))
        throw new HttpError(403, '来源未授权');
    }
    const p = (req.params as any).project;
    if (p) await authorize(db, session.user.id, p);
  });
  registerTencentMap(app);
  registerStreet(app, db, options.storage);
  // 协作区 AI（V3 统一通道）：与调试台识别共用 fastify，走本机 CodeBuddy CLI。
  registerAssistant(app);
  app.get('/api/v1/knowledge', async (req) => {
    const q = z.object({ q: z.string().max(300).default('') }).parse(req.query);
    return searchKnowledge(q.q, 30);
  });
  app.get('/api/v1/knowledge/:id', async (req) => {
    const e = (await knowledgeEntries()).find(
      (e) => e.id === (req.params as any).id,
    );
    if (!e) throw new HttpError(404, '知识条目不存在');
    const { source_path, ...entry } = e;
    return entry;
  });
  app.get('/api/v1/me', async (req) => ({ user_id: (req as any).user }));
  // 工作台文档：前端 Project[]（档案/图片引用/调试/方案）整体存取，乐观锁防多设备互相覆盖。
  app.get('/api/v1/workspace/doc', async () => {
    const row = await one(
      db,
      "SELECT doc, version FROM workspace_docs WHERE id='default'",
    );
    return row ?? { doc: null, version: 0 };
  });
  app.put('/api/v1/workspace/doc', async (req) => {
    const b = z
      .object({
        doc: z.array(z.unknown()),
        version: z.number().int().nonnegative(),
      })
      .parse(req.body);
    const u = (req as any).user;
    return transaction(db, async (tx) => {
      const current = await one(
        tx,
        "SELECT version FROM workspace_docs WHERE id='default' FOR UPDATE",
      );
      if (!current) throw new HttpError(404, '工作台文档不存在');
      if (current.version !== b.version)
        throw new HttpError(409, '服务器上有更新的内容，请刷新页面后重试');
      await tx.query(
        "UPDATE workspace_docs SET doc=$1, version=version+1, updated_at=now() WHERE id='default'",
        [JSON.stringify(b.doc)],
      );
      await audit(tx, u, null, 'workspace.doc.save', 'default', {
        version: b.version + 1,
      });
      return { version: b.version + 1 };
    });
  });
  app.get(
    '/api/v1/projects',
    async (req) =>
      (
        await db.query(
          'SELECT p.*,m.role FROM projects p JOIN members m ON p.id=m.project_id WHERE m.user_id=$1 ORDER BY p.created_at',
          [(req as any).user],
        )
      ).rows,
  );
  app.post('/api/v1/projects', async (req) => {
    const b = z
      .object({
        name: z.string().min(1),
        mode: z.enum(['demo', 'reality']),
        spatial: spatialInput.optional(),
        geographic_location: villageSchema.optional(),
      })
      .parse(req.body);
    const user = (req as any).user;
    const id = randomUUID();
    const spatial = normalizeSpatial((b.spatial ?? emptySpatial()) as Spatial);
    if (b.mode === 'reality' && spatial.mode === 'demo')
      throw new HttpError(422, '合成资料只能导入演示项目');
    if (b.geographic_location && b.mode !== 'reality')
      throw new HttpError(422, '请将真实村庄保存为真实项目');
    spatial.version = 0;
    await transaction(db, async (tx) => {
      await tx.query(
        'INSERT INTO projects(id,name,mode,spatial,geographic_location,location_version) VALUES($1,$2,$3,$4,$5,$6)',
        [
          id,
          b.name,
          b.mode,
          JSON.stringify(spatial),
          b.geographic_location
            ? JSON.stringify({
                ...b.geographic_location,
                recorded_at: new Date().toISOString(),
                recorded_by: user,
              })
            : null,
          b.geographic_location ? 1 : 0,
        ],
      );
      await tx.query("INSERT INTO members VALUES($1,$2,'manager')", [id, user]);
      await tx.query('INSERT INTO world_versions VALUES($1,0,$2,$3,$4,now())', [
        id,
        JSON.stringify(spatial),
        '用户创建',
        user,
      ]);
    });
    if (b.mode === 'demo' && spatial.nodes.length)
      for (const sc of exampleScenarios(spatial))
        await saveRecord(db, user, id, 'scenario', {
          base_version: 0,
          source: '合成示例',
          data: sc,
        });
    return projectContext(db, id);
  });
  const path = '/api/v1/projects/:project';
  app.get(path, async (req) => projectContext(db, (req.params as any).project));
  app.put(path + '/initialization', async (req) => {
    const p = (req.params as any).project,
      u = (req as any).user;
    await authorize(db, u, p, ['manager', 'analyst']);
    const b = z
      .object({
        base_version: z.number().int().nonnegative(),
        data: initializationSchema,
      })
      .parse(req.body);
    return transaction(db, async (tx) => {
      const current = await one(
        tx,
        'SELECT * FROM projects WHERE id=$1 FOR UPDATE',
        [p],
      );
      if (!current.geographic_location)
        throw new HttpError(422, '请先确认村庄位置');
      if (current.initialization_version !== b.base_version)
        throw new HttpError(409, '档案已更新，请重新打开', { current });
      const initialization = {
        ...b.data,
        source: '用户录入，待现场核查',
        recorded_at: new Date().toISOString(),
      };
      await tx.query(
        'UPDATE projects SET initialization=$1,initialization_version=initialization_version+1 WHERE id=$2',
        [JSON.stringify(initialization), p],
      );
      await audit(tx, u, p, 'initialize_village', p, { initialization });
      return projectContext(tx, p);
    });
  });
  app.put(path + '/location', async (req) => {
    const p = (req.params as any).project,
      u = (req as any).user;
    await authorize(db, u, p, ['analyst', 'manager']);
    const b = z
      .object({
        base_version: z.number().int().nonnegative(),
        location: villageSchema,
      })
      .parse(req.body);
    return transaction(db, async (tx) => {
      const current = await one(
        tx,
        'SELECT * FROM projects WHERE id=$1 FOR UPDATE',
        [p],
      );
      if (current.mode !== 'reality')
        throw new HttpError(422, '合成项目不能保存真实村庄位置');
      if (current.location_version !== b.base_version)
        throw new HttpError(409, '村庄档案已被修改', { current });
      await tx.query(
        'UPDATE projects SET geographic_location=$1,location_version=location_version+1 WHERE id=$2',
        [
          JSON.stringify({
            ...b.location,
            recorded_at: new Date().toISOString(),
            recorded_by: u,
          }),
          p,
        ],
      );
      await audit(tx, u, p, 'save_village_location', p, {
        previous: current.geographic_location,
        location: b.location,
      });
      return projectContext(tx, p);
    });
  });
  app.get(
    path + '/members',
    async (req) =>
      (
        await db.query('SELECT user_id,role FROM members WHERE project_id=$1', [
          (req.params as any).project,
        ])
      ).rows,
  );
  app.post(path + '/invitations', async (req) => {
    const p = (req.params as any).project,
      u = (req as any).user;
    await authorize(db, u, p, ['manager']);
    const b = z
      .object({ email: z.string().email(), role: roleSchema })
      .parse(req.body);
    const token = randomUUID() + randomUUID();
    await db.query(
      "INSERT INTO invitations VALUES($1,$2,$3,$4,now()+interval '7 days',false)",
      [token, p, b.email, b.role],
    );
    await audit(db, u, p, 'invite', null, { email: b.email, role: b.role });
    return { token, expires_in_days: 7 };
  });
  app.get(path + '/records/:kind', async (req) => {
    const { project, kind } = req.params as any;
    kindSchema.parse(kind);
    return (
      await db.query(
        'SELECT * FROM records WHERE project_id=$1 AND kind=$2 ORDER BY created_at DESC',
        [project, kind],
      )
    ).rows;
  });
  app.post(path + '/records/:kind', async (req) => {
    const { project, kind } = req.params as any;
    return saveRecord(
      db,
      (req as any).user,
      project,
      kindSchema.parse(kind),
      req.body,
    );
  });
  app.put(path + '/records/:kind/:id', async (req) => {
    const { project, kind, id } = req.params as any;
    return saveRecord(
      db,
      (req as any).user,
      project,
      kindSchema.parse(kind),
      req.body,
      id,
    );
  });
  app.get(path + '/records/:kind/:id', async (req) => {
    const { project, kind, id } = req.params as any;
    return getRecord(db, project, id, kindSchema.parse(kind));
  });
  app.post(path + '/world', async (req) => {
    const b = z
        .object({
          base_version: z.number().int(),
          spatial: spatialInput,
          source: z.string().min(1),
        })
        .parse(req.body),
      p = (req.params as any).project;
    const current = await projectContext(db, p);
    if (current.mode === 'reality' && current.version > 0)
      throw new HttpError(422, '现实更新请通过已确认观察提交');
    return saveWorld(
      db,
      (req as any).user,
      p,
      b.base_version,
      b.spatial as Spatial,
      b.source,
    );
  });
  app.post(path + '/observations/:id/commit', async (req) => {
    const { project, id } = req.params as any,
      u = (req as any).user;
    await authorize(db, u, project, ['analyst', 'manager']);
    const b = z.object({ base_version: z.number().int() }).parse(req.body);
    return transaction(db, async (tx) => {
      const observation = await getRecord(tx, project, id, 'observation');
      if (!observation.data.confirmed) throw new HttpError(422, '观察尚未确认');
      const p = await projectContext(tx, project),
        world = structuredClone(p.spatial);
      const { road_id, ...patch } = observation.data.patch;
      const r = world.roads.find((r: any) => r.id === road_id);
      Object.assign(r, patch, {
        confirmed: true,
        source: observation.data.source,
      });
      return commitWorld(
        tx,
        u,
        project,
        b.base_version,
        world,
        `已确认观察 ${id}`,
      );
    });
  });
  app.post(path + '/facilities/:id/commit', async (req) => {
    const { project, id } = req.params as any,
      u = (req as any).user;
    await authorize(db, u, project, ['analyst', 'manager']);
    const b = z.object({ base_version: z.number().int() }).parse(req.body);
    return transaction(db, async (tx) => {
      const record = await getRecord(tx, project, id, 'facility');
      if (!record.data.confirmed) throw new HttpError(422, '设施调查尚未核验');
      const p = await projectContext(tx, project),
        world = structuredClone(p.spatial);
      world.resources = [
        ...(world.resources ?? []).filter((r: any) => r.id !== record.data.id),
        record.data,
      ];
      return commitWorld(
        tx,
        u,
        project,
        b.base_version,
        world,
        `已核验设施 ${id}`,
      );
    });
  });
  app.get(
    path + '/world-versions',
    async (req) =>
      (
        await db.query(
          'SELECT * FROM world_versions WHERE project_id=$1 ORDER BY version DESC',
          [(req.params as any).project],
        )
      ).rows,
  );
  app.post(path + '/proposals/:id/confirm', async (req) => {
    const { project, id } = req.params as any;
    const b = z
      .object({ base_version: z.number().int(), request_id: z.string().uuid() })
      .parse(req.body);
    return confirmProposal(
      db,
      (req as any).user,
      project,
      id,
      b.base_version,
      b.request_id,
    );
  });
  app.get(path + '/evidence', async (req) => {
    const p = (req.params as any).project,
      q = z
        .object({
          q: z.string().max(100).optional(),
          stage: z
            .enum(['planned', 'built', 'in_use', 'measured', 'not_applicable'])
            .optional(),
        })
        .parse(req.query);
    return (
      await db.query(
        "SELECT * FROM records WHERE project_id=$1 AND kind='evidence' AND (data->>'title' ILIKE $2 OR data->>'excerpt' ILIKE $2 OR data->>'tags' ILIKE $2) AND ($3::text IS NULL OR data->>'stage'=$3)",
        [p, `%${q.q ?? ''}%`, q.stage ?? null],
      )
    ).rows;
  });
  app.post(path + '/runs', async (req) => {
    const { project } = req.params as any,
      u = (req as any).user;
    await authorize(db, u, project, ['analyst', 'manager']);
    const b = z
      .object({
        type: z.enum([
          'agent',
          'simulation',
          'consultation',
          'streetwalk',
          'blueprint',
        ]),
        photo_ids: z.array(z.string().uuid()).min(1).max(12).optional(),
        material_id: z.string().uuid().optional(),
        original_material_id: z.string().uuid().optional(),
        feedback_id: z.string().optional(),
        instruction: z.string().max(5000).optional(),
        scenario_id: z.string().optional(),
        mode: z.enum(['rules', 'ai']).default('rules'),
        replay_id: z.string().optional(),
      })
      .parse(req.body);
    const p = await projectContext(db, project);
    if (b.type === 'agent') {
      const f = await getRecord(db, project, b.feedback_id ?? '', 'feedback');
      if (f.data.consent !== 'allowed' || !f.data.allow_model)
        throw new HttpError(422, '未授权模型处理');
    } else if (b.type === 'simulation') {
      const sc = await getRecord(db, project, b.scenario_id ?? '', 'scenario');
      if (sc.stale || sc.world_version !== p.version)
        throw new HttpError(409, '场景已失效，请更新场景版本');
    }
    if (b.type === 'consultation' && !b.instruction?.trim())
      throw new HttpError(422, '请输入咨询问题');
    if (b.type === 'blueprint') {
      if (!b.material_id) throw new HttpError(422, '请先上传卫星影像');
      const material = await one(
        db,
        "SELECT id,mime FROM materials WHERE project_id=$1 AND id=$2 AND consent='allowed'",
        [project, b.material_id],
      );
      if (!material)
        throw new HttpError(422, '影像不存在或未授权模型处理');
      if (!/^image\/(jpeg|png|webp)$/.test(material.mime))
        throw new HttpError(422, '影像识别只支持 JPEG、PNG 或 WebP');
    }
    if (b.type === 'streetwalk') {
      if (!b.photo_ids || new Set(b.photo_ids).size !== b.photo_ids.length)
        throw new HttpError(422, '请选择不重复的照片，最多12张');
      const photos = await db.query(
        `SELECT s.id FROM street_photos s JOIN materials m ON s.id=m.id WHERE s.project_id=$1 AND s.id=ANY($2::text[]) AND m.consent='allowed' AND (s.data->>'allow_model')::boolean`,
        [project, b.photo_ids],
      );
      if (photos.rows.length !== b.photo_ids.length)
        throw new HttpError(422, '照片不存在或未授权模型处理');
    }
    const id = randomUUID();
    await db.query(
      "INSERT INTO runs(id,project_id,world_version,type,status,input,created_by) VALUES($1,$2,$3,$4,'queued',$5,$6)",
      [id, project, p.version, b.type, JSON.stringify(b), u],
    );
    return { run_id: id, status: 'queued' };
  });
  app.get(
    path + '/runs',
    async (req) =>
      (
        await db.query(
          'SELECT * FROM runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',
          [(req.params as any).project],
        )
      ).rows,
  );
  app.get(path + '/runs/:id', async (req) => {
    const { project, id } = req.params as any;
    const run = await one(
      db,
      'SELECT * FROM runs WHERE project_id=$1 AND id=$2',
      [project, id],
    );
    if (!run) throw new HttpError(404, '运行不存在');
    return {
      ...run,
      events: (
        await db.query('SELECT * FROM run_events WHERE run_id=$1 ORDER BY id', [
          id,
        ])
      ).rows,
    };
  });
  app.post(path + '/runs/:id/:operation', async (req) => {
    const { project, id, operation } = req.params as any;
    await authorize(db, (req as any).user, project, ['analyst', 'manager']);
    const r = await one(
      db,
      'SELECT * FROM runs WHERE project_id=$1 AND id=$2',
      [project, id],
    );
    if (!r) throw new HttpError(404, '运行不存在');
    if (operation === 'cancel') {
      await db.query(
        "UPDATE runs SET cancel_requested=true,status='cancelled' WHERE id=$1 AND status NOT IN ('completed','failed','stale')",
        [id],
      );
      return { ok: true };
    }
    const p = await projectContext(db, project);
    if (p.version !== r.world_version)
      throw new HttpError(409, '运行版本已失效');
    if (operation === 'retry') {
      if (!['failed', 'cancelled'].includes(r.status))
        throw new HttpError(409, '运行仍在进行');
      const nid = randomUUID();
      const input = { ...r.input };
      delete input.resume;
      await db.query(
        "INSERT INTO runs(id,project_id,world_version,type,status,input,created_by) VALUES($1,$2,$3,$4,'queued',$5,$6)",
        [
          nid,
          project,
          p.version,
          r.type,
          JSON.stringify(input),
          (req as any).user,
        ],
      );
      return { run_id: nid };
    }
    if (
      operation !== 'resume' ||
      !['waiting_verification', 'awaiting_approval'].includes(r.status)
    )
      throw new HttpError(422, '此运行不能恢复');
    if (r.status === 'awaiting_approval' && r.result?.proposal) {
      const proposal = await getRecord(
        db,
        project,
        r.result.proposal.id,
        'proposal',
      );
      if (proposal.data.status !== 'approved')
        throw new HttpError(422, '请先独立复核并确认方案');
    }
    await db.query(
      "UPDATE runs SET status='queued',claimed_at=NULL,input=jsonb_set(input,'{resume}','true'),cancel_requested=false WHERE id=$1",
      [id],
    );
    return { run_id: id };
  });
  app.post(path + '/materials', async (req) => {
    const p = (req.params as any).project,
      u = (req as any).user;
    await authorize(db, u, p, ['recorder', 'analyst', 'manager']);
    const file = await req.file();
    if (!file) throw new HttpError(422, '请选择材料');
    if (
      ![
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/pdf',
        'text/plain',
      ].includes(file.mimetype)
    )
      throw new HttpError(422, '只接受图片、PDF或文本材料');
    const bytes = await file.toBuffer();
    const id = randomUUID();
    await writeFile(join(options.storage, id), bytes, { mode: 0o600 });
    try {
      await db.query(
        "INSERT INTO materials(id,project_id,name,mime,size,consent,created_by) VALUES($1,$2,$3,$4,$5,'allowed',$6)",
        [id, p, file.filename, file.mimetype, bytes.length, u],
      );
    } catch (e) {
      await rm(join(options.storage, id));
      throw e;
    }
    await audit(db, u, p, 'material.upload', id);
    return { id, name: file.filename };
  });
  app.get(path + '/materials/:id', async (req, reply) => {
    const { project, id } = req.params as any;
    const m = await one(
      db,
      "SELECT * FROM materials WHERE project_id=$1 AND id=$2 AND consent='allowed'",
      [project, id],
    );
    if (!m) throw new HttpError(404, '材料不存在或已撤回');
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(m.name)}`,
      )
      .type(m.mime);
    return reply.send(await readFile(join(options.storage, m.id)));
  });
  app.post(path + '/materials/:id/withdraw', async (req) => {
    const { project, id } = req.params as any;
    await authorize(db, (req as any).user, project, ['manager']);
    const m = await one(
      db,
      'SELECT * FROM materials WHERE project_id=$1 AND id=$2',
      [project, id],
    );
    if (!m) throw new HttpError(404, '材料不存在');
    await db.query("UPDATE materials SET consent='withdrawn' WHERE id=$1", [
      id,
    ]);
    await db.query(
      "UPDATE records SET data=jsonb_set(data,'{verified}','false'),version=version+1 WHERE project_id=$1 AND kind='evidence' AND data->'material_ids' ? $2",
      [project, id],
    );
    await db.query(
      "UPDATE records SET stale=true WHERE project_id=$1 AND kind='proposal' AND EXISTS (SELECT 1 FROM records e WHERE e.project_id=$1 AND e.kind='evidence' AND e.data->'material_ids' ? $2 AND records.data->'evidence_ids' ? e.id)",
      [project, id],
    );
    await db.query(
      "UPDATE runs SET status='stale',cancel_requested=true,result=NULL,error='照片授权已撤回' WHERE project_id=$1 AND type='streetwalk' AND input->'photo_ids' ? $2",
      [project, id],
    );
    await rm(join(options.storage, m.id), { force: true });
    await audit(db, (req as any).user, project, 'material.withdraw', id);
    return { ok: true };
  });
  app.get(path + '/export', async (req) => {
    const p = (req.params as any).project,
      u = (req as any).user;
    await authorize(db, u, p, ['manager']);
    await audit(db, u, p, 'export');
    return {
      project: await projectContext(db, p),
      records: (
        await db.query('SELECT * FROM records WHERE project_id=$1', [p])
      ).rows,
      runs: (await db.query('SELECT * FROM runs WHERE project_id=$1', [p]))
        .rows,
    };
  });
  app.get(path + '/audit', async (req) => {
    const p = (req.params as any).project;
    await authorize(db, (req as any).user, p, ['manager']);
    return (
      await db.query(
        'SELECT * FROM audit WHERE project_id=$1 ORDER BY id DESC LIMIT 200',
        [p],
      )
    ).rows;
  });
  app.post(path + '/sync', async (req) => {
    const p = (req.params as any).project,
      u = (req as any).user;
    const b = z
      .object({
        request_id: z.string().uuid(),
        kind: z.enum([
          'feedback',
          'issue',
          'observation',
          'facility',
          'followup',
        ]),
        id: z.string().uuid(),
        input: recordInput,
      })
      .parse(req.body);
    return transaction(db, async (tx) => {
      await tx.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [p]);
      const receipt = await one(
        tx,
        'SELECT result FROM sync_receipts WHERE project_id=$1 AND user_id=$2 AND request_id=$3',
        [p, u, b.request_id],
      );
      if (receipt) return receipt.result;
      const exists = await one(
        tx,
        'SELECT * FROM records WHERE project_id=$1 AND id=$2',
        [p, b.id],
      );
      if (exists && b.input.base_version === 0)
        throw new HttpError(409, '本地与服务端记录冲突', { current: exists });
      const saved = await saveRecord(
        tx,
        u,
        p,
        b.kind,
        { ...b.input, id: b.id },
        exists ? b.id : undefined,
        true,
      );
      await tx.query('INSERT INTO sync_receipts VALUES($1,$2,$3,$4)', [
        p,
        u,
        b.request_id,
        JSON.stringify(saved),
      ]);
      return saved;
    });
  });
  return app;
}
