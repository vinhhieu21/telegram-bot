import { buildSummary } from "../commands/summary";
import type { Telegram } from "../telegram";
import { currentMonthIct, previousMonth } from "../time";

/** Runs on the 1st (ICT): summarises the month that just ended. Always sends. */
export async function runMonthlyJob(db: D1Database, tg: Telegram, chatId: number, now: Date): Promise<void> {
  const month = previousMonth(currentMonthIct(now));
  await tg.sendMessage(chatId, await buildSummary(db, chatId, month));
}
