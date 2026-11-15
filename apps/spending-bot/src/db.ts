// All SQL lives here. Every expense query filters `deleted_at IS NULL`.

import type { CategoryTotal, ExpenseView, MemberName, MemberTotal } from "./report/format";
import type { SheetExpense } from "./sheets/tab";
import type { TgUser } from "./telegram";

export interface NewExpense {
  chatId: number;
  userId: number;
  amount: number;
  note: string;
  spentOn: string;
  messageId: number;
}

/** Records the update id. Returns false if it was already processed (Telegram retry). */
export async function markUpdateProcessed(db: D1Database, updateId: number, nowIso: string): Promise<boolean> {
  const res = await db
    .prepare("INSERT INTO processed_updates (update_id, received_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
    .bind(updateId, nowIso)
    .run();
  return res.meta.changes === 1;
}

export async function pruneProcessedUpdates(db: D1Database, beforeIso: string): Promise<void> {
  await db.prepare("DELETE FROM processed_updates WHERE received_at < ?").bind(beforeIso).run();
}

export async function upsertMember(db: D1Database, user: TgUser, nowIso: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members (user_id, first_name, last_name, username, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         first_name = excluded.first_name, last_name = excluded.last_name,
         username = excluded.username, updated_at = excluded.updated_at`,
    )
    .bind(user.id, user.first_name, user.last_name ?? null, user.username ?? null, nowIso)
    .run();
}

/**
 * Inserts an expense. Returns false if an expense for this message already exists
 * (an edit of the message was processed first and saved it).
 */
export async function insertExpense(db: D1Database, e: NewExpense, nowIso: string): Promise<boolean> {
  // RETURNING, not meta.changes: D1 counts the rows the sheet_sync trigger writes as changes too.
  const row = await db
    .prepare(
      `INSERT INTO expenses (chat_id, user_id, amount, note, spent_on, created_at, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, message_id) DO NOTHING
       RETURNING id`,
    )
    .bind(e.chatId, e.userId, e.amount, e.note, e.spentOn, nowIso, e.messageId)
    .first<{ id: number }>();
  return row !== null;
}

export type EditedExpenseResult = "inserted" | "updated" | "undone" | "stale";

/**
 * Saves the /add in an edited message, in one atomic statement.
 * "inserted": no expense existed for the message (the original /add was rejected).
 * "updated": the live expense of the message got the new amount, note and date; its category
 * is reset when the note changed, so it is classified again.
 * "undone": the expense was removed with /undo; nothing changes and nothing is inserted.
 * "stale": a newer edit of the message was already applied (Telegram can deliver edits out of order).
 * Edits with the same edit_date apply in arrival order.
 */
export async function saveEditedExpense(
  db: D1Database,
  e: NewExpense,
  editDate: number,
  nowIso: string,
): Promise<EditedExpenseResult> {
  const row = await db
    .prepare(
      `INSERT INTO expenses (chat_id, user_id, amount, note, spent_on, created_at, message_id, edit_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, message_id) DO UPDATE SET
         amount = excluded.amount,
         note = excluded.note,
         spent_on = excluded.spent_on,
         category = CASE WHEN note = excluded.note THEN category ELSE NULL END,
         updated_at = ?,
         edit_date = excluded.edit_date
       WHERE deleted_at IS NULL AND (edit_date IS NULL OR edit_date <= excluded.edit_date)
       RETURNING updated_at`,
    )
    .bind(e.chatId, e.userId, e.amount, e.note, e.spentOn, nowIso, e.messageId, editDate, nowIso)
    .first<{ updated_at: string | null }>();
  if (row) return row.updated_at === null ? "inserted" : "updated";
  return (await messageExpenseState(db, e.chatId, e.messageId)) === "undone" ? "undone" : "stale";
}

/** Whether the expense recorded from a message is live, undone, or missing (null). */
export async function messageExpenseState(
  db: D1Database,
  chatId: number,
  messageId: number,
): Promise<"live" | "undone" | null> {
  const row = await db
    .prepare("SELECT deleted_at FROM expenses WHERE chat_id = ? AND message_id = ?")
    .bind(chatId, messageId)
    .first<{ deleted_at: string | null }>();
  if (!row) return null;
  return row.deleted_at === null ? "live" : "undone";
}

/** Soft-deletes the user's most recent live expense in one statement. Returns it, or null if none. */
export async function undoLastExpense(
  db: D1Database,
  chatId: number,
  userId: number,
  nowIso: string,
): Promise<ExpenseView | null> {
  return db
    .prepare(
      `UPDATE expenses SET deleted_at = ?
       WHERE id = (
         SELECT id FROM expenses
         WHERE chat_id = ? AND user_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 1
       )
       RETURNING amount, note, spent_on`,
    )
    .bind(nowIso, chatId, userId)
    .first<ExpenseView>();
}

/**
 * Soft-deletes the live expense created by `messageId`, only if it belongs to `userId`.
 * Returns it, or null if that message is not one of the user's live expenses.
 */
export async function undoExpenseByMessage(
  db: D1Database,
  chatId: number,
  userId: number,
  messageId: number,
  nowIso: string,
): Promise<ExpenseView | null> {
  return db
    .prepare(
      `UPDATE expenses SET deleted_at = ?
       WHERE chat_id = ? AND user_id = ? AND message_id = ? AND deleted_at IS NULL
       RETURNING amount, note, spent_on`,
    )
    .bind(nowIso, chatId, userId, messageId)
    .first<ExpenseView>();
}

export async function userTotal(db: D1Database, chatId: number, userId: number, from: string, to: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
       WHERE chat_id = ? AND user_id = ? AND spent_on BETWEEN ? AND ? AND deleted_at IS NULL`,
    )
    .bind(chatId, userId, from, to)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function groupTotal(db: D1Database, chatId: number, from: string, to: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
       WHERE chat_id = ? AND spent_on BETWEEN ? AND ? AND deleted_at IS NULL`,
    )
    .bind(chatId, from, to)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Per-member totals for a date range, highest total first. Members with no expenses are omitted. */
export async function memberTotals(db: D1Database, chatId: number, from: string, to: string): Promise<MemberTotal[]> {
  const { results } = await db
    .prepare(
      `SELECT e.user_id, m.first_name, m.last_name,
              SUM(e.amount) AS total, COUNT(*) AS count, MAX(e.amount) AS max_amount
       FROM expenses e JOIN members m ON m.user_id = e.user_id
       WHERE e.chat_id = ? AND e.spent_on BETWEEN ? AND ? AND e.deleted_at IS NULL
       GROUP BY e.user_id
       ORDER BY total DESC, m.first_name`,
    )
    .bind(chatId, from, to)
    .all<MemberTotal>();
  return results;
}

/** One user's total, count and largest expense for a date range (all 0 when none). */
export async function userStats(
  db: D1Database,
  chatId: number,
  userId: number,
  from: string,
  to: string,
): Promise<{ total: number; count: number; max_amount: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count, COALESCE(MAX(amount), 0) AS max_amount
       FROM expenses
       WHERE chat_id = ? AND user_id = ? AND spent_on BETWEEN ? AND ? AND deleted_at IS NULL`,
    )
    .bind(chatId, userId, from, to)
    .first<{ total: number; count: number; max_amount: number }>();
  return row ?? { total: 0, count: 0, max_amount: 0 };
}

/**
 * Per-category totals for a date range, highest first. `category` is null for uncategorised expenses.
 * With `userId`, only that user's expenses count.
 */
export async function categoryTotals(
  db: D1Database,
  chatId: number,
  from: string,
  to: string,
  userId?: number,
): Promise<CategoryTotal[]> {
  const userFilter = userId === undefined ? "" : " AND user_id = ?";
  const { results } = await db
    .prepare(
      `SELECT category, SUM(amount) AS total FROM expenses
       WHERE chat_id = ? AND spent_on BETWEEN ? AND ? AND deleted_at IS NULL${userFilter}
       GROUP BY category
       ORDER BY total DESC, category`,
    )
    .bind(chatId, from, to, ...(userId === undefined ? [] : [userId]))
    .all<CategoryTotal>();
  return results;
}

/** Oldest live expenses without a category. */
export async function pendingCategorization(
  db: D1Database,
  chatId: number,
  limit: number,
): Promise<{ id: number; note: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, note FROM expenses
       WHERE chat_id = ? AND category IS NULL AND deleted_at IS NULL
       ORDER BY id LIMIT ?`,
    )
    .bind(chatId, limit)
    .all<{ id: number; note: string }>();
  return results;
}

/** Cached categories for normalised notes. At most ~99 keys per call (D1 parameter limit). */
export async function cachedCategories(db: D1Database, noteKeys: string[]): Promise<Map<string, string>> {
  if (noteKeys.length === 0) return new Map();
  const { results } = await db
    .prepare(`SELECT note_key, category FROM note_categories WHERE note_key IN (${noteKeys.map(() => "?").join(", ")})`)
    .bind(...noteKeys)
    .all<{ note_key: string; category: string }>();
  return new Map(results.map((r) => [r.note_key, r.category]));
}

/**
 * Caches new note categories and sets expense categories, in one round trip.
 * The note guard skips rows whose note was edited while the model was answering.
 */
export async function saveCategories(
  db: D1Database,
  learned: Map<string, string>,
  updates: { id: number; note: string; category: string }[],
  nowIso: string,
): Promise<void> {
  const statements = [
    ...[...learned].map(([key, category]) =>
      db
        .prepare(
          `INSERT INTO note_categories (note_key, category, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (note_key) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at`,
        )
        .bind(key, category, nowIso),
    ),
    ...updates.map((u) =>
      db
        .prepare("UPDATE expenses SET category = ? WHERE id = ? AND category IS NULL AND note = ?")
        .bind(u.category, u.id, u.note),
    ),
  ];
  if (statements.length > 0) await db.batch(statements);
}

export async function getDailyEnabled(db: D1Database, chatId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT daily_enabled FROM settings WHERE chat_id = ?")
    .bind(chatId)
    .first<{ daily_enabled: number }>();
  return row?.daily_enabled === 1;
}

export async function setDailyEnabled(db: D1Database, chatId: number, enabled: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (chat_id, daily_enabled) VALUES (?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET daily_enabled = excluded.daily_enabled`,
    )
    .bind(chatId, enabled ? 1 : 0)
    .run();
}

/** The chat's monthly budget in VND, or null if none is set. */
export async function getBudget(db: D1Database, chatId: number): Promise<number | null> {
  const row = await db
    .prepare("SELECT amount FROM budgets WHERE chat_id = ?")
    .bind(chatId)
    .first<{ amount: number }>();
  return row?.amount ?? null;
}

/** Sets (or replaces) the budget and its warning state for `warnedMonth`. */
export async function setBudget(
  db: D1Database,
  chatId: number,
  amount: number,
  warnedMonth: string,
  warnedLevel: number,
  nowIso: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO budgets (chat_id, amount, warned_month, warned_level, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET amount = excluded.amount, warned_month = excluded.warned_month,
         warned_level = excluded.warned_level, updated_at = excluded.updated_at`,
    )
    .bind(chatId, amount, warnedMonth, warnedLevel, nowIso)
    .run();
}

/** Removes the budget. Returns false if there was none. */
export async function deleteBudget(db: D1Database, chatId: number): Promise<boolean> {
  const res = await db.prepare("DELETE FROM budgets WHERE chat_id = ?").bind(chatId).run();
  return res.meta.changes === 1;
}

/**
 * Records that `level` was warned in `month`, unless it (or a higher level) already was, or the
 * budget is no longer `amount`. Returns true only for the one caller that should send the warning.
 */
export async function claimBudgetWarning(
  db: D1Database,
  chatId: number,
  amount: number,
  month: string,
  level: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE budgets SET warned_month = ?, warned_level = ?
       WHERE chat_id = ? AND amount = ? AND (warned_month <> ? OR warned_level < ?)`,
    )
    .bind(month, level, chatId, amount, month, level)
    .run();
  return res.meta.changes === 1;
}

// Google Sheets sync (src/sheets/sync.ts). Triggers from migration 0005 bump sheet_sync.version
// whenever a month's expenses (or a name shown in them) change.

/** Months whose tab is behind their data, newest first. */
export async function outOfDateSheetMonths(db: D1Database, chatId: number, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT month FROM sheet_sync WHERE chat_id = ? AND version > synced_version ORDER BY month DESC LIMIT ?")
    .bind(chatId, limit)
    .all<{ month: string }>();
  return results.map((r) => r.month);
}

/**
 * Leases the month until `leaseUntil` to write its tab, unless it is in sync or another sync holds
 * an unexpired lease. Returns the version to write, or null when the month is not ours to write.
 */
export async function claimSheetMonth(
  db: D1Database,
  chatId: number,
  month: string,
  leaseUntil: string,
  nowIso: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `UPDATE sheet_sync SET lease_until = ?1
       WHERE chat_id = ?2 AND month = ?3 AND version > synced_version
         AND (lease_until IS NULL OR lease_until <= ?4)
       RETURNING version`,
    )
    .bind(leaseUntil, chatId, month, nowIso)
    .first<{ version: number }>();
  return row?.version ?? null;
}

/**
 * Records that `version` of the month is in tab `tabId`, if we still hold `lease`. Releases the
 * lease when nothing changed meanwhile; otherwise renews it to `renewedLease` and returns the
 * version to write next. Returns null when done (or when the lease was lost).
 */
export async function finishSheetMonth(
  db: D1Database,
  chatId: number,
  month: string,
  version: number,
  tabId: number,
  lease: string,
  renewedLease: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `UPDATE sheet_sync
       SET synced_version = ?1, tab_id = ?2, lease_until = CASE WHEN version = ?1 THEN NULL ELSE ?3 END
       WHERE chat_id = ?4 AND month = ?5 AND lease_until = ?6
       RETURNING version`,
    )
    .bind(version, tabId, renewedLease, chatId, month, lease)
    .first<{ version: number }>();
  return row && row.version !== version ? row.version : null;
}

/** Gives up the month's lease, if still ours, so the next sync can retry right away. */
export async function releaseSheetMonth(db: D1Database, chatId: number, month: string, lease: string): Promise<void> {
  await db
    .prepare("UPDATE sheet_sync SET lease_until = NULL WHERE chat_id = ? AND month = ? AND lease_until = ?")
    .bind(chatId, month, lease)
    .run();
}

/** The month's live expenses with their member's name, in the order they were recorded. */
export async function sheetMonthExpenses(db: D1Database, chatId: number, from: string, to: string): Promise<SheetExpense[]> {
  const { results } = await db
    .prepare(
      `SELECT e.user_id, m.first_name, m.last_name, e.amount, e.note, e.spent_on, e.category
       FROM expenses e JOIN members m ON m.user_id = e.user_id
       WHERE e.chat_id = ? AND e.spent_on BETWEEN ? AND ? AND e.deleted_at IS NULL
       ORDER BY e.id`,
    )
    .bind(chatId, from, to)
    .all<SheetExpense>();
  return results;
}

/** Whether the month's tab is up to date, and its sheetId once written. null if the month has no tab. */
export async function sheetMonthState(
  db: D1Database,
  chatId: number,
  month: string,
): Promise<{ inSync: boolean; tabId: number | null } | null> {
  const row = await db
    .prepare("SELECT version = synced_version AS in_sync, tab_id FROM sheet_sync WHERE chat_id = ? AND month = ?")
    .bind(chatId, month)
    .first<{ in_sync: number; tab_id: number | null }>();
  return row && { inSync: row.in_sync === 1, tabId: row.tab_id };
}

/** Notes a failed sync. The first failure since the Sheet was last in sync sets failing_since. */
export async function recordSheetFailure(db: D1Database, chatId: number, error: string, nowIso: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sheet_health (chat_id, failing_since, last_error) VALUES (?, ?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET last_error = excluded.last_error`,
    )
    .bind(chatId, nowIso, error)
    .run();
}

/**
 * Forgets a past failure once every month is in sync. Returns the cleared failure, or null if
 * there was none (or some month is still behind).
 */
export async function clearSheetFailure(db: D1Database, chatId: number): Promise<{ alerted: boolean } | null> {
  const row = await db
    .prepare(
      `DELETE FROM sheet_health
       WHERE chat_id = ?1 AND NOT EXISTS (SELECT 1 FROM sheet_sync WHERE chat_id = ?1 AND version > synced_version)
       RETURNING alerted`,
    )
    .bind(chatId)
    .first<{ alerted: number }>();
  return row && { alerted: row.alerted === 1 };
}

/** Marks the current failure as told to the admin. Returns it only to the one caller that should tell. */
export async function claimSheetAlert(
  db: D1Database,
  chatId: number,
): Promise<{ failing_since: string; last_error: string } | null> {
  return db
    .prepare("UPDATE sheet_health SET alerted = 1 WHERE chat_id = ? AND alerted = 0 RETURNING failing_since, last_error")
    .bind(chatId)
    .first<{ failing_since: string; last_error: string }>();
}

/** Undoes claimSheetAlert when the message could not be delivered, so the next night tries again. */
export async function unclaimSheetAlert(db: D1Database, chatId: number): Promise<void> {
  await db.prepare("UPDATE sheet_health SET alerted = 0 WHERE chat_id = ?").bind(chatId).run();
}

// --- Mini App (src/web/server.ts) ---

/** The range's live expenses, newest day first, then newest recorded first. */
export async function rangeExpenses(
  db: D1Database,
  chatId: number,
  from: string,
  to: string,
): Promise<{ id: number; user_id: number; amount: number; note: string; spent_on: string; category: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, amount, note, spent_on, category FROM expenses
       WHERE chat_id = ? AND spent_on BETWEEN ? AND ? AND deleted_at IS NULL
       ORDER BY spent_on DESC, id DESC`,
    )
    .bind(chatId, from, to)
    .all<{ id: number; user_id: number; amount: number; note: string; spent_on: string; category: string | null }>();
  return results;
}

/** The range's live expenses totalled per member and category. */
export async function memberCategoryTotals(
  db: D1Database,
  chatId: number,
  from: string,
  to: string,
): Promise<{ user_id: number; category: string | null; total: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT user_id, category, SUM(amount) AS total FROM expenses
       WHERE chat_id = ? AND spent_on BETWEEN ? AND ? AND deleted_at IS NULL
       GROUP BY user_id, category`,
    )
    .bind(chatId, from, to)
    .all<{ user_id: number; category: string | null; total: number }>();
  return results;
}

/** Members with a live expense in the range, plus `alsoUserId` when known. */
export async function rangeMembers(
  db: D1Database,
  chatId: number,
  from: string,
  to: string,
  alsoUserId: number,
): Promise<MemberName[]> {
  const { results } = await db
    .prepare(
      `SELECT user_id, first_name, last_name FROM members
       WHERE user_id = ?4
          OR user_id IN (SELECT user_id FROM expenses
                         WHERE chat_id = ?1 AND spent_on BETWEEN ?2 AND ?3 AND deleted_at IS NULL)`,
    )
    .bind(chatId, from, to, alsoUserId)
    .all<MemberName>();
  return results;
}

/** The date of the chat's oldest live expense, or null when there is none. */
export async function firstExpenseDate(db: D1Database, chatId: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT MIN(spent_on) AS first FROM expenses WHERE chat_id = ? AND deleted_at IS NULL")
    .bind(chatId)
    .first<{ first: string | null }>();
  return row?.first ?? null;
}
