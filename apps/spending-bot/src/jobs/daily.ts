import { categorizePending } from "../ai/categorize";
import type { Llm } from "../ai/llm";
import { getDailyEnabled, groupTotal, memberTotals, pruneProcessedUpdates } from "../db";
import { dailyRecapMessage } from "../report/format";
import { nightlySheetSync, type SheetConfig } from "../sheets/sync";
import type { Telegram } from "../telegram";
import { currentMonthIct, monthRange, todayIct } from "../time";

const PROCESSED_UPDATES_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function runDailyJob(
  db: D1Database,
  tg: Telegram,
  chatId: number,
  now: Date,
  llm: Llm | null = null,
  sheet: SheetConfig | null = null,
): Promise<void> {
  await pruneProcessedUpdates(db, new Date(now.getTime() - PROCESSED_UPDATES_TTL_MS).toISOString());

  // Retry expenses whose category failed after /add (quota, timeout) and backfill old ones.
  if (llm) {
    try {
      await categorizePending(db, llm, chatId, now.toISOString());
    } catch (err) {
      console.error("daily categorize failed", err);
    }
  }

  try {
    await sendDailyRecap(db, tg, chatId, now);
  } catch (err) {
    console.error("daily recap failed", err);
  }

  // Last, so a slow Google API never delays the recap. Retries tabs that failed during the day,
  // writes categories set above, and tells the admin if the Sheet is still failing.
  if (sheet) await nightlySheetSync(db, tg, sheet, chatId);
}

async function sendDailyRecap(db: D1Database, tg: Telegram, chatId: number, now: Date): Promise<void> {
  if (!(await getDailyEnabled(db, chatId))) return;

  const today = todayIct(now);
  const members = await memberTotals(db, chatId, today, today);
  if (members.length === 0) return;

  const { from } = monthRange(currentMonthIct(now));
  const monthTotal = await groupTotal(db, chatId, from, today);
  await tg.sendMessage(chatId, dailyRecapMessage({ today, members, monthTotal }));
}
