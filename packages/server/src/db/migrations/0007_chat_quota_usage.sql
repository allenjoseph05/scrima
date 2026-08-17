-- 0007 Chat quota usage
-- Daily per-user (and optionally per-match) counter for Ask-Your-Coach chat.
-- Authoritative quota enforcement; client-side counter is advisory only.
--
-- Additive-only. No existing table is touched. Safe to run online.
--
-- Shape:
--   (user_id, match_id, day_start) → count
-- * Brain chat uses match_id = '' (empty string — NOT NULL for unique key).
-- * Match Q&A uses the real match_id string.
-- * day_start is an ISO date (UTC midnight) so counters reset naturally at
--   the day boundary without a cron cleanup job.

CREATE TABLE IF NOT EXISTS "chat_quota_usage" (
  "user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "match_id"   text NOT NULL DEFAULT '',
  "day_start"  text NOT NULL,
  "count"      integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "uq_cqu_user_match_day" UNIQUE ("user_id", "match_id", "day_start")
);

CREATE INDEX IF NOT EXISTS "idx_cqu_user_day" ON "chat_quota_usage" ("user_id", "day_start");
