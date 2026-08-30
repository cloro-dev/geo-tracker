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
-- These read the tables the scheduler tick derives from results.response:
-- result_sources, result_brand_mentions, result_search_queries and
-- result_candidate_mentions. The Grafana macros are replaced here with
-- plain predicates so each block runs as-is in psql.
-- ============================================================

-- Named in answers
SELECT round(100.0 * count(*) FILTER (WHERE m.mentioned) / greatest(count(*), 1), 1) AS value
  FROM result_brand_mentions m
  JOIN brands b ON b.id = m.brand_id
  JOIN results r ON r.id = m.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google') AND m.brand_id = (SELECT id FROM brands WHERE is_own AND enabled LIMIT 1);

-- Cited in answers
SELECT round(100.0 * count(*) FILTER (WHERE m.cited) / greatest(count(*), 1), 1) AS value
  FROM result_brand_mentions m
  JOIN brands b ON b.id = m.brand_id
  JOIN results r ON r.id = m.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google') AND m.brand_id = (SELECT id FROM brands WHERE is_own AND enabled LIMIT 1);

-- Share of voice
SELECT round(100.0 * count(*) FILTER (WHERE m.mentioned AND b.is_own)
    / greatest(count(*) FILTER (WHERE m.mentioned), 1), 1) AS value
  FROM result_brand_mentions m
  JOIN brands b ON b.id = m.brand_id
  JOIN results r ON r.id = m.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google');

-- Answers analysed
SELECT count(DISTINCT r.id) AS value
  FROM results r
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google');

-- Brand ranking — named and cited
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
SELECT p.name AS "Prompt",
    count(*) AS "Answers",
    round(100.0 * count(*) FILTER (WHERE m.mentioned) / greatest(count(*), 1), 1) AS "Named %",
    round(100.0 * count(*) FILTER (WHERE m.cited) / greatest(count(*), 1), 1) AS "Cited %",
    round(avg(m.first_position) FILTER (WHERE m.mentioned)) AS "Avg position"
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

-- Top search queries the engines issued
SELECT q.query AS "Query",
    count(*) AS "Times",
    count(DISTINCT r.engine) AS "Engines",
    count(DISTINCT r.prompt_id) AS "Prompts"
  FROM result_search_queries q
  JOIN results r ON r.id = q.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google') AND q.kind = 'issued'
  GROUP BY q.query
  ORDER BY count(*) DESC, q.query
  LIMIT 40;

-- Named but not tracked — candidates worth adding
SELECT c.name AS "Name",
    sum(c.mention_count) AS "Mentions",
    count(DISTINCT r.engine) AS "Engines",
    count(DISTINCT r.prompt_id) AS "Prompts",
    max(r.completed_at)::date::text AS "Last seen"
  FROM result_candidate_mentions c
  JOIN results r ON r.id = c.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google')
    AND lower(c.name) NOT IN (SELECT lower(name) FROM brands)
  GROUP BY c.name
  ORDER BY sum(c.mention_count) DESC
  LIMIT 30;

-- Top YouTube videos — retrieved for your prompts
SELECT coalesce(s.label, s.url) AS "Video",
    count(DISTINCT s.result_id) AS "Answers"
  FROM result_sources s
  JOIN results r ON r.id = s.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google')
    AND (s.domain = 'youtube.com' OR s.domain = 'youtu.be'
         OR s.domain LIKE '%.youtube.com')
  GROUP BY s.url, s.label
  ORDER BY count(DISTINCT s.result_id) DESC
  LIMIT 20;

-- Top Reddit posts — retrieved for your prompts
SELECT coalesce(s.label, s.url) AS "Post",
    count(DISTINCT s.result_id) AS "Answers"
  FROM result_sources s
  JOIN results r ON r.id = s.result_id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google')
    AND (s.domain = 'reddit.com' OR s.domain = 'redd.it'
         OR s.domain LIKE '%.reddit.com')
  GROUP BY s.url, s.label
  ORDER BY count(DISTINCT s.result_id) DESC
  LIMIT 20;

-- Prompt redundancy — prompts that retrieve the same pages
WITH per_prompt AS (
    SELECT r.prompt_id, s.domain
    FROM result_sources s
    JOIN results r ON r.id = s.result_id
    WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google')
    GROUP BY r.prompt_id, s.domain
  )
  SELECT p1.name AS "Prompt",
    p2.name AS "Overlaps with",
    round(100.0 * count(*) / greatest(
      (SELECT count(*) FROM per_prompt x WHERE x.prompt_id = a.prompt_id), 1
    ), 1) AS "Shared domains %"
  FROM per_prompt a
  JOIN per_prompt b ON b.domain = a.domain AND b.prompt_id <> a.prompt_id
  JOIN prompts p1 ON p1.id = a.prompt_id
  JOIN prompts p2 ON p2.id = b.prompt_id
  GROUP BY p1.name, p2.name, a.prompt_id
  ORDER BY 3 DESC
  LIMIT 30;

-- Data quality — answers that retrieved nothing
SELECT date_trunc('day', r.completed_at) AS "time",
    r.engine AS metric,
    round(100.0 * count(*) FILTER (WHERE s.result_id IS NULL)
      / greatest(count(*), 1), 1) AS value
  FROM results r
  LEFT JOIN (SELECT DISTINCT result_id FROM result_sources) s
    ON s.result_id = r.id
  WHERE r.status = 'completed'
    AND r.completed_at > now() - interval '30 days'
    AND r.engine IN ('chatgpt','perplexity','gemini','aimode','google')
  GROUP BY 1, r.engine
  ORDER BY 1;
