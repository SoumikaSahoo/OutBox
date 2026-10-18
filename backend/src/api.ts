import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { z } from 'zod';
import { config } from './config.js';
import { prisma, redis, emailQueue, search } from './clients.js';
import { issueSession, requireUser, type SessionUser } from './session.js';

const app = express();
app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
const publicBaseUrl = config.frontendUrl;
const googleCallbackUrl = process.env.GOOGLE_CALLBACK_URL ?? new URL('/auth/google/callback', publicBaseUrl).toString();
const slackCallbackUrl = process.env.SLACK_CALLBACK_URL ?? new URL('/auth/slack/callback', publicBaseUrl).toString();
const oauth = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, googleCallbackUrl);
const board = new ExpressAdapter();
board.setBasePath('/admin/queues');
createBullBoard({ queues: [new BullMQAdapter(emailQueue)], serverAdapter: board });
app.use('/admin/queues', requireUser, board.getRouter());

app.get('/auth/google', async (_req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.status(503).type('html').send('<!doctype html><html><meta charset="utf-8"><title>Google sign-in setup required</title><body style="font:16px system-ui;max-width:620px;margin:12vh auto;padding:24px;color:#202b25;background:#f3f0e7"><h1>Google sign-in is not configured yet</h1><p>Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in <code>email-scheduler/.env</code>, then restart the API.</p><p>Register <code>http://localhost:4000/auth/google/callback</code> as an authorized redirect URI in your Google OAuth client.</p><p>You can return to the dashboard at <a href="http://localhost:5173">localhost:5173</a>.</p></body></html>');
  const state = randomBytes(24).toString('hex');
  await redis.set(`oauth:google:${state}`, '1', 'EX', 300);
  res.redirect(oauth.generateAuthUrl({ scope: ['openid', 'email', 'profile'], state, access_type: 'online' }));
});
app.get('/auth/google/callback', async (req, res) => {
  try {
    const state = String(req.query.state ?? '');
    if (await redis.getdel(`oauth:google:${state}`) !== '1') return res.status(400).send('Invalid sign-in state.');
    const { tokens } = await oauth.getToken(String(req.query.code));
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token!, audience: process.env.GOOGLE_CLIENT_ID });
    const profile = ticket.getPayload();
    if (!profile?.sub || !profile.email || !profile.email_verified) return res.status(401).send('Google account must have a verified email.');
    const user = await prisma.user.upsert({ where: { googleId: profile.sub }, create: { googleId: profile.sub, email: profile.email, name: profile.name ?? profile.email, avatar: profile.picture }, update: { email: profile.email, name: profile.name ?? profile.email, avatar: profile.picture } });
    res.cookie('session', issueSession({ id: user.id, email: user.email, name: user.name, avatar: user.avatar }), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000 });
    res.redirect(config.frontendUrl);
  } catch (error) { console.error('Google OAuth callback failed', error); res.status(400).send('Sign-in failed. Please try again.'); }
});
app.post('/auth/logout', (_req, res) => { res.clearCookie('session'); res.status(204).end(); });
app.get('/api/auth/options', (_req, res) => res.json({
  googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  demoEnabled: config.localDemoAuth,
}));
app.post('/auth/demo', async (_req, res) => {
  if (!config.localDemoAuth) return res.status(404).json({ error: 'Local demo sign-in is disabled.' });
  const user = await prisma.user.upsert({
    where: { googleId: 'local-demo-user' },
    create: { googleId: 'local-demo-user', email: 'demo@localhost.test', name: 'Local Demo' },
    update: {},
  });
  res.cookie('session', issueSession({ id: user.id, email: user.email, name: user.name, avatar: user.avatar }), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000,
  });
  res.status(204).end();
});
app.get('/api/me', requireUser, (_req, res) => res.json(res.locals.user));

app.get('/auth/slack', requireUser, async (_req, res) => {
  if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) return res.status(503).json({ error: 'Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in email-scheduler/.env, register the configured callback URL, then restart the API.' });
  const state = randomBytes(24).toString('hex');
  await redis.set(`oauth:slack:${state}`, res.locals.user.id, 'EX', 300);
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', process.env.SLACK_CLIENT_ID); url.searchParams.set('scope', 'incoming-webhook');
  url.searchParams.set('redirect_uri', slackCallbackUrl); url.searchParams.set('state', state);
  res.redirect(url.toString());
});
app.get('/auth/slack/callback', async (req, res) => {
  try {
    const state = String(req.query.state ?? ''); const userId = await redis.getdel(`oauth:slack:${state}`);
    if (!userId) return res.status(400).send('Invalid Slack OAuth state.');
    const response = await fetch('https://slack.com/api/oauth.v2.access', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.SLACK_CLIENT_ID ?? '', client_secret: process.env.SLACK_CLIENT_SECRET ?? '', code: String(req.query.code ?? ''), redirect_uri: slackCallbackUrl }) });
    const data = await response.json() as { ok: boolean; access_token?: string; incoming_webhook?: { url: string; channel_id: string } };
    if (!data.ok || !data.incoming_webhook?.url) throw new Error('Slack authorization did not return an incoming webhook.');
    await prisma.user.update({ where: { id: userId }, data: { slackAccessToken: data.access_token, slackTeamId: data.incoming_webhook.channel_id, slackWebhookUrl: data.incoming_webhook.url } });
    res.redirect(`${config.frontendUrl}?slack=connected`);
  } catch (error) { console.error('Slack OAuth callback failed', error); res.redirect(`${config.frontendUrl}?slack=failed`); }
});
app.delete('/api/slack', requireUser, async (_req, res) => { await prisma.user.update({ where: { id: res.locals.user.id }, data: { slackAccessToken: null, slackTeamId: null, slackWebhookUrl: null } }); res.status(204).end(); });
app.get('/api/slack', requireUser, async (_req, res) => { const user = await prisma.user.findUnique({ where: { id: res.locals.user.id }, select: { slackWebhookUrl: true } }); res.json({ connected: Boolean(user?.slackWebhookUrl) }); });

app.get('/api/emails', requireUser, async (req, res) => {
  const status = req.query.status === 'SENT' ? ['SENT', 'FAILED'] : ['SCHEDULED', 'PROCESSING'];
  const records = await prisma.email.findMany({ where: { userId: res.locals.user.id, status: { in: status as never[] } }, orderBy: { scheduledAt: 'asc' }, take: 500 });
  res.json(records);
});
const schema = z.object({ subject: z.string().min(1).max(998), body: z.string().min(1).max(100000), recipients: z.array(z.string().email()).min(1).max(10000), sender: z.string().email(), startAt: z.string().datetime(), delayMs: z.number().int().min(0).max(3600000), hourlyLimit: z.number().int().min(1).max(10000).optional() });
app.post('/api/emails/schedule', requireUser, async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.' });
  const input = parsed.data; const user = res.locals.user as SessionUser;
  try {
    const jobs: string[] = [];
    for (let i = 0; i < input.recipients.length; i++) {
      const scheduledAt = new Date(new Date(input.startAt).getTime() + i * input.delayMs);
      const email = await prisma.email.create({ data: { userId: user.id, sender: input.sender, recipient: input.recipients[i]!, subject: input.subject, body: input.body, scheduledAt } });
      await emailQueue.add('send', { emailId: email.id, userId: user.id, sender: input.sender, hourlyLimit: input.hourlyLimit }, { jobId: email.id, delay: Math.max(0, scheduledAt.getTime() - Date.now()), attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: false, removeOnFail: false });
      await search.index({ index: 'emails', id: email.id, document: { id: email.id, userId: user.id, sender: input.sender, recipient: email.recipient, subject: input.subject, body: input.body, status: 'SCHEDULED', scheduledAt }, refresh: false }).catch(error => console.error('Email indexing failed', error));
      jobs.push(email.id);
    }
    res.status(202).json({ scheduled: jobs.length, ids: jobs });
  } catch (error) { console.error('Scheduling failed', error); res.status(500).json({ error: 'Could not schedule all emails. Retry after checking the dashboard.' }); }
});
app.get('/api/search', requireUser, async (req, res) => {
  const q = String(req.query.q ?? '').trim(); if (!q) return res.json({ hits: [] });
  try {
    if (!(await search.indices.exists({ index: 'emails' }))) return res.json({ hits: [] });
    const result = await search.search({ index: 'emails', query: { bool: { must: [{ multi_match: { query: q, fields: ['recipient', 'subject', 'body'] } }], filter: [{ term: { userId: res.locals.user.id } }] } }, size: 100 });
    res.json({ hits: result.hits.hits.map(hit => hit._source) });
  }
  catch (error) { console.error('Search unavailable', error); res.status(503).json({ error: 'Search service is unavailable.' }); }
});
app.get('/api/queue', requireUser, async (_req, res) => {
  const queue = new Queue('email-send', { connection: redis });
  const [waiting, delayed, active, failed, completed] = await Promise.all([queue.getWaitingCount(), queue.getDelayedCount(), queue.getActiveCount(), queue.getFailedCount(), queue.getCompletedCount()]);
  await queue.close(); res.json({ waiting, delayed, active, failed, completed, dashboard: '/admin/queues' });
});
function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Service check timed out')), milliseconds);
    operation.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
app.get('/health', async (_req, res) => {
  const [database, cache, searchService] = await Promise.allSettled([
    withTimeout(prisma.$queryRaw`SELECT 1`, 2000),
    withTimeout(redis.ping(), 2000),
    withTimeout(search.ping(), 2000),
  ]);
  const services = {
    postgres: database.status === 'fulfilled' ? 'ok' : 'unavailable',
    redis: cache.status === 'fulfilled' ? 'ok' : 'unavailable',
    elasticsearch: searchService.status === 'fulfilled' ? 'ok' : 'unavailable',
  };
  const ok = Object.values(services).every(service => service === 'ok');
  res.status(ok ? 200 : 503).json({ ok, services });
});
const frontendBuild = resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
if (existsSync(frontendBuild)) {
  app.use(express.static(frontendBuild, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/admin/')) return next();
    res.sendFile(resolve(frontendBuild, 'index.html'));
  });
}
app.listen(config.port, '0.0.0.0', () => console.log(`API listening on :${config.port}`));
