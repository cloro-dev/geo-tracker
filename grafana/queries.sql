-- Standalone versions of the dashboard panel queries, ready to adapt.
-- All timestamps are timestamptz; replace the intervals to taste.

-- Completed runs in the last 24 hours
SELECT count(*) AS runs
FROM results
WHERE status = 'completed'
  AND created_at > now() - interval '24 hours';

-- Success rate over the last 24 hours (completed vs failed, in %)
SELECT round(
  100.0 * count(*) FILTER (WHERE status = 'completed')
    / greatest(count(*) FILTER (WHERE status IN ('completed', 'failed')), 1),
  1
) AS success_rate
FROM results
WHERE created_at > now() - interval '24 hours';

-- Credits used over the last 7 days
SELECT coalesce(sum(credits_charged), 0) AS credits
FROM results
WHERE created_at > now() - interval '7 days';

-- Runs per day by engine (last 30 days)
SELECT date_trunc('day', created_at) AS day,
       engine,
       count(*) AS runs
FROM results
WHERE created_at > now() - interval '30 days'
GROUP BY 1, 2
ORDER BY 1;

-- Credits per day (last 30 days)
SELECT date_trunc('day', created_at) AS day,
       sum(credits_charged) AS credits
FROM results
WHERE created_at > now() - interval '30 days'
GROUP BY 1
ORDER BY 1;

-- Recent failures with prompt names
SELECT p.name,
       r.engine,
       r.error,
       r.created_at
FROM results r
JOIN prompts p ON p.id = r.prompt_id
WHERE r.status = 'failed'
ORDER BY r.created_at DESC
LIMIT 20;

-- Retention: delete results older than 90 days (run manually or schedule
-- it; the free tier holds months-to-years of daily runs regardless)
DELETE FROM results WHERE created_at < now() - interval '90 days';


-- ============================================================
-- Brand visibility (geo-visibility.json)
--
-- These read result_sources and result_brand_mentions, the tables the
-- scheduler tick derives from results.response. The Grafana macros are
-- replaced here with plain predicates so each block runs as-is in psql.
-- ============================================================

-- Named in answers
-- Share of completed answers naming your brand. Denominator is every answer.
SELECT round(100.0 * count(*) FILTER (WHERE m.mentioned) / greatest(count(*), 1), 1) AS value
  FROM result_brand_mentions m
  JOIN brands b ON b.id = m.brand_id
  JOIN results r ON r.id = m.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google') AND m.brand_id = (SELECT id FROM brands WHERE is_own AND enabled LIMIT 1);

-- Cited in answers
-- Share of answers linking one of your own domains.
SELECT round(100.0 * count(*) FILTER (WHERE m.cited) / greatest(count(*), 1), 1) AS value
  FROM result_brand_mentions m
  JOIN brands b ON b.id = m.brand_id
  JOIN results r ON r.id = m.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google') AND m.brand_id = (SELECT id FROM brands WHERE is_own AND enabled LIMIT 1);

-- Share of voice
-- Your mentions as a share of every tracked brand's mentions.
SELECT round(100.0 * count(*) FILTER (WHERE m.mentioned AND b.is_own)
    / greatest(count(*) FILTER (WHERE m.mentioned), 1), 1) AS value
  FROM result_brand_mentions m
  JOIN brands b ON b.id = m.brand_id
  JOIN results r ON r.id = m.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google');

-- Answers analysed
-- Completed runs in range. Failed runs are excluded everywhere.
SELECT count(DISTINCT r.id) AS value
  FROM results r
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google');

-- Brand ranking — named and cited
-- Every brand, including ones never named — they hold a row at 0%.
SELECT b.name || CASE WHEN b.is_own THEN ' (us)' ELSE '' END AS "Brand",
    count(*) AS "Answers",
    round(100.0 * count(*) FILTER (WHERE m.mentioned) / greatest(count(*), 1), 1) AS "Named %",
    round(100.0 * count(*) FILTER (WHERE m.cited) / greatest(count(*), 1), 1) AS "Cited %"
  FROM result_brand_mentions m
  JOIN brands b ON b.id = m.brand_id
  JOIN results r ON r.id = m.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google')
  GROUP BY b.id, b.name, b.is_own
  ORDER BY "Named %" DESC;

-- Visibility over time — every tracked brand
-- Daily mention rate per brand.
SELECT date_trunc('day', r.completed_at) AS "time",
    b.name AS metric,
    round(100.0 * count(*) FILTER (WHERE m.mentioned) / greatest(count(*), 1), 1) AS value
  FROM result_brand_mentions m
  JOIN brands b ON b.id = m.brand_id
  JOIN results r ON r.id = m.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google')
  GROUP BY 1, b.name
  ORDER BY 1;

-- Our visibility by engine
-- Your visibility split by engine. Google sits low on Named % by construction.
SELECT r.engine AS "Engine",
    round(100.0 * count(*) FILTER (WHERE m.mentioned) / greatest(count(*), 1), 1) AS "Named %",
    round(100.0 * count(*) FILTER (WHERE m.cited) / greatest(count(*), 1), 1) AS "Cited %"
  FROM result_brand_mentions m
  JOIN brands b ON b.id = m.brand_id
  JOIN results r ON r.id = m.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google') AND m.brand_id = (SELECT id FROM brands WHERE is_own AND enabled LIMIT 1)
  GROUP BY r.engine
  ORDER BY "Named %" DESC;

-- Every prompt — how we do on each
-- Per prompt, worst first.
SELECT p.name AS "Prompt",
    count(*) AS "Answers",
    round(100.0 * count(*) FILTER (WHERE m.mentioned) / greatest(count(*), 1), 1) AS "Named %",
    round(100.0 * count(*) FILTER (WHERE m.cited) / greatest(count(*), 1), 1) AS "Cited %"
  FROM result_brand_mentions m
  JOIN brands b ON b.id = m.brand_id
  JOIN results r ON r.id = m.result_id
  JOIN prompts p ON p.id = r.prompt_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google') AND m.brand_id = (SELECT id FROM brands WHERE is_own AND enabled LIMIT 1)
  GROUP BY p.id, p.name
  ORDER BY "Named %" ASC;

-- Pages to get listed on
-- Third-party pages the engines retrieved, and how often you were named alongside them.
SELECT s.domain AS "Domain",
    count(DISTINCT s.result_id) AS "Answers citing it",
    count(DISTINCT r.prompt_id) AS "Prompts",
    round(100.0 * count(DISTINCT s.result_id) FILTER (WHERE own.mentioned)
      / greatest(count(DISTINCT s.result_id), 1), 1) AS "Named us %"
  FROM result_sources s
  JOIN results r ON r.id = s.result_id
  LEFT JOIN result_brand_mentions own
    ON own.result_id = s.result_id AND own.brand_id = (SELECT id FROM brands WHERE is_own AND enabled LIMIT 1)
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google')
    AND s.domain NOT IN (SELECT unnest(domains) FROM brands)
  GROUP BY s.domain
  ORDER BY "Answers citing it" DESC
  LIMIT 30;

-- Our own pages — retrieved, and did the answer name us?
-- Your own pages, and what kind of slot they were cited in.
SELECT s.domain AS "Domain",
    s.kind AS "Cited as",
    count(DISTINCT s.result_id) AS "Answers citing it",
    round(100.0 * count(DISTINCT s.result_id) FILTER (WHERE own.mentioned)
      / greatest(count(DISTINCT s.result_id), 1), 1) AS "Named us %"
  FROM result_sources s
  JOIN results r ON r.id = s.result_id
  LEFT JOIN result_brand_mentions own
    ON own.result_id = s.result_id AND own.brand_id = (SELECT id FROM brands WHERE is_own AND enabled LIMIT 1)
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google')
    AND s.domain IN (
      SELECT unnest(domains) FROM brands WHERE is_own AND enabled
    )
  GROUP BY s.domain, s.kind
  ORDER BY "Answers citing it" DESC;
