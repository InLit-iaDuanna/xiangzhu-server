-- 003-doc.sql — 工作台文档（V3 数据全走后端）。
-- 前端 Project[]（档案/图片引用/调试/方案）整体存为单文档，doc_version 乐观锁防多设备互相覆盖。
-- 图片本体不入 doc（避免 base64 撑爆 jsonb/bodyLimit）：走 materials 表 + work/materials 文件存储，
-- doc 内 photos.src 只存 /api/v1/projects/{pid}/materials/{mid} 引用。
-- 时间列用 timestamptz（UTC+8 教训，见 002-auth.sql 注释）。

CREATE TABLE IF NOT EXISTS workspace_docs(
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO workspace_docs(id, doc, version)
VALUES('default', '[]'::jsonb, 0)
ON CONFLICT (id) DO NOTHING;
