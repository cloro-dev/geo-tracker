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

Configure prompts once. geo-tracker runs them on a schedule against
ChatGPT, Gemini, Google AI Mode, Bing AI Mode, Google Search and Google
News through the [cloro API](https://cloro.dev), and stores every raw
response in your own Postgres.

**Built to be driven by an agent, not by a dashboard.** There is no UI to
click. Every capability is an MCP tool and a REST endpoint, so your agent
configures the prompts, triggers the runs and reads the answers itself:

> _"Track how ChatGPT and Gemini answer 'best CRM for startups', four
> times a day. Then tell me which brands they name most often."_

That one sentence is a `create_prompt` call, a `run_prompt` call and a
`get_results` call. You never touch a form.

- **Agent-ready** — one MCP endpoint exposes read _and_ write: an agent can
  add prompts, run them and query the answers without a human in the loop.
- **Your data, queryable** — plain Postgres, so an agent can also read it
  with SQL, and the [Grafana starter](./grafana/README.md) charts it.
- **$0 to run** — fits in Vercel's free tier, database included, until the
  derived tables outgrow it (see [Data & retention](#data--retention)).
- **Fully async** — scrapes are submitted as
  [cloro async tasks](https://cloro.dev/docs) and results come back by
  webhook, so no serverless function ever waits on a scrape.

```text
tick (cron) ──► GET /api/cron ──► POST api.cloro.dev/v1/async/task  (per due prompt × engine)
                                    │
cloro finishes the scrape ──────────┴──► POST /api/webhook ──► results row in your Postgres
```

## What is geo-tracker by cloro?

geo-tracker by cloro is a free, open-source (MIT) AI visibility tracker that
you host yourself. It sends your prompts to ChatGPT, Gemini, Google AI Mode
and Bing AI Mode on a schedule, stores every answer in your own Postgres, and
records which brands each answer names and which pages it cites. You pay only
for the scrapes, in [cloro](https://cloro.dev) credits.

### Which tool can I use to track AI search visibility?

geo-tracker by cloro tracks it from your own deployment. Add the questions
your buyers ask as prompts, add your brand and your competitors with
`track_brand`, and geo-tracker records for each answer whether it names
each brand and which of its domains it cites. `get_brand_visibility` returns
how often each brand was named and cited. The
[share of voice section](#how-do-you-calculate-share-of-voice-and-how-many-samples-do-you-need)
has the SQL for mention rate, citation rate and share of voice.

### Is there an open-source alternative to Peec AI or Otterly.AI?

geo-tracker by cloro is one. It is MIT-licensed and you run it on your own
Vercel and Postgres, so the answers stay in your database and you can read
them with SQL. It has no dashboard to click through: an agent drives it over
MCP, and a [Grafana dashboard](./grafana/README.md) charts the data. It does
not track Claude, Meta AI, Perplexity or the Copilot app.

### Which AI visibility tool tracks brand mentions in Google AI Mode?

geo-tracker by cloro does. Add `aimode` to a prompt's engines. Each AI Mode
answer gets a row per tracked brand in `result_brand_mentions`, and each
cited link a row in `result_sources`. The same works for `chatgpt`,
`gemini` and `bing-aimode`.

### How do I get alerted when my brand disappears from ChatGPT answers?

geo-tracker by cloro stores the data, and Grafana sends the alert. Track the
prompt on `chatgpt`, track your brand, and connect Grafana to your Postgres.
Then create a Grafana alert rule on the mention rate query in the share of
voice section, filtered to `engine = 'chatgpt'`, that fires when the rate
drops below your threshold. geo-tracker has no alerting of its own.

### Which domains does ChatGPT cite most often for my prompts?

geo-tracker by cloro stores one row per cited link in `result_sources`, with
its domain. Count the rows by domain for `chatgpt` results:

```sql
SELECT s.domain, count(DISTINCT s.result_id) AS answers
FROM result_sources s
JOIN results r ON r.id = s.result_id
WHERE r.engine = 'chatgpt'
  AND s.kind IN ('source', 'citation_pill')
GROUP BY s.domain
ORDER BY answers DESC
LIMIT 20;
```

### How many prompts a day can it run?

Each prompt runs 1 to 24 times a day on each engine you choose. Every run is
a cloro async task, so no function waits on a scrape. Storage sets the
practical limit: about 25 KB per engine per run. The
[Data & retention](#data--retention) table shows how long Vercel's free
0.5 GB lasts at 30, 320 and 2,400 scrapes a day.

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
> a small startup are. Track it on ChatGPT, Gemini and AI Mode, four
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
    "engines": ["chatgpt", "gemini", "aimode"],
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

Engines: `chatgpt`, `gemini`, `aimode` (Google AI Mode), `bing-aimode`
(Bing AI Mode), `google`, `google-news`.

`bing-aimode` has these limits:

- The prompt can have a maximum of 3,500 characters after URL encoding.
  Non-Latin scripts encode to more characters, so their limit is lower.
- The country cannot be BY, CN, IR, RU, SY or VE.

geo-tracker does not check these limits. A run that does not obey them
fails, and geo-tracker stores it as `failed` for that engine only.

`copilot`, `perplexity` and `grok` are discontinued. A prompt that still
lists one of them skips it. Old results stay readable: `engine=copilot`,
`engine=perplexity` and `engine=grok` still work as results filters.

- `grok` (15 October 2026): grok.com shows a sign-up wall to logged-out
  visitors, so cloro cannot get Grok answers.
- `copilot`: Copilot blocks access for logged-out sessions.
- `perplexity`: Perplexity blocks access for logged-out sessions.

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
  Gemini."
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
tells you how many results are queued.

**A deployment with history takes a while to catch up.** The tick derives
250 results, and Vercel's Hobby plan runs one cron a day — so re-deriving
a year of answers would take months of ticks. Two ways round it, and the
tick is idempotent so either is safe:

- Point an external scheduler (GitHub Actions, cron-job.org) at
  `/api/cron` every few minutes until `more` comes back `false`.
- Or call it by hand in a loop:

  ```bash
  while curl -s -H "Authorization: Bearer $CRON_SECRET" \
    https://<your-app>.vercel.app/api/cron | grep -q '"more":true'; do :; done
  ```

Nothing is missing while it runs. The old rows stay until each result is
rebuilt, so the dashboard shows values that are stale, never blank.

`result_search_queries` holds a third thing: the literal queries the
engines typed before retrieving anything. Of the engines a prompt can track,
only ChatGPT reports these. Copilot, Grok and Perplexity results from before
their discontinuation can also have them.

To watch a competitor without tracking it, add its name to
`lib/brand-candidates.json`, with any alternative spellings:

```json
{ "name": "Acme", "aliases": ["Acme, Inc", "Acme Corp"] }
```

Names there that turn up in answers, and that you are not tracking,
surface as a shortlist worth adding. The file ships with fictional
placeholders to replace — geo-tracker does not guess who competes with
you, and it cannot find a brand nobody wrote down.

Nothing here scores or ranks an answer. It records whether a name is
present. What that means is the agent's call.

## How do you calculate share of voice and how many samples do you need?

The two brand tables above give three different numbers per brand. They
answer different questions, and they can put brands in a different order.

| Measure | Formula | From |
| --- | --- | --- |
| Mention rate | answers that name the brand / answers | `result_brand_mentions.mentioned` |
| Citation rate | answers whose cited links include a brand domain / answers | `result_sources.domain` against `brands.domains` |
| Share of voice | answers that name the brand / sum of the same count over every enabled brand | `result_brand_mentions.mentioned` |

"Answers" here means completed results that carry prose: the answer of a
chat engine, or the AI Overview of a Google result. A Google result with no
AI Overview has a row for each brand with `mentioned = false`, so it is left
out of the denominator. Share of voice depends on the brand list: when you
add a brand, the share of every other brand goes down, and the history is
re-derived with it.

The query below computes all three over the last 30 days:

```sql
-- Mention rate, citation rate and share of voice per tracked brand, last 30 days.
WITH answers AS (  -- results that carry an answer: AI prose or an AI Overview
  SELECT r.id
  FROM results r
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt', 'gemini', 'aimode', 'bing-aimode', 'google')
    AND coalesce(r.response #>> '{result,text}',
                 r.response #>> '{result,aioverview,text}', '') <> ''
),
scored AS (
  SELECT b.name,
         m.mentioned,
         EXISTS (  -- a brand domain among the answer's citations (not organic links or ads)
           SELECT 1
           FROM result_sources s, unnest(b.domains) AS d(domain)
           WHERE s.result_id = m.result_id
             AND s.kind IN ('source', 'citation_pill', 'ai_overview')
             AND (s.domain = lower(d.domain) OR s.domain LIKE '%.' || lower(d.domain))
         ) AS cited
  FROM result_brand_mentions m
  JOIN answers a ON a.id = m.result_id
  JOIN brands b ON b.id = m.brand_id
  WHERE b.enabled
),
per_brand AS (
  SELECT name,
         count(*) AS answers,
         count(*) FILTER (WHERE mentioned) AS named,
         count(*) FILTER (WHERE cited) AS cited
  FROM scored
  GROUP BY name
)
SELECT name AS brand,
       round(100.0 * named / answers, 1) AS mention_rate_pct,
       round(100.0 * cited / answers, 1) AS citation_rate_pct,
       round(100.0 * named / nullif(sum(named) OVER (), 0), 1) AS share_of_voice_pct
FROM per_brand
ORDER BY share_of_voice_pct DESC NULLS LAST;
```

The citation rate reads `result_sources` and not `result_brand_mentions.cited`.
The `cited` column counts a brand domain in any link of the payload, and on
a Google result that includes the organic results and the ads. The query
keeps only the links the answer cites (`source`, `citation_pill` and
`ai_overview`). To split the numbers by engine, carry `r.engine` through each
step, add it to the `GROUP BY`, and use `sum(named) OVER (PARTITION BY engine)`.

**How many runs does a mention rate need?** Each answer either names the
brand or does not, so a mention rate behaves like a binomial proportion. For
a 95% interval of plus or minus E around a rate p, you need about
n = 1.96² × p × (1 - p) / E² answers:

| Mention rate p | Runs for ±10 points | Runs for ±5 points |
| --- | ---: | ---: |
| 0.1 | 35 | 139 |
| 0.3 | 81 | 323 |
| 0.5 | 97 | 385 |

With `runsPerDay: 1`, one prompt on one engine gives 7 answers a week, so a
weekly rate for one prompt is accurate to about ±37 points at p = 0.5. To get
closer, add runs (`runsPerDay`), add engines, or report the rate over a set of
prompts rather than over one.

Answers for the same prompt also change from run to run. In cloro's own
monitoring of five AI engines over 30 days (October 17 to November 15, 2026),
a brand named in one day's answer was named again the next day 67% of the time
at the median, and the two days' brand lists had a median Jaccard overlap of
0.40. Compare rates over many runs, never two single answers.

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

Two tables hold what you asked and what came back: `prompts` and
`results`. Each run stores one row per engine with the full raw cloro
response as `jsonb` — measured at **10–30 KB per row**, so budget roughly
20 KB per engine per run.

Four more are derived from those responses by the scheduler tick
(`result_sources`, `result_brand_mentions`, `result_search_queries`,
`result_candidate_mentions`). They add about **5 KB per answer**, so
budget ~25 KB per engine per run in total. That figure scales with how
many links an answer carries, not with how big its payload is, so a chatty
engine costs more here than a terse one with a large HTML blob.

Storage is the limit you hit first, well before anything on Vercel. The
figures below include the derived rows:

| Workload                       | Scrapes/day | Storage/month | 0.5 GB lasts |
| ------------------------------ | ----------- | ------------- | ------------ |
| 10 prompts × 3 engines × 1/day | 30          | ~23 MB        | ~1.8 years   |
| 20 prompts × 4 engines × 4/day | 320         | ~240 MB       | ~2 months    |
| 50 prompts × 6 engines × 8/day | 2,400       | ~1.8 GB       | ~8 days      |

Deleting a result cascades to its derived rows, so a retention policy
needs no extra step.

The same workloads use under 1%, 1% and 7% of Vercel's free monthly
function invocations, so the compute side stays free throughout.

Past light usage, schedule the retention query in
[`grafana/queries.sql`](./grafana/queries.sql) — deleting results older
than 90 days keeps any of these workloads inside the free tier
indefinitely.

## License

[MIT](./LICENSE)
