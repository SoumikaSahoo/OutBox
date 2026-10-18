# ReachInbox Email Scheduler

A small full-stack email scheduling service. The API stores messages in PostgreSQL and schedules durable BullMQ jobs in Redis. A separate worker sends mail through Ethereal SMTP, indexes message records in Elasticsearch, and reschedules work that reaches a sender's hourly cap.

## Project layout

- `backend/src/api.ts` — Google and Slack OAuth, scheduling/list/search APIs, and Bull Board.
- `backend/src/worker.ts` — BullMQ consumer, Redis-backed throttling, SMTP delivery, and indexing.
- `backend/prisma/schema.prisma` — PostgreSQL user and email records.
- `frontend` — React, TypeScript, Vite dashboard and compose flow.
- `docker-compose.yml` — PostgreSQL, persistent Redis, and Elasticsearch.

## Requirements

- Node.js 20 or newer and npm
- Docker Desktop (or compatible Docker Engine)
- Google OAuth credentials, Slack OAuth app credentials, and an Ethereal test account for live integrations

## Run locally

From this folder:

1. Start infrastructure: `docker compose up -d`
2. Copy `.env.example` to `.env` and fill in the OAuth and Ethereal values. Keep the callback URLs exactly aligned with the values registered at each provider.
3. Install workspace dependencies: `npm install`
4. Generate Prisma client and create/update the local schema: `npm --workspace backend run db:generate` then `npm --workspace backend run db:push`
5. Start API, worker, and frontend together: `npm run dev`
6. Open `http://localhost:5173`. Bull Board is at `http://localhost:4000/admin/queues` after Google sign-in.

For separate processes, use `npm run dev:api`, `npm run dev:worker`, and `npm run dev:web` in separate terminals. Production builds use `npm run build`, then `npm --workspace backend run start:api` and `npm --workspace backend run start:worker`; serve the generated frontend `dist` directory with a static server and set `VITE_API_URL` at build time if the API is not at `http://localhost:4000`.

## Deploy to Vercel

This project uses a Vercel container for the combined React dashboard and Express API, plus a Vercel Daemon for the persistent BullMQ worker. Daemons are currently in public beta. PostgreSQL, Redis, and Elasticsearch remain managed data services: connect PostgreSQL and Redis from the Vercel Marketplace, and provide an Elasticsearch endpoint and API key from a hosted Elasticsearch provider. This keeps the whole application and worker on Vercel while using managed databases for durable state.

### Deploy

1. Sign in to Vercel and create a project from a private repository containing only this project, or deploy this folder directly with the Vercel CLI. This folder is nested in a larger workspace, so do not connect or publish its parent repository.
2. In the Vercel project, connect PostgreSQL and Redis Marketplace integrations. Add `DATABASE_URL` and `REDIS_URL` in Production using the connection strings provided by those integrations.
3. Create a hosted Elasticsearch deployment and add `ELASTICSEARCH_URL` plus either `ELASTICSEARCH_API_KEY` or `ELASTICSEARCH_USERNAME` and `ELASTICSEARCH_PASSWORD` in Vercel Production variables.
4. Add `NODE_ENV=production`, a random `SESSION_SECRET` of at least 32 characters, and the SMTP credentials `ETHEREAL_USER` and `ETHEREAL_PASSWORD`. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; Slack credentials are optional.
5. Deploy from this folder. `Dockerfile.vercel` packages the web UI and API as one Vercel container function. `vercel.json` starts one `email-worker` Daemon in `iad1` using the existing Dockerfile and the BullMQ worker command. Set project deployment protection to public if you want anyone to use the application.
6. Once Vercel assigns the production domain, register `https://YOUR-DOMAIN/auth/google/callback` as the Google OAuth redirect. Register `https://YOUR-DOMAIN/auth/slack/callback` in Slack if Slack alerts are enabled. Vercel's production domain is detected automatically; set `PUBLIC_APP_URL` only if you use a custom domain that differs from it.

`LOCAL_DEMO_AUTH` is disabled automatically in production. Do not upload `.env`; it contains local service URLs and test credentials. Vercel Daemons and Vercel's backend/container features are beta and may require account-level access. Marketplace database and Elasticsearch costs depend on the providers and plans selected. Review [Vercel Hobby limits](https://vercel.com/docs/plans/hobby), [Vercel Daemons](https://vercel.com/daemons), and [Vercel Marketplace storage](https://vercel.com/docs/storage) before provisioning resources.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | local compose database |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `ELASTICSEARCH_URL` | Elasticsearch node | `http://localhost:9200` |
| `ELASTICSEARCH_API_KEY` | Hosted Elasticsearch API key (alternative to username/password) | optional |
| `ELASTICSEARCH_USERNAME`, `ELASTICSEARCH_PASSWORD` | Hosted Elasticsearch basic authentication | optional |
| `PORT` | API port | `4000` |
| `FRONTEND_URL` | Frontend origin and OAuth return destination | `http://localhost:5173` |
| `PUBLIC_APP_URL` | Optional public app origin override for OAuth callbacks | Vercel production domain is detected automatically |
| `SESSION_SECRET` | HMAC signing key; use a random secret of at least 32 characters | development placeholder |
| `LOCAL_DEMO_AUTH` | Enables a local-only demo account when `NODE_ENV` is not `production` | `false` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google web OAuth credentials | required for login |
| `GOOGLE_CALLBACK_URL` | Registered Google callback | `http://localhost:4000/auth/google/callback` |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | Slack app OAuth credentials | required for Slack alerts |
| `SLACK_CALLBACK_URL` | Registered Slack callback | `http://localhost:4000/auth/slack/callback` |
| `ETHEREAL_HOST`, `ETHEREAL_PORT` | Ethereal SMTP host and port | `smtp.ethereal.email:587` |
| `ETHEREAL_USER`, `ETHEREAL_PASSWORD` | Credentials from an Ethereal test account | required to send |
| `WORKER_CONCURRENCY` | BullMQ worker concurrency | `5` |
| `MIN_SEND_DELAY_MS` | Minimum sender spacing in milliseconds | `2000` |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | Default per-sender hourly cap | `200` |

Create an Ethereal account at [ethereal.email](https://ethereal.email/) and copy its SMTP credentials into `.env`. Ethereal captures messages for testing; it does not deliver to real inboxes. The worker logs a preview URL for each successful message.

For Google OAuth, create a Web application OAuth client and register the callback URL above. For Slack, create a Slack app, enable OAuth, register the Slack callback URL, and enable the `incoming-webhook` scope. `Connect Slack` runs the OAuth flow and stores the workspace webhook on the signed-in user; disconnect with `DELETE /api/slack`. The webhook posts a notification to the channel selected during Slack authorization.

For local evaluation without Google credentials, set `LOCAL_DEMO_AUTH=true` and keep `NODE_ENV` unset or set to `development`. The login screen will offer a local demo workspace. This route is disabled automatically in production.

## APIs

- `GET /auth/google` — start Google OAuth
- `GET /api/me` — current signed-in user
- `POST /auth/logout` — clear session cookie
- `POST /api/emails/schedule` — body: `{ "subject", "body", "sender", "recipients": ["..."], "startAt": "ISO-8601", "delayMs": 2000, "hourlyLimit": 200 }`
- `GET /api/emails?status=SCHEDULED` or `?status=SENT` — list current user's scheduled/processing or sent/failed messages
- `GET /api/search?q=...` — Elasticsearch search scoped to the signed-in user
- `GET /api/queue` — queue counts
- `GET /admin/queues` — authenticated Bull Board view
- `GET /health` — API, PostgreSQL, Redis, and Elasticsearch health check

## Scheduling, persistence, and throughput

Each recipient is stored as its own PostgreSQL row and BullMQ job. BullMQ delayed jobs use the requested start time plus the selected inter-message interval. Redis persistence is enabled with AOF in Docker Compose, and PostgreSQL/Redis/Elasticsearch data use named volumes. The API and worker are separate processes, so restarting either does not rebuild the schedule: BullMQ retains delayed jobs and the database remains the source for the dashboard. Job IDs are the database email IDs; enqueuing the same ID cannot create a second queue job. The worker checks message state before sending and marks a message as processing/sent to avoid ordinary duplicate processing.

Worker concurrency is controlled with `WORKER_CONCURRENCY` (default 5). A Redis Lua script atomically reserves each sender's next send time and hourly slot across workers and instances. The default minimum gap is **2 seconds** (`MIN_SEND_DELAY_MS=2000`); reservations serialize sends per sender while jobs for other senders may run in parallel. The per-sender hourly cap is configured by `MAX_EMAILS_PER_HOUR_PER_SENDER` and may be lowered for an individual schedule using its `hourlyLimit`. When full, the worker moves the job to the next hour boundary instead of failing or dropping it. Slack receives one notification per sender/user per worker process when the hourly cap is encountered; disconnecting Slack leaves scheduling unaffected.

With 1,000 jobs at a single start time, BullMQ stores them durably and workers consume them at the configured concurrency and sender pace. The hourly cap pushes overflow into the next hour; the API enqueues recipients incrementally, so large batches are not held in one in-memory scheduler. Elasticsearch indexing is best-effort after database writes and can be recovered by reindexing stored records if Elasticsearch is unavailable.

SMTP cannot offer true exactly-once delivery: if a provider accepts a message and the worker loses its connection before recording success, a retry can create an ambiguous duplicate. Persistent job IDs and state checks prevent normal duplicate runs, but this external-provider failure window is an explicit trade-off.

## Implemented features

- Backend: Express/TypeScript API, PostgreSQL/Prisma records, BullMQ delayed queue, dedicated configurable worker, Redis-backed minimum spacing and hourly caps, Ethereal SMTP delivery, retry/error state, Elasticsearch indexing/search, Google OAuth sessions, Slack OAuth webhook connection, Slack rate-limit notice, Bull Board, health and queue endpoints.
- Frontend: React/TypeScript dashboard, Google sign-in entry point, user profile/logout, scheduled and sent views, live refresh, debounced Elasticsearch search with local fallback, CSV/text recipient parsing and count, compose/schedule modal, scheduling controls, loading/empty/error/success states, Slack connect/disconnect controls.
- Infrastructure: Docker Compose services with named data volumes.

## Assumptions and trade-offs

- The assignment did not include an accessible Figma URL, so the dashboard uses a clean email operations layout rather than claiming pixel-level Figma matching.
- This starter has one configured SMTP account; the sender field controls sender identity and per-sender throttling. Add verified Ethereal credentials or provider credential mapping before supporting real independent sender accounts.
- Authentication is a signed, HTTP-only cookie session. The sample is intended for a local demo; production deployment should use HTTPS, a managed secret store, CSRF protections, and token encryption at rest.
- PostgreSQL and Redis are durable dependencies. Elasticsearch search is temporarily unavailable until its service is running and indexed data exists.
- GitHub repository creation, private access grants, and a demo recording require the user's GitHub account and recording environment; this folder is ready to commit, but those external actions are not performed here.
