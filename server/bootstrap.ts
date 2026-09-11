import { makeAuth } from './auth';
import { pool } from './db';
if (!process.env.BOOTSTRAP_EMAIL || !process.env.BOOTSTRAP_PASSWORD)
  throw new Error('请设置 BOOTSTRAP_EMAIL 与 BOOTSTRAP_PASSWORD（至少12位）');
if (process.env.BOOTSTRAP_PASSWORD.length < 12)
  throw new Error('初始密码至少12位');
const auth = makeAuth(true);
await auth.api.signUpEmail({
  body: {
    email: process.env.BOOTSTRAP_EMAIL,
    password: process.env.BOOTSTRAP_PASSWORD,
    name: process.env.BOOTSTRAP_NAME ?? '项目负责人',
  },
});
console.log('初始账号已创建；请登录后建立项目并邀请成员');
await pool.end();
