import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { streetMetadata } from '../lib/v2/street';
import { authorize } from './store';
import { audit, HttpError, type DB } from './db';
export function registerStreet(app: FastifyInstance, db: DB, storage: string) {
  const path = '/api/v1/projects/:project/street-photos';
  app.get(
    path,
    async (req) =>
      (
        await db.query(
          `SELECT s.*,m.name FROM street_photos s JOIN materials m ON s.id=m.id WHERE s.project_id=$1 AND m.consent='allowed' ORDER BY s.created_at,s.id`,
          [(req.params as any).project],
        )
      ).rows,
  );
  app.post(path, async (req) => {
    const project = (req.params as any).project,
      user = (req as any).user;
    await authorize(db, user, project, ['recorder', 'analyst', 'manager']);
    const file = await req.file();
    if (
      !file ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
    )
      throw new HttpError(422, '请选择 JPEG、PNG 或 WebP 照片');
    const metadata = streetMetadata.parse(
      JSON.parse(String((file.fields.metadata as any)?.value ?? '{}')),
    );
    const bytes = await file.toBuffer();
    const actual =
      bytes[0] === 0xff && bytes[1] === 0xd8
        ? 'image/jpeg'
        : bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? 'image/png'
          : bytes.toString('ascii', 0, 4) === 'RIFF' &&
              bytes.toString('ascii', 8, 12) === 'WEBP'
            ? 'image/webp'
            : '';
    if (actual !== file.mimetype)
      throw new HttpError(422, '图片内容与格式不符');
    const id = metadata.capture_id ?? randomUUID();
    const existing = (
      await db.query(
        'SELECT id,project_id,created_by,consent FROM materials WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.project_id !== project ||
        existing.created_by !== user ||
        existing.consent !== 'allowed'
      )
        throw new HttpError(409, '采集编号已使用');
      return { id, already_saved: true };
    }

    await writeFile(join(storage, id), bytes, { mode: 0o600, flag: 'wx' });
    try {
      // A single statement ensures metadata and its private material commit together.
      await db.query(
        `WITH material AS (INSERT INTO materials(id,project_id,name,mime,size,consent,created_by) VALUES($1,$2,$3,$4,$5,'allowed',$6) RETURNING id) INSERT INTO street_photos(id,project_id,data) SELECT id,$2,$7 FROM material`,
        [
          id,
          project,
          file.filename,
          actual,
          bytes.length,
          user,
          JSON.stringify({
            ...metadata,
            coordinate_system: 'WGS84',
            source: '设备定位与用户上传',
            captured_at: metadata.captured_at,
          }),
        ],
      );
    } catch (e) {
      await rm(join(storage, id));
      throw e;
    }
    await audit(db, user, project, 'street.upload', id);
    return { id };
  });
}
