-- 0006 Coaching Resolution Fields
-- Additive-only columns supporting the Your Coach redesign foundation.
--
-- See: docs/YOUR_COACH_FOUNDATION.md §1 (agent/map resolution) and §6.5.
--
-- Nothing destructive. Every column is nullable. Defaults are neutral.
-- Existing rows receive the default (or NULL) without rewrite on PG 11+.
-- Safe to run online against Neon.

-- ── matches: user confirmation of agent/map ─────────────────────────────────
-- Resolution priority: user_confirmed > user_entered(matches.agent) > vlm_* > unknown
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "user_confirmed_agent" text;
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "user_confirmed_map" text;
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "agent_confirmed_at" timestamp with time zone;
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "map_confirmed_at" timestamp with time zone;

-- ── coaching_reports: separate VLM guess from resolved truth + context ─────
-- vlm_* = raw VLM detection (preserved for QA / prompt-tuning accuracy metrics)
-- resolved_* = value used by UI + coaching (result of resolveAgentMap())
-- report_schema_version = 2 today, 3 once canonical v3 parser ships
ALTER TABLE "coaching_reports" ADD COLUMN IF NOT EXISTS "vlm_detected_agent" text;
ALTER TABLE "coaching_reports" ADD COLUMN IF NOT EXISTS "vlm_detected_map" text;
ALTER TABLE "coaching_reports" ADD COLUMN IF NOT EXISTS "vlm_agent_confidence" text;
ALTER TABLE "coaching_reports" ADD COLUMN IF NOT EXISTS "vlm_map_confidence" text;
ALTER TABLE "coaching_reports" ADD COLUMN IF NOT EXISTS "resolved_agent" text;
ALTER TABLE "coaching_reports" ADD COLUMN IF NOT EXISTS "resolved_map" text;
ALTER TABLE "coaching_reports" ADD COLUMN IF NOT EXISTS "rank_at_time" text;
ALTER TABLE "coaching_reports" ADD COLUMN IF NOT EXISTS "report_schema_version" integer DEFAULT 2;

-- ── player_observations: agree/disagree confidence for Brain self-model ────
-- confidence defaults to 0.5 (neutral/unconfirmed). Agree → 1.0, disagree → 0.0.
ALTER TABLE "player_observations" ADD COLUMN IF NOT EXISTS "confidence" real DEFAULT 0.5;
ALTER TABLE "player_observations" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;
ALTER TABLE "player_observations" ADD COLUMN IF NOT EXISTS "disagreed_at" timestamp with time zone;

-- ── player_skill_mastery: ZPD tracking timestamps ──────────────────────────
-- active_since_at = when the skill first entered the 0.3–0.7 ZPD band
-- last_grade_at   = last time mastery crossed 0.7 (graduation event)
ALTER TABLE "player_skill_mastery" ADD COLUMN IF NOT EXISTS "active_since_at" timestamp with time zone;
ALTER TABLE "player_skill_mastery" ADD COLUMN IF NOT EXISTS "last_grade_at" timestamp with time zone;
