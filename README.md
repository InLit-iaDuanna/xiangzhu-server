# 乡筑工作台 · 后端

乡村适老化建设辅助工作台 3.2.0 的 Fastify/PGlite 后端，提供项目资料、知识库、SSE 文本 AI 和独立生图 API。

## 本地运行

```bash
npm install
cp .env.example .env.local
# 在 .env.local 设置 PGLITE_DATA_DIR、文本 API 和生图 API
npm run start
```

健康检查：`GET /api/v1/health`。完整局域网配置见主项目运行手册。

## 安全边界

`.env.local`、PGlite 数据、上传素材和构建产物不提交；API 密钥只保留在服务端环境变量。
