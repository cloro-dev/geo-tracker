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

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcloro-dev%2Fgeo-tracker&env=CLORO_API_KEY,APP_API_KEY,CRON_SECRET&envDescription=Your%20cloro%20API%20key%20plus%20two%20secrets%20you%20generate&project-name=geo-tracker&repository-name=geo-tracker&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

- **No dashboard, no UI** — the MCP endpoint and the
  [Grafana starter](./grafana/README.md) are the analysis layer.
- **$0 to run** — fits in the free tiers of Vercel and
  [Neon](https://neon.tech) Postgres. The deploy button provisions the
  Neon database for you and sets `DATABASE_URL` automatically.
- **Fully async** — scrapes are submitted as
  [cloro async tasks](https://docs.cloro.dev) and results come back by
  webhook, so no serverless function ever waits on a scrape.

```text
tick (cron) ──► GET /api/cron ──► POST api.cloro.dev/v1/async/task  (per due prompt × engine)
                                    │
cloro finishes the scrape ──────────┴──► POST /api/webhook ──► results row in your Postgres
```

## 10-minute quickstart

1. **Get a cloro API key** at [cloro.dev](https://cloro.dev).
2. **Deploy**: click the button above. Vercel clones the repo and walks you
   through creating a **Neon** database from its Marketplace — no separate
   Neon signup, and `DATABASE_URL` is injected for you as a pooled
   connection string.
3. **Fill in the three env vars** the form asks for: your `CLORO_API_KEY`,
   plus two secrets you generate yourself:

   ```bash
   openssl rand -hex 32   # run twice: once for APP_API_KEY, once for CRON_SECRET
   ```

4. **Create the tables** — clone the repo Vercel made for you, then:

   ```bash
   DATABASE_URL="<pooled string from the Vercel project>" npx drizzle-kit push
   ```

   Copy the value from your Vercel project's **Settings → Environment
   Variables**, or run `vercel env pull` to get a local `.env`.

5. **Create your first prompt**:

   ```bash
   curl -X POST https://<your-app>.vercel.app/api/prompts \
     -H "Authorization: Bearer $APP_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "best crm tools",
       "prompt": "What are the best CRM tools for a small startup?",
       "engines": ["chatgpt", "gemini", "perplexity"],
       "country": "US",
       "runsPerDay": 4
     }'
   ```

6. **Run it now** (instead of waiting for the schedule):

   ```bash
   curl -X POST https://<your-app>.vercel.app/api/prompts/<id>/run \
     -H "Authorization: Bearer $APP_API_KEY"
   ```

   The call returns immediately with pending task ids; results land in
   your database via webhook as each scrape finishes (typically within a
   few minutes). Check them with `GET /api/results`.

## Environment variables

| Variable               | Required | Purpose                                                                                                         |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `CLORO_API_KEY`        | yes      | Your cloro API key — pays for the scrapes                                                                       |
| `DATABASE_URL`         | yes      | Postgres connection string. Set for you by the Neon integration; supply it yourself only on other hosts         |
| `APP_API_KEY`          | yes      | Bearer token clients must send to use the REST API and MCP endpoint                                             |
| `CRON_SECRET`          | yes      | Protects `/api/cron` and the webhook callback URL; Vercel Cron sends it automatically                           |
| `APP_URL`              | no       | Public base URL for the webhook callback. Derived from `VERCEL_PROJECT_PRODUCTION_URL` on Vercel; set elsewhere |
| `CLORO_WEBHOOK_SECRET` | no       | Verify cloro's `X-Cloro-Signature` webhook signatures (if your cloro org has signing enabled)                   |
| `CLORO_API_URL`        | no       | Override the cloro API base URL (default `https://api.cloro.dev`)                                               |

## API

All endpoints except the webhook require
`Authorization: Bearer <APP_API_KEY>`.

| Method   | Path                   | Description                                                                         |
| -------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `GET`    | `/api/prompts`         | List prompts                                                                        |
| `POST`   | `/api/prompts`         | Create a prompt (`name`, `prompt`, `engines[]`, `country`, `runsPerDay`, `enabled`) |
| `GET`    | `/api/prompts/:id`     | Get one prompt                                                                      |
| `PATCH`  | `/api/prompts/:id`     | Update any subset of the prompt fields                                              |
| `DELETE` | `/api/prompts/:id`     | Delete a prompt and (cascade) its results                                           |
| `POST`   | `/api/prompts/:id/run` | Submit the prompt to its engines now; returns pending task ids (202)                |
| `GET`    | `/api/results`         | Query results (filters below)                                                       |
| `GET`    | `/api/cron`            | Scheduler tick — auth via `CRON_SECRET` (or `APP_API_KEY`)                          |
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
  --header "Authorization: Bearer <APP_API_KEY>"
```

Claude Desktop / Cursor (`mcpServers` config):

```json
{
  "geo-tracker": {
    "url": "https://<your-app>.vercel.app/api/mcp",
    "headers": {
      "Authorization": "Bearer <APP_API_KEY>"
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
   `Authorization: Bearer <CRON_SECRET>`.

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
pnpm db:push                 # create the tables
pnpm dev
```

Trigger a tick: `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron`.

Webhooks can't reach localhost — locally, results are picked up by the
polling sweep on the next cron tick (pending rows older than 10 minutes),
so just hit `/api/cron` again after a scrape completes.

## Data & retention

Two tables: `prompts` and `results`. Each run stores one row per engine
with the full raw cloro response as `jsonb` (typically a few KB). Neon's
free 0.5 GB comfortably holds months to years of daily runs; when you want
to trim, there's a retention query in
[`grafana/queries.sql`](./grafana/queries.sql).

## License

[MIT](./LICENSE)
