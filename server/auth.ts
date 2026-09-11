import { betterAuth } from 'better-auth';
import { pool } from './db';
export function makeAuth(bootstrap = false) {
  return betterAuth({
    database: pool,
    baseURL: process.env.AUTH_URL ?? 'http://localhost:4100',
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: (process.env.WEB_ORIGINS ?? 'http://localhost:5173').split(
      ',',
    ),
    emailAndPassword: {
      enabled: true,
      // 默认开放自助注册；如需关闭注册，设置 AUTH_ALLOW_SIGNUP=false
      disableSignUp: !bootstrap && process.env.AUTH_ALLOW_SIGNUP === 'false',
    },
    advanced: { useSecureCookies: process.env.NODE_ENV === 'production' },
    rateLimit: { enabled: true },
    session: { expiresIn: 60 * 60 * 8 },
  });
}
