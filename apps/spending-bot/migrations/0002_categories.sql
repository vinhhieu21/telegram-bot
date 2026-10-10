-- migrations/0002_categories.sql
-- Category keys are defined in src/ai/categories.ts. NULL = not classified yet;
-- the daily cron retries those, so a failed or rate-limited LLM call is never final.
ALTER TABLE expenses ADD COLUMN category TEXT;

CREATE INDEX idx_expenses_uncategorized ON expenses(chat_id, id)
  WHERE category IS NULL AND deleted_at IS NULL;

-- One LLM answer per normalised note ("cafe sáng" is classified once, not on every /add).
CREATE TABLE note_categories (
  note_key    TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  updated_at  TEXT NOT NULL                 -- ISO 8601 UTC
);
