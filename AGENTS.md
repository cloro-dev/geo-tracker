# AGENTS.md

Instructions for coding agents that work on this repository. If you want to
_use_ a running deployment instead, read the MCP section of the
[README](./README.md) — this file is about changing the code.

## What this is

geo-tracker schedules prompts against AI engines through the
[cloro API](https://cloro.dev), and stores every answer in Postgres. It is
a Next.js app with route handlers only: there are no pages and no UI.
Clients are agents (MCP) and scripts (REST).

## Setup

```bash
pnpm install
cp .env.example .env.local     # fill in CLORO_API_KEY and CRON_SECRET
pnpm db:migrate                # create the tables
pnpm dev
```

A local Postgres is enough:

```bash
docker run -d --name tracker-db -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
```

## Verify your change

Run all four before you report a change as done. CI runs the same set:

```bash
pnpm test
pnpm typecheck
pnpm format:check
pnpm build                     # must also pass with DATABASE_URL unset
```

Tests live beside the code as `lib/*.test.ts`, plus `test/api.test.ts` for
the route handlers. No test reaches the network — `fetch` is stubbed.

Two kinds:

- **Pure logic** (engines, webhooks, auth, cloro client, validation). Runs
  anywhere, needs nothing.
- **Database-backed** (`lib/runner.test.ts`, `test/api.test.ts`). Uses a
  real Postgres through `DATABASE_URL`, and **skips itself when that is
  unset**, so `pnpm test` on a laptop without Postgres still passes while
  quietly covering less. Export `DATABASE_URL` to run the full suite, as
  CI does.

Test against a real database rather than mocking Drizzle: what matters in
the runner is the atomic claim and a partial index, and a mocked query
builder would only assert that we called the mock.

For a manual check of a running server:

```bash
pnpm start
curl -i localhost:3000/api/prompts                                  # expect 401
curl -i -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/prompts
```

## Layout

| Path                 | Holds                                                      |
| -------------------- | ---------------------------------------------------------- |
| `app/api/*/route.ts` | HTTP surface: prompts, results, cron, webhook, mcp         |
| `lib/runner.ts`      | Scheduling: which prompts are due, submit, sweep           |
| `lib/extract.ts`     | Pure derivation: links and brand matches from a response   |
| `lib/refresh.ts`     | Writes the derived tables, a batch per tick                |
| `lib/cloro.ts`       | The only place that calls the cloro API                    |
| `lib/engines.ts`     | Engine slugs, task types, per-engine payload shape         |
| `lib/webhooks.ts`    | Callback URL, token derivation, signature checks           |
| `lib/db/schema.ts`   | Drizzle schema; the source of truth for the tables         |
| `drizzle/`           | Generated migrations. Commit them; never edit them by hand |

## Rules that are easy to break

**Never wait on a scrape.** Scrapes take minutes. This app submits async
cloro tasks and gets results by webhook, with a polling sweep as backup.
Do not add a code path that blocks a request until an answer is ready.

**Schema changes need a migration.** Edit `lib/db/schema.ts`, then run
`pnpm db:generate` and commit the file it writes. The build applies pending
migrations, so an uncommitted schema change silently does nothing in
production.

**Keep environment access lazy.** `lib/env.ts` reads variables through
getters that throw at first use, not at import. This is what lets
`next build` succeed with no database. Do not read `process.env` at module
scope.

**One secret, and its name is fixed.** `CRON_SECRET` is the bearer token
for REST and MCP, and Vercel Cron can only authenticate through a variable
with that exact name. `APP_API_KEY` is an optional override. Either alone
must keep working.

**The webhook token is derived, never the raw secret.** The callback URL
goes to a third party. `lib/webhooks.ts` sends an HMAC of the secret so a
leaked URL cannot be replayed against the API. Do not put the secret in a
URL.

**Google engines use a different field.** `google` and `google-news` send
`query`; every other engine sends `prompt`. `lib/engines.ts` owns this.

**Route handlers run on Node.** `pg` needs sockets, so any route that
touches the database keeps `export const runtime = "nodejs"`.

**Claim before you submit.** `runTick` sets `lastRunAt` in the same
statement that selects a due prompt, so two overlapping ticks cannot
submit twice. Keep that update atomic.

## Conventions

- TypeScript strict; no `any` unless you explain why.
- Prettier defaults, no ESLint. Run `pnpm format` before committing.
- Vitest is deliberate, not incidental. `node:test` cannot resolve the
  `@/` alias, so dropping it would mean rewriting production imports to
  suit the test runner and raising the required Node version. Keep it.
- REST handlers validate with the Zod schemas in `lib/validation.ts`. MCP
  tools declare their input schema inline, because the protocol publishes
  it to the client.
- Errors return `{ "error": { "message": ... } }`. Use `withErrors`.
- Prefer adding to an existing `lib/` module over creating a new one.

## Derived tables

`result_sources` and `result_brand_mentions` are computed from
`results.response` and can always be thrown away and rebuilt. Three rules
hold them together:

**Store the misses, not only the hits.** `result_brand_mentions` gets a row
for every completed result and every enabled brand, mentioned or not.
Share of voice needs a denominator, and a table of hits alone cannot show
the difference between "never named" and "never asked".

**A brand edit reopens the whole history.** Adding a brand, renaming one,
or changing its aliases or domains changes what the extractor would have
produced for answers that already arrived. Every write path that touches
those fields calls `markAllForReextraction()`. Skip it and the new brand's
chart begins on the day somebody remembered to add it, which reads as a
brand that appeared from nowhere. `isOwn` is exempt: it is a label the
extractor never reads.

**The refresh runs last in the tick and may stop early.** Submissions are
time-sensitive; this is not. It is bounded by a batch size and a time
budget, and the leftover work stays queued in `results.extraction_revision`
for the next tick. Bump `EXTRACTION_REVISION` when the extraction rules
change, and the whole history is re-derived on its own.

Extraction runs in the app, not in the database. Neon's free tier has no
`pg_cron`, so a materialised view would have nothing to refresh it.

`scripts/seed.mjs` fills a local database with synthetic answers so the
Grafana panels can be built without waiting a month for real data. It
writes prompts, brands and raw results, and derives nothing: run the tick
afterwards and the app fills the derived tables through the code that runs
in production. Prompts are seeded disabled, because an enabled prompt is
due the moment it exists and the tick would submit it to the real API.

## Out of scope

Do not add a web UI or a login system. Keep the dependency list small:
this has to stay free to run on a hobby plan.

**Do not add anything that scores, ranks or judges an answer.** The
product stores raw answers and lets agents interpret them.

The brand extraction added in `lib/extract.ts` is the one thing near that
line, and it stays on the safe side by being mechanical: the user declares
the brands, and the code does literal case-insensitive matching and
hostname comparison. It decides _whether a name is present_, never how
good an answer is, who is winning, or which brands are worth tracking. A
sentiment score, a quality grade, a recommendation, or a built-in list of
competitors would all cross it.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
