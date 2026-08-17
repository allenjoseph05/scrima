-- 0010 Tag observations with the agent the player was using
--
-- Without this tag, M1 hybrid retrieval pulls observations from any agent
-- the player has used — which leaks Yoru ability mentions into Phoenix
-- chats and so on. Adding the tag lets us boost or filter by current
-- agent context.
--
-- Backfill from coaching_reports.resolved_agent (which migration 0008
-- already populated from JSONB). Observations whose source report can't
-- be resolved keep agent=NULL and behave as today (cross-agent fallback).

ALTER TABLE player_observations
  ADD COLUMN IF NOT EXISTS "agent" text;

UPDATE player_observations po
SET agent = LOWER(cr.resolved_agent)
FROM coaching_reports cr
WHERE po.report_id = cr.id
  AND cr.resolved_agent IS NOT NULL
  AND po.agent IS NULL;

CREATE INDEX IF NOT EXISTS "idx_po_user_agent_active"
  ON player_observations (user_id, agent)
  WHERE valid_until IS NULL AND archived = false;
