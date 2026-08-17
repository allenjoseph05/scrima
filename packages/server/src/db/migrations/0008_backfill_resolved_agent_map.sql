-- 0008 Backfill resolved_agent / resolved_map / vlm_detected_*
--
-- These columns were added to the schema in earlier migrations but never
-- populated by the analysis services — agent/map only landed in the report
-- JSONB blob (`detectedAgent`, `detectedMap`). Brain context, compass,
-- and weekly report all read the dedicated columns and were silently
-- getting NULL. Backfill them from JSONB so existing readers stop missing.
--
-- Idempotent — only fills NULL columns.

-- NULLIF guards against the edge case where the JSONB stored a literal
-- string "null" (rare but possible — Gemini/parsers occasionally emit it)
-- which would otherwise be backfilled as the literal text 'null'.

UPDATE coaching_reports
SET resolved_agent = COALESCE(NULLIF(report->>'detectedAgent', 'null'), NULLIF(report->>'agent', 'null'))
WHERE resolved_agent IS NULL
  AND (report->>'detectedAgent' IS NOT NULL OR report->>'agent' IS NOT NULL);

UPDATE coaching_reports
SET resolved_map = COALESCE(NULLIF(report->>'detectedMap', 'null'), NULLIF(report->>'map', 'null'))
WHERE resolved_map IS NULL
  AND (report->>'detectedMap' IS NOT NULL OR report->>'map' IS NOT NULL);

UPDATE coaching_reports
SET vlm_detected_agent = NULLIF(report->>'detectedAgent', 'null')
WHERE vlm_detected_agent IS NULL
  AND report->>'detectedAgent' IS NOT NULL;

UPDATE coaching_reports
SET vlm_detected_map = NULLIF(report->>'detectedMap', 'null')
WHERE vlm_detected_map IS NULL
  AND report->>'detectedMap' IS NOT NULL;
