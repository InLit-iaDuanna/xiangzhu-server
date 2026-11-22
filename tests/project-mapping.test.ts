import { describe, expect, it } from 'vitest';
import {
  materialProjectId,
  resolveProjectMappings,
} from '../lib/v2/project-mapping';

describe('UI 项目与服务端项目映射', () => {
  it('从既有材料地址恢复项目映射，并为其他项目分配稳定 ID', () => {
    const projects = [
      {
        id: 'qingxi',
        photos: [{ src: '/api/v1/projects/legacy-qingxi/materials/photo-1' }],
      },
      { id: 'new-project', photos: [] },
    ];

    expect(resolveProjectMappings(projects, ['legacy-qingxi'])).toEqual([
      { ...projects[0], serverProjectId: 'legacy-qingxi' },
      { ...projects[1], serverProjectId: 'new-project' },
    ]);
  });

  it('只把旧版本共享的默认后端项目映射给首个未映射 UI 项目', () => {
    const mapped = resolveProjectMappings(
      [
        { id: 'qingxi', photos: [] },
        {
          id: 'second',
          photos: [{ src: '/api/v1/projects/legacy-default/materials/old' }],
        },
      ],
      ['legacy-default'],
    );

    // 旧版的所有上传都经过首个服务端项目；已有材料引用继续保留，
    // 但后续上传从第二个 UI 项目开始写入它自己的项目空间。
    expect(mapped[0].serverProjectId).toBe('legacy-default');
    expect(mapped[1].serverProjectId).toBe('second');
  });

  it('保留已保存映射，重复恢复不会改变映射', () => {
    const first = resolveProjectMappings(
      [{ id: 'ui-1', serverProjectId: 'server-1' }, { id: 'ui-2' }],
      ['server-1'],
    );
    expect(resolveProjectMappings(first, ['server-1'])).toEqual(first);
  });

  it('能安全解析材料 URL，并忽略普通图片路径', () => {
    expect(
      materialProjectId('/api/v1/projects/project%2Fid/materials/photo'),
    ).toBe('project/id');
    expect(materialProjectId('/countryside.png')).toBeNull();
    expect(materialProjectId('/api/v1/projects/bad%2/materials/photo')).toBeNull();
  });
});
