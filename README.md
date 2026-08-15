# geo-tracker

**Self-hosted GEO (Generative Engine Optimization) + SEO tracker.
Schedule prompts across the AI engines and Google Search, store every
answer in your own Postgres. Your prompts, your data.**

Configure prompts once; geo-tracker runs them on a schedule against
ChatGPT, Gemini, Copilot, Perplexity, Grok, Google AI Mode, Google Search
and Google News — powered by the [cloro API](https://cloro.dev) — stores
every raw response in your own Postgres, and gives you a small REST API
plus an MCP endpoint to analyze the data with Claude, Cursor, or anything
else that speaks MCP.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcloro-dev%2Fgeo-tracker&env=CLORO_API_KEY,CRON_SECRET&envDescription=CLORO_API_KEY%3A%20sign%20up%20at%20cloro.dev%20to%20get%20a%20free%20API%20key.%20CRON_SECRET%3A%20any%20random%20string%20you%20choose%2C%20e.g.%20from%20openssl%20rand%20-hex%2032.&envLink=https%3A%2F%2Fgithub.com%2Fcloro-dev%2Fgeo-tracker%23environment-variables&project-name=geo-tracker&repository-name=geo-tracker&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

- **No dashboard, no UI** — the MCP endpoint and the
  [Grafana starter](./grafana/README.md) are the analysis layer.
- **$0 to run** — fits in Vercel's free tier. The deploy button creates the
  Postgres database for you and sets `DATABASE_URL` automatically.
- **Fully async** — scrapes are submitted as
  [cloro async tasks](https://docs.cloro.dev) and results come back by
  webhook, so no serverless function ever waits on a scrape.

```text
tick (cron) ──► GET /api/cron ──► POST api.cloro.dev/v1/async/task  (per due prompt × engine)
                                    │
cloro finishes the scrape ──────────┴──► POST /api/webhook ──► results row in your Postgres
```

## 10-minute quickstart

### 1. Get a cloro API key

Sign up at [cloro.dev](https://cloro.dev) and copy your API key. This is the
only paid part — it pays for the scrapes.

### 2. Generate one secret

You invent this; it is not issued by anyone:

```bash
openssl rand -hex 32
```

This single value protects the whole deployment: it is the bearer token
you send to your own API and MCP endpoint, the scheduler authenticates
with it, and the webhook token is derived from it. It is named
`CRON_SECRET` because Vercel's scheduler can only authenticate through a
variable with that exact name.

### 3. Click Deploy and walk through Vercel

The button clones this repo into your own GitHub account, provisions a
database, and deploys. Vercel asks for four things, in this order:

| Screen                     | What to do                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **New Project**            | Pick your **Git Scope** (your GitHub account) and a repository name. The clone is private by default. Click **Create**. |
| **Add Products → Storage** | Click **Add** next to the Postgres database, keep the defaults, and choose the **Free** plan.                           |
| **Add Environment Vars**   | Fill the two values from the table below.                                                                               |
| **Deploy**                 | Click it. The build creates your tables and goes live in about a minute.                                                |

You are **not** asked for a database URL — Vercel's default Postgres sets
`DATABASE_URL` for you, already pooled.

What to paste into the two fields:

| Field           | Value                                         |
| --------------- | --------------------------------------------- |
| `CLORO_API_KEY` | Your key from step 1 (starts with `sk_live_`) |
| `CRON_SECRET`   | The secret from step 2                        |

That's it — the two tables (`prompts`, `results`) are created during the
build, so the app is ready the moment the deploy finishes. There is
nothing to install locally.

### 4. Create your first prompt

```bash
curl -X POST https://<your-app>.vercel.app/api/prompts \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "best crm tools",
    "prompt": "What are the best CRM tools for a small startup?",
    "engines": ["chatgpt", "gemini", "perplexity"],
    "country": "US",
    "runsPerDay": 4
  }'
```

### 5. Run it now

Instead of waiting for the schedule:

```bash
curl -X POST https://<your-app>.vercel.app/api/prompts/<id>/run \
  -H "Authorization: Bearer $CRON_SECRET"
```

The call returns immediately with pending task ids; results land in your
database via webhook as each scrape finishes (typically within a few
minutes). Check them with `GET /api/results`.

> **Sanity check:** hitting any endpoint without a token should return
> `401 {"error":{"message":"Unauthorized"}}`. If it does, your deployment
> is healthy.

## Environment variables

| Variable               | Required | Purpose                                                                                                           |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `CLORO_API_KEY`        | yes      | Your cloro API key — pays for the scrapes                                                                         |
| `DATABASE_URL`         | yes      | Postgres connection string. Set for you by Vercel's database; supply it yourself only on other hosts              |
| `CRON_SECRET`          | yes      | The one secret: bearer token for the REST API and MCP, sent automatically by Vercel Cron, seeds the webhook token |
| `APP_API_KEY`          | no       | Set only if you want the API token to differ from the cron secret; replaces `CRON_SECRET` for REST and MCP auth   |
| `APP_URL`              | no       | Public base URL for the webhook callback. Derived from `VERCEL_PROJECT_PRODUCTION_URL` on Vercel; set elsewhere   |
| `CLORO_WEBHOOK_SECRET` | no       | Verify cloro's `X-Cloro-Signature` webhook signatures (if your cloro org has signing enabled)                     |
| `CLORO_API_URL`        | no       | Override the cloro API base URL (default `https://api.cloro.dev`)                                                 |

## API

All endpoints except the webhook require
`Authorization: Bearer <CRON_SECRET>` — your secret from step 2.

| Method   | Path                   | Description                                                                         |
| -------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `GET`    | `/api/prompts`         | List prompts                                                                        |
| `POST`   | `/api/prompts`         | Create a prompt (`name`, `prompt`, `engines[]`, `country`, `runsPerDay`, `enabled`) |
| `GET`    | `/api/prompts/:id`     | Get one prompt                                                                      |
| `PATCH`  | `/api/prompts/:id`     | Update any subset of the prompt fields                                              |
| `DELETE` | `/api/prompts/:id`     | Delete a prompt and (cascade) its results                                           |
| `POST`   | `/api/prompts/:id/run` | Submit the prompt to its engines now; returns pending task ids (202)                |
| `GET`    | `/api/results`         | Query results (filters below)                                                       |
| `GET`    | `/api/cron`            | Scheduler tick — same bearer token                                                  |
| `POST`   | `/api/webhook`         | cloro result callback — auth via token in the callback URL                          |
| `*`      | `/api/mcp`             | MCP endpoint (Streamable HTTP)                                                      |

Engines: `chatgpt`, `gemini`, `copilot`, `perplexity`, `grok`, `aimode`,
`google`, `google-news`.

`GET /api/results` filters (query params): `promptId`, `engine`,
`status` (`pending` | `completed` | `failed`), `from`, `to` (ISO dates),
`limit` (default 50, max 200). The raw `response` payload is omitted from
lists; add `include=response` to get it.

## MCP

Point any MCP client at your deployment and analyze your data in plain
language ("compare how often my brand appeared in ChatGPT vs Perplexity
answers last week").

Claude Code:

```bash
claude mcp add --transport http geo-tracker \
  https://<your-app>.vercel.app/api/mcp \
  --header "Authorization: Bearer <CRON_SECRET>"
```

Claude Desktop / Cursor (`mcpServers` config):

```json
{
  "geo-tracker": {
    "url": "https://<your-app>.vercel.app/api/mcp",
    "headers": {
      "Authorization": "Bearer <CRON_SECRET>"
    }
  }
}
```

Tools: `list_prompts`, `create_prompt`, `run_prompt`, `get_results`,
`get_result` (full raw response payload).

## Scheduling

Each prompt has a `runsPerDay` (1–24). A prompt is _due_ when its last run
is at least `24h / runsPerDay` ago. `GET /api/cron` submits everything due
and is safe to call as often as you like — effective granularity is simply
how often something calls it:

1. **Vercel Cron** (built in, zero setup): `vercel.json` schedules a daily
   tick. On the Hobby plan that's the limit — every prompt runs at least
   once a day.
2. **GitHub Actions** (free, hourly): the included
   [`tick.yml`](./.github/workflows/tick.yml) workflow curls `/api/cron`
   every hour. Set the `TRACKER_URL` repository variable and `CRON_SECRET`
   secret to activate it.
3. **Any scheduler** — e.g. [cron-job.org](https://cron-job.org):
   `GET https://<your-app>.vercel.app/api/cron` with header
   `Authorization: Bearer <CRON_SECRET>` — your secret from step 2.

The same tick also sweeps: pending results whose webhook was missed are
polled from the cloro API and backfilled, so nothing is lost if a webhook
delivery fails.

## Grafana

A ready-made dashboard (run volume, success rate, credits burn, failures)
lives in [`grafana/`](./grafana/README.md) — point Grafana Cloud's free
tier at your Postgres and import one JSON file.

## Local development

```bash
# any Postgres works; quickest:
docker run -d --name tracker-db -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16

cp .env.example .env.local   # fill in the values
pnpm install
pnpm db:migrate              # create the tables (also runs on every build)
pnpm dev
```

Trigger a tick: `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron`.

Changing the schema? Edit `lib/db/schema.ts`, run `pnpm db:generate` to
write a new migration into `drizzle/`, and commit it — deployments apply
pending migrations automatically.

Webhooks can't reach localhost — locally, results are picked up by the
polling sweep on the next cron tick (pending rows older than 10 minutes),
so just hit `/api/cron` again after a scrape completes.

## Data & retention

Two tables: `prompts` and `results`. Each run stores one row per engine
with the full raw cloro response as `jsonb` — measured at **10–30 KB per
row**, so budget roughly 20 KB per engine per run.

Storage is the limit you hit first, well before anything on Vercel:

| Workload                       | Scrapes/day | Storage/month | 0.5 GB lasts |
| ------------------------------ | ----------- | ------------- | ------------ |
| 10 prompts × 3 engines × 1/day | 30          | ~18 MB        | over 2 years |
| 20 prompts × 4 engines × 4/day | 320         | ~190 MB       | ~3 months    |
| 50 prompts × 6 engines × 8/day | 2,400       | ~1.4 GB       | ~2 weeks     |

The same workloads use under 1%, 1% and 7% of Vercel's free monthly
function invocations, so the compute side stays free throughout.

Past light usage, schedule the retention query in
[`grafana/queries.sql`](./grafana/queries.sql) — deleting results older
than 90 days keeps any of these workloads inside the free tier
indefinitely.

## License

[MIT](./LICENSE)
