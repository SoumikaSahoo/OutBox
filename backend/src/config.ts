import 'dotenv/config';
const normalizeOrigin = (value?: string) => value ? (value.includes('://') ? value : `https://${value}`) : undefined;
const deployedDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
const publicUrl = normalizeOrigin(process.env.PUBLIC_APP_URL ?? deployedDomain);
export const config = {
  port: Number(process.env.PORT ?? 4000), frontendUrl: normalizeOrigin(process.env.FRONTEND_URL) ?? publicUrl ?? 'http://localhost:5173',
  localDemoAuth: process.env.NODE_ENV !== 'production' && process.env.LOCAL_DEMO_AUTH === 'true',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 5)),
  delayMs: Math.max(0, Number(process.env.MIN_SEND_DELAY_MS ?? 2000)),
  hourlyLimit: Math.max(1, Number(process.env.MAX_EMAILS_PER_HOUR_PER_SENDER ?? 200)),
  sessionSecret: process.env.SESSION_SECRET ?? 'development-secret-change-this-before-use',
};
