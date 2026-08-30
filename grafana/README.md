# Grafana starter

A minimal dashboard over the geo-tracker database: run volume, success
rate, credits burn, and recent failures. Works with the free tier of
[Grafana Cloud](https://grafana.com/products/cloud/) or any self-hosted
Grafana — all it needs is a Postgres datasource pointed at your database.

## 1. Create a read-only database role (recommended)

Grafana only needs to read. Run this against your database:

```sql
CREATE ROLE grafana_reader WITH LOGIN PASSWORD 'choose-a-password';
GRANT CONNECT ON DATABASE your_database TO grafana_reader;
GRANT USAGE ON SCHEMA public TO grafana_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO grafana_reader;
```

Replace `your_database` with your actual database name.

## 2. Add the Postgres datasource

In Grafana: **Connections → Data sources → Add data source → PostgreSQL**.

| Field         | Value                       |
| ------------- | --------------------------- |
| Host URL      | your Postgres host and port |
| Database name | your database name          |
| Username      | `grafana_reader`            |
| Password      | the password you chose      |
| TLS/SSL Mode  | `require`                   |

Click **Save & test**.

## 3. Import the dashboard

**Dashboards → New → Import**, upload [`dashboard.json`](./dashboard.json),
and pick the datasource you just created when prompted.

## The brand-visibility dashboard

[`geo-visibility.json`](./geo-visibility.json) is the second dashboard:
which brands the engines name, which pages they cite, and where you are
losing. Import it the same way as the first one.

It needs at least one brand configured with `is_own = true` — several
panels are written against "your" brand, and are empty without one:

```bash
curl -X POST https://<your-app>.vercel.app/api/brands \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "content-type: application/json" \
  -d '{"name":"Acme","domains":["acme.io"],"isOwn":true}'
```

It also reads `result_sources` and `result_brand_mentions`, which the
scheduler tick fills. A freshly imported dashboard is empty until a tick
has run — that is a queue waiting, not a broken panel.

Two things the panels are built to keep apart:

- **Named and cited are different outcomes.** An answer can recommend you
  without linking you, or link you without naming you. No panel pools them.
- **The misses are counted.** A brand that is never named holds rows at 0%
  rather than dropping out, so every percentage has an honest denominator.

Google is expected to sit low on "Named %": it returns a page of links and
only writes prose when an AI Overview was served. Its "Cited %" is the
meaningful number there.

## Building your own panels

Every panel's SQL from both dashboards lives standalone in
[`queries.sql`](./queries.sql) — copy, tweak, add. The Grafana macros are
replaced there with plain predicates, so each block runs as-is in `psql`.

Four tables: `prompts` and `results` hold what was asked and what came
back, and `result_sources` and `result_brand_mentions` are derived from
`results.response` by the scheduler tick. `results.response` still holds
the full raw payload as `jsonb`, so Postgres JSON operators
(`response -> 'field'`) work in panels too when the derived tables do not
have what you need.
