import Dexie, { type Table } from 'dexie';
import { api, ApiError, request } from './client';
export type Draft = {
  id: string;
  user_id: string;
  project_id: string;
  kind: 'feedback' | 'observation' | 'followup' | 'issue' | 'facility';
  input: any;
  request_id: string;
  state: 'draft' | 'queued' | 'conflict';
  conflict?: any;
  attachments?: { name: string; type: string; blob: Blob }[];
  updated_at: string;
};
class FieldDB extends Dexie {
  drafts!: Table<Draft, string>;
  constructor() {
    super('xiangzhu-v2-field');
    this.version(1).stores({ drafts: 'id,user_id,project_id,state' });
  }
}
export const fieldDB = new FieldDB();
export async function synchronize(user: string, project: string) {
  const drafts = await fieldDB.drafts
    .where('project_id')
    .equals(project)
    .filter((d) => d.user_id === user && d.state === 'queued')
    .toArray();
  let synced = 0;
  for (const d of drafts) {
    try {
      if (d.attachments?.length) {
        while (d.attachments.length) {
          const f = d.attachments[0];
          const body = new FormData();
          body.append('file', f.blob, f.name);
          const m = await request(`/api/v1/projects/${project}/materials`, {
            method: 'POST',
            body,
          });
          d.input.data.material_ids = [
            ...(d.input.data.material_ids ?? []),
            m.id,
          ];
          d.attachments.shift();
          await fieldDB.drafts.update(d.id, {
            input: d.input,
            attachments: d.attachments,
          });
        }
        await fieldDB.drafts.update(d.id, { input: d.input, attachments: [] });
      }
      await api(project, '/sync', {
        request_id: d.request_id,
        kind: d.kind,
        id: d.id,
        input: d.input,
      });
      await fieldDB.drafts.delete(d.id);
      synced++;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409)
        await fieldDB.drafts.update(d.id, {
          state: 'conflict',
          conflict: e.details?.current,
        });
      else throw e;
    }
  }
  return synced;
}
