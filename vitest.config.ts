import { defineConfig } from 'vitest/config';

// 独立测试配置：不加载 vite.config.ts 的 vinext/cloudflare/sites 插件
// （cloudflare 插件与 vitest 的 rsc 环境 resolve.external 不兼容），
// 单测只跑纯函数与 fastify inject，无需浏览器与 Workers 环境。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
