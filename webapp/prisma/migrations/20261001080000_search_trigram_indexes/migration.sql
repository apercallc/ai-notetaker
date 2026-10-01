-- Library search uses ILIKE '%q%' over titles, summaries, transcript and action-item text.
-- Trigram GIN indexes let Postgres answer those without scanning every row. pg_trgm is a
-- trusted extension on managed Postgres; if this role cannot create it the migration still
-- succeeds (search just stays unindexed) rather than blocking the deploy.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable (%), skipping search indexes', SQLERRM;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS "Meeting_title_trgm_idx" ON "Meeting" USING gin ("title" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "Meeting_summary_trgm_idx" ON "Meeting" USING gin ("summary" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "TranscriptSegment_text_trgm_idx" ON "TranscriptSegment" USING gin ("text" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "ActionItem_text_trgm_idx" ON "ActionItem" USING gin ("text" gin_trgm_ops);
  END IF;
END
$$;
