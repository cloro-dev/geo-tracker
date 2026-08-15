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
-- it; Neon's free tier holds months-to-years of daily runs regardless)
DELETE FROM results WHERE created_at < now() - interval '90 days';
