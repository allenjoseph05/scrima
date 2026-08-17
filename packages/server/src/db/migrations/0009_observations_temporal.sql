-- 0009 Bi-temporal observations
--
-- Adds valid_from / valid_until / superseded_by so we can answer "what did
-- the coach believe about this player on date X" — required for the
-- 10-Week Improvement Thread feature in YOUR_COACH_REDESIGN.md.
--
-- Reads switch to filtering `valid_until IS NULL` (active belief), while
-- the existing `archived` boolean is retained for backwards compat.
--
-- Three-step migration so existing rows get a meaningful valid_from
-- (their original created_at) before NOT NULL is enforced.

ALTER TABLE player_observations
  ADD COLUMN IF NOT EXISTS "valid_from"    timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "valid_until"   timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "superseded_by" uuid REFERENCES player_observations(id) ON DELETE SET NULL;

UPDATE player_observations
SET valid_from = created_at
WHERE valid_from IS NULL;

-- Existing archived rows are also semantically retired — keep them readable
-- by historic queries but exclude from the active read path.
UPDATE player_observations
SET valid_until = COALESCE(last_seen_at, created_at)
WHERE archived = true AND valid_until IS NULL;

ALTER TABLE player_observations
  ALTER COLUMN "valid_from" SET DEFAULT now(),
  ALTER COLUMN "valid_from" SET NOT NULL;

-- Partial index — only the live set needs fast lookups; superseded rows
-- are archive-only material.
CREATE INDEX IF NOT EXISTS "idx_po_user_active_valid"
  ON player_observations (user_id)
  WHERE valid_until IS NULL AND archived = false;
