# geo-tracker

**Agent-ready GEO (Generative Engine Optimization) + SEO tracker. An MCP
server your agent drives: it schedules prompts across the AI engines and
Google Search, and keeps every answer in your own Postgres.**

## ⚡ 1-click deploy this tool

[![1-click deploy to Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcloro-dev%2Fgeo-tracker&env=CLORO_API_KEY,CRON_SECRET&envDescription=CLORO_API_KEY%3A%20sign%20up%20at%20cloro.dev%20to%20get%20a%20free%20API%20key.%20CRON_SECRET%3A%20any%20random%20string%20you%20choose%2C%20e.g.%20from%20openssl%20rand%20-hex%2032.&envLink=https%3A%2F%2Fgithub.com%2Fcloro-dev%2Fgeo-tracker%23environment-variables&project-name=geo-tracker&repository-name=geo-tracker&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

**Your own tracker, live in about a minute.** The button forks the repo,
creates the database, applies the schema and deploys. You paste two
values; there is nothing to install and nothing to configure afterwards.
Free tier all the way through.

---

Configure prompts once; geo-tracker runs them on a schedule against
ChatGPT, Gemini, Copilot, Perplexity, Grok, Google AI Mode, Google Search
and Google News — powered by the [cloro API](https://cloro.dev) — and
stores every raw response in your own Postgres.

**Built to be driven by an agent, not by a dashboard.** There is no UI to
click. Every capability is an MCP tool and a REST endpoint, so your agent
configures the prompts, triggers the runs and reads the answers itself:

> _"Track how ChatGPT and Perplexity answer 'best CRM for startups', four
> times a day. Then tell me which brands they name most often."_

That one sentence is a `create_prompt` call, a `run_prompt` call and a
`get_results` call. You never touch a form.

- **Agent-ready** — one MCP endpoint exposes read _and_ write: an agent can
  add prompts, run them and query the answers without a human in the loop.
- **Your data, queryable** — plain Postgres, so an agent can also read it
  with SQL, and the [Grafana starter](./grafana/README.md) charts it.
- **$0 to run** — fits in Vercel's free tier, database included.
- **Fully async** — scrapes are submitted as
  [cloro async tasks](https://cloro.dev/docs) and results come back by
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

Use the [1-click deploy](#-1-click-deploy-this-tool) button at the top. It
clones this repo into your own GitHub account, provisions a database, and
deploys. Vercel asks for four things, in this order:

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

### 4. Connect your agent

Point an MCP client at the deployment — this is the intended way to use it:

```bash
claude mcp add --transport http geo-tracker \
  https://<your-app>.vercel.app/api/mcp \
  --header "Authorization: Bearer <CRON_SECRET>"
```

Then just ask:

> _"Add a prompt called 'best crm tools' asking what the best CRM tools for
> a small startup are. Track it on ChatGPT, Gemini and Perplexity, four
> times a day. Run it now and show me the results."_

The agent calls `create_prompt`, then `run_prompt`, then `get_results`.
Results land in your database via webhook as each scrape finishes,
typically within a minute.

See [MCP](#mcp--the-agent-interface) for every tool and for Claude Desktop
and Cursor configuration.

### 5. Or drive it with plain HTTP

Everything the agent does is a REST call, so scripts and CI work too:

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

# run it now instead of waiting for the schedule
curl -X POST https://<your-app>.vercel.app/api/prompts/<id>/run \
  -H "Authorization: Bearer $CRON_SECRET"
```

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
| `GET`    | `/api/brands`          | List tracked brands                                                                 |
| `POST`   | `/api/brands`          | Track a brand (`name`, `aliases[]`, `domains[]`, `isOwn`, `enabled`)                |
| `GET`    | `/api/brands/:id`      | Get one brand                                                                       |
| `PATCH`  | `/api/brands/:id`      | Update any subset of the brand fields                                               |
| `DELETE` | `/api/brands/:id`      | Delete a brand and (cascade) its mention rows                                       |
| `GET`    | `/api/cron`            | Scheduler tick — same bearer token                                                  |
| `POST`   | `/api/webhook`         | cloro result callback — auth via token in the callback URL                          |
| `*`      | `/api/mcp`             | MCP endpoint (Streamable HTTP)                                                      |

Engines: `chatgpt`, `gemini`, `copilot`, `perplexity`, `grok`, `aimode`,
`google`, `google-news`.

`GET /api/results` filters (query params): `promptId`, `engine`,
`status` (`pending` | `completed` | `failed`), `from`, `to` (ISO dates),
`limit` (default 50, max 200). The raw `response` payload is omitted from
lists; add `include=response` to get it.

## MCP — the agent interface

The MCP endpoint is the primary way to use geo-tracker. It is not a
read-only reporting layer: an agent can create prompts, trigger runs and
pull the stored answers, which is the whole product surface.

| Tool                   | What the agent can do                                 |
| ---------------------- | ----------------------------------------------------- |
| `list_prompts`         | See what is being tracked, and when each last ran     |
| `create_prompt`        | Add a prompt, pick the engines, set how often it runs |
| `run_prompt`           | Run one now instead of waiting for the schedule       |
| `get_results`          | Query runs by prompt, engine or status                |
| `get_result`           | Pull one full raw engine answer for analysis          |
| `list_brands`          | See which brands are being looked for                 |
| `track_brand`          | Start looking for a brand, with aliases and domains   |
| `untrack_brand`        | Stop looking for one, and drop its derived rows       |
| `get_brand_visibility` | How often each brand was named, and cited             |

Things worth asking an agent once it is connected:

- "Add these ten questions our buyers ask, tracked daily on ChatGPT and
  Perplexity."
- "Which brands does Gemini name when asked about us, and how has that
  changed this month?"
- "Run every prompt now and summarise what changed since yesterday."
- "Which of our pages get cited in AI answers, and which never do?"

Because the answers are stored as raw payloads, the agent does the
analysis — geo-tracker only guarantees the data is there, complete and
timestamped.

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

Transport is Streamable HTTP, and the bearer token is the same secret the
REST API uses. Any MCP-capable client works — Claude Code, Claude Desktop,
Cursor, or your own agent built on an SDK.

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

## Brand visibility

Tell geo-tracker which brands to look for, and every answer is flattened
into two tables you can query or chart:

```bash
curl -X POST https://<your-app>.vercel.app/api/brands \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "content-type: application/json" \
  -d '{"name":"Acme","aliases":["Acme Corp"],"domains":["acme.io"],"isOwn":true}'
```

- `result_sources` — one row per link an engine returned, tagged by where
  it came from (`source`, `citation_pill`, `organic`, `ad`, …). This is
  the "which pages get cited" question.
- `result_brand_mentions` — one row per answer per brand, including the
  brands that were **not** named. That is what makes share of voice
  computable: a brand at 0% has rows saying so, rather than being absent.

Being **named** in the prose and being **cited** as a link are stored
separately, because they are different outcomes — an answer can recommend
you without linking you, or link you without naming you.

Adding or editing a brand re-scores every answer already stored, so a
brand you add today has full history rather than starting at zero. The
work happens in the scheduler tick, a batch at a time; the API response
tells you how many results were queued.

`result_search_queries` holds a third thing: the literal queries the
engines typed before retrieving anything. ChatGPT, Copilot, Grok and
Perplexity report these; the others do not.

To watch a competitor without tracking it, add its name to
`lib/brand-candidates.json`. Names there that turn up in answers, and that
you are not tracking, surface as a shortlist worth adding. The file ships
empty — geo-tracker does not guess who competes with you, and it cannot
find a brand nobody wrote down.

Nothing here scores or ranks an answer. It records whether a name is
present. What that means is the agent's call.

## Grafana

A ready-made dashboard (run volume, success rate, credits burn, failures)
lives in [`grafana/`](./grafana/README.md) — point Grafana Cloud's free
tier at your Postgres and import one JSON file.

Grafana runs outside Vercel: it is a long-running server, and Vercel hosts
serverless functions. Grafana Cloud's free tier reads your database
directly over TLS, which is all this needs.

## Local development

Contributing with a coding agent? [`AGENTS.md`](./AGENTS.md) documents the
commands, the layout and the invariants that are easy to break.

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
