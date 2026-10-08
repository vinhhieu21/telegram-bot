// All SQL lives here. Every expense query filters `deleted_at IS NULL`.

import type { ExpenseView, MemberTotal } from "./report/format";
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

export async function insertExpense(db: D1Database, e: NewExpense, nowIso: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO expenses (chat_id, user_id, amount, note, spent_on, created_at, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(e.chatId, e.userId, e.amount, e.note, e.spentOn, nowIso, e.messageId)
    .run();
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
