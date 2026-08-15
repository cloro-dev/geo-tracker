# Grafana starter

A minimal dashboard over the geo-tracker database: run volume, success
rate, credits burn, and recent failures. Works with the free tier of
[Grafana Cloud](https://grafana.com/products/cloud/) or any self-hosted
Grafana — all it needs is a Postgres datasource pointed at your database.

## 1. Create a read-only database role (recommended)

Grafana only needs to read. On your database (e.g. the Neon SQL editor):

```sql
CREATE ROLE grafana_reader WITH LOGIN PASSWORD 'choose-a-password';
GRANT CONNECT ON DATABASE neondb TO grafana_reader;
GRANT USAGE ON SCHEMA public TO grafana_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO grafana_reader;
```

Replace `neondb` with your database name.

## 2. Add the Postgres datasource

In Grafana: **Connections → Data sources → Add data source → PostgreSQL**.

| Field         | Value                                         |
| ------------- | --------------------------------------------- |
| Host URL      | your Postgres host (e.g. `...neon.tech:5432`) |
| Database name | your database name                            |
| Username      | `grafana_reader`                              |
| Password      | the password you chose                        |
| TLS/SSL Mode  | `require`                                     |

Click **Save & test**.

## 3. Import the dashboard

**Dashboards → New → Import**, upload [`dashboard.json`](./dashboard.json),
and pick the datasource you just created when prompted.

## Building your own panels

Every panel's SQL lives standalone in [`queries.sql`](./queries.sql) —
copy, tweak, add. The schema is just two tables (`prompts`, `results`);
`results.response` holds the full raw engine response as `jsonb`, so
Postgres JSON operators (`response -> 'field'`) work in panels too.
