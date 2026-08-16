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

Tests live beside the code as `lib/*.test.ts` and cover the logic that
fails silently: engine payload shapes, webhook token derivation and
signatures, the single-secret auth fallback, the cloro client's error
handling, and the validation schemas. They need no database and no network
— `lib/cloro.test.ts` stubs `fetch`. Keep it that way.

The routes and `lib/runner.ts` are not covered yet, because they need a
database. If you add coverage there, use a real Postgres rather than
mocking Drizzle. For a manual check of a running server:

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
- REST handlers validate with the Zod schemas in `lib/validation.ts`. MCP
  tools declare their input schema inline, because the protocol publishes
  it to the client.
- Errors return `{ "error": { "message": ... } }`. Use `withErrors`.
- Prefer adding to an existing `lib/` module over creating a new one.

## Out of scope

Do not add a web UI, a login system, or an analysis layer that scores or
classifies answers. The product stores raw answers and lets agents
interpret them. Keep the dependency list small: this has to stay free to
run on a hobby plan.
