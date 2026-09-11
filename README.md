# 乡筑工作台 · 后端（xiangzhu-server）

「乡村适老化建设辅助工作台」的业务后端：fastify + 嵌入式 pglite 数据库 +
CodeBuddy CLI 视觉识别（卫星图道路转译、协作区 AI 助手）。

> 配套前端：[xiangzhu-web](https://github.com/InLit-iaDuanna/xiangzhu-web)
> （vinext / React 19 三阶段工作台），前后端分离部署。

## 架构

```
xiangzhu-web ──/api/*──▶ fastify :4100
                          ├─ app.ts        REST 路由（项目/记录/材料/运行/导出/审计）
                          ├─ assistant.ts  AI 协作区（SSE 流式，CodeBuddy CLI 子进程）
                          ├─ workflow.ts   LangGraph 工作流（blueprint 道路识别等）
                          ├─ db.ts         @electric-sql/pglite 嵌入式 Postgres
                          └─ migrations/   启动时自动执行 001.sql
lib/                      前后端共享纯函数库（空间模型 / 识别解析 / 模拟引擎）
```

- 数据库：pglite 嵌入式 Postgres（默认内存模式；配置 `PGLITE_DATA_DIR` 持久化）
- AI 执行器：`AI_EXECUTOR=codebuddy` 调用本机 CodeBuddy CLI（需安装并登录）；
  也可切换 `codex` HTTP 中继
- 免登录演示：内置 stub 认证（固定用户），账户系统在路线图中

## 本地运行

```bash
# Node >= 22.13.0
npm install --legacy-peer-deps
cp .env.example .env.local        # 按需修改（密钥只放这里，不入库）
npm start                         # fastify 监听 :4100
```

健康检查：`curl http://127.0.0.1:4100/api/v1/health` → `{"status":"ok",...}`

## 环境变量（.env.local）

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` / `HOST` | 监听端口/地址 | `4100` / `0.0.0.0` |
| `PGLITE_DATA_DIR` | 数据目录；`memory` 为内存模式 | `work/pglite-data` |
| `WEB_ORIGINS` | CORS 允许的前端来源（逗号分隔） | `http://localhost:3000` |
| `MATERIALS_DIR` | 影像材料存储目录 | `work/materials` |
| `KNOWLEDGE_PATH` | 知识库 JSON 路径（可选） | `work/knowledge.json` |
| `AI_EXECUTOR` | `codebuddy` 或 `codex` | `codebuddy` |
| `CODEBUDDY_MODEL` | CLI 使用的模型 | `deepseek-v4-flash` |
| `TENCENT_MAP_KEY` / `TENCENT_MAP_SK` | 腾讯地图服务端密钥（仅后端持有） | 空 |

完整清单见 `.env.example`。**密钥不入库**：`.env*` 已在 `.gitignore` 中排除。

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm start` | 启动服务（自动执行 migrations） |
| `npm run migrate` | 手动执行数据库迁移 |
| `npm run typecheck` | TypeScript 检查 |
| `npm run test` | vitest（fastify inject 冒烟 + 纯函数单测） |

## H5 可试用部署路线

1. 部署到任意 Node >= 22 宿主（VPS / 容器 / Serverless 常驻实例）。
2. 设置 `PGLITE_DATA_DIR` 指向持久卷（默认 `work/` 相对路径），保证重启不丢数据。
3. 前端 `BUSINESS_API_URL` 指向本服务公网地址；CORS `WEB_ORIGINS` 加入前端域名。
4. AI 视觉（道路转译 / 协作助手）依赖宿主机安装并登录 CodeBuddy CLI；
   无 CLI 的环境可切换 `AI_EXECUTOR=codex` 并配置 API 密钥。
