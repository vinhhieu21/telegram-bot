import { getDailyEnabled, groupTotal, memberTotals, pruneProcessedUpdates } from "../db";
import { dailyRecapMessage } from "../report/format";
import type { Telegram } from "../telegram";
import { currentMonthIct, monthRange, todayIct } from "../time";

const PROCESSED_UPDATES_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function runDailyJob(db: D1Database, tg: Telegram, chatId: number, now: Date): Promise<void> {
  await pruneProcessedUpdates(db, new Date(now.getTime() - PROCESSED_UPDATES_TTL_MS).toISOString());

  if (!(await getDailyEnabled(db, chatId))) return;

  const today = todayIct(now);
  const members = await memberTotals(db, chatId, today, today);
  if (members.length === 0) return;

  const { from } = monthRange(currentMonthIct(now));
  const monthTotal = await groupTotal(db, chatId, from, today);
  await tg.sendMessage(chatId, dailyRecapMessage({ today, members, monthTotal }));
}
