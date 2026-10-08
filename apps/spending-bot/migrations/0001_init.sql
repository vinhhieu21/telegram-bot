-- migrations/0001_init.sql
CREATE TABLE members (
  user_id      INTEGER PRIMARY KEY,         -- Telegram user id
  first_name   TEXT NOT NULL,
  last_name    TEXT,
  username     TEXT,
  updated_at   TEXT NOT NULL                -- ISO 8601 UTC; refreshed on every command
);

CREATE TABLE expenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES members(user_id),
  amount        INTEGER NOT NULL CHECK (amount > 0),   -- whole VND
  note          TEXT NOT NULL DEFAULT '',
  spent_on      TEXT NOT NULL,              -- YYYY-MM-DD in Asia/Ho_Chi_Minh
  created_at    TEXT NOT NULL,              -- ISO 8601 UTC
  source        TEXT NOT NULL DEFAULT 'manual',  -- 'manual' now; e.g. 'sepay' later
  external_ref  TEXT,                       -- bank transaction id, for de-duplication later
  message_id    INTEGER,                    -- Telegram message that created it
  deleted_at    TEXT                        -- soft delete (/undo)
);

CREATE INDEX idx_expenses_chat_day ON expenses(chat_id, spent_on);
CREATE INDEX idx_expenses_user ON expenses(user_id, created_at);
CREATE UNIQUE INDEX ux_expenses_external ON expenses(source, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE TABLE settings (
  chat_id        INTEGER PRIMARY KEY,
  daily_enabled  INTEGER NOT NULL DEFAULT 0   -- 0 = off, 1 = on
);

CREATE TABLE processed_updates (
  update_id    INTEGER PRIMARY KEY,         -- Telegram update_id, for idempotency
  received_at  TEXT NOT NULL
);
