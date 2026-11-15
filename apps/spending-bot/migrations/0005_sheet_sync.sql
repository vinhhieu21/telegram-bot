-- Google Sheets sync (src/sheets). One row per (chat, month) that has had expenses.
-- Triggers bump `version` on every change that alters a month's tab. A sync writes the tab and
-- records the version it wrote, so `version > synced_version` means the tab is out of date.
CREATE TABLE sheet_sync (
  chat_id         INTEGER NOT NULL,
  month           TEXT NOT NULL,                -- "YYYY-MM" (ICT), from spent_on
  version         INTEGER NOT NULL DEFAULT 1,
  synced_version  INTEGER NOT NULL DEFAULT 0,
  lease_until     TEXT,                         -- ISO 8601 UTC; a sync in progress owns the month until then
  tab_id          INTEGER,                      -- Google sheetId of the month's tab, once written
  PRIMARY KEY (chat_id, month)
);

CREATE TRIGGER sheet_sync_expense_insert AFTER INSERT ON expenses
BEGIN
  INSERT INTO sheet_sync (chat_id, month) VALUES (NEW.chat_id, substr(NEW.spent_on, 1, 7))
  ON CONFLICT (chat_id, month) DO UPDATE SET version = version + 1;
END;

-- An edit can move an expense to another month, so both the old and the new month change.
-- Category updates count too: the background categorisation fills them in after /add.
CREATE TRIGGER sheet_sync_expense_update AFTER UPDATE OF amount, note, spent_on, category, deleted_at ON expenses
BEGIN
  INSERT INTO sheet_sync (chat_id, month) VALUES (OLD.chat_id, substr(OLD.spent_on, 1, 7))
  ON CONFLICT (chat_id, month) DO UPDATE SET version = version + 1;
  INSERT INTO sheet_sync (chat_id, month) VALUES (NEW.chat_id, substr(NEW.spent_on, 1, 7))
  ON CONFLICT (chat_id, month) DO UPDATE SET version = version + 1;
END;

-- Member names are shown in every tab that lists the member. upsertMember runs on every command,
-- so only a real change of name counts.
CREATE TRIGGER sheet_sync_member_rename AFTER UPDATE OF first_name, last_name ON members
WHEN OLD.first_name IS NOT NEW.first_name OR OLD.last_name IS NOT NEW.last_name
BEGIN
  INSERT INTO sheet_sync (chat_id, month)
  SELECT DISTINCT chat_id, substr(spent_on, 1, 7) FROM expenses
  WHERE user_id = NEW.user_id AND deleted_at IS NULL
  ON CONFLICT (chat_id, month) DO UPDATE SET version = version + 1;
END;

-- Months that already have expenses get their tab on the first sync after this migration.
INSERT INTO sheet_sync (chat_id, month)
SELECT DISTINCT chat_id, substr(spent_on, 1, 7) FROM expenses WHERE deleted_at IS NULL;

-- Present while the Sheet fails to update: from the first failed sync until a sync pass leaves
-- no month out of date.
CREATE TABLE sheet_health (
  chat_id        INTEGER PRIMARY KEY,
  failing_since  TEXT NOT NULL,              -- ISO 8601 UTC
  last_error     TEXT NOT NULL,
  alerted        INTEGER NOT NULL DEFAULT 0  -- 1 once the admin was told; recovery is announced only then
);
