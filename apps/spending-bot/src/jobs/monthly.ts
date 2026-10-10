import { categoryLabel } from "../ai/categories";
import { categorizePending } from "../ai/categorize";
import { writeCommentary, type MonthFacts } from "../ai/commentary";
import type { Llm } from "../ai/llm";
import { loadSummary, type SummaryData } from "../commands/summary";
import { plainDisplayNames, summaryMessage } from "../report/format";
import type { Telegram } from "../telegram";
import { currentMonthIct, previousMonth } from "../time";

/** Catch-up passes before the summary, so late /add entries are categorised too. */
const CATEGORIZE_PASSES = 3;

/**
 * Runs on the 1st (ICT): summarises the month that just ended. Always sends.
 * With an LLM, first categorises what is left and adds commentary; if that fails the
 * summary still goes out, with a line saying the commentary is unavailable.
 */
export async function runMonthlyJob(
  db: D1Database,
  tg: Telegram,
  chatId: number,
  now: Date,
  llm: Llm | null,
): Promise<void> {
  const month = previousMonth(currentMonthIct(now));

  if (llm) {
    try {
      for (let i = 0; i < CATEGORIZE_PASSES; i++) {
        if ((await categorizePending(db, llm, chatId, now.toISOString())) === 0) break;
      }
    } catch (err) {
      console.error("monthly categorize failed", err);
    }
  }

  const data = await loadSummary(db, chatId, month);
  const commentary = llm && data.members.length > 0 ? await writeCommentary(llm, monthFacts(data)) : undefined;
  await tg.sendMessage(chatId, summaryMessage({ ...data, commentary }));
}

export function monthFacts(data: SummaryData): MonthFacts {
  const names = plainDisplayNames(data.members);
  const previousByKey = new Map(data.previousCategories.map((c) => [c.category, c.total]));
  return {
    month: data.month,
    previousMonth: previousMonth(data.month),
    total: data.members.reduce((sum, m) => sum + m.total, 0),
    previousTotal: data.previousTotal,
    members: data.members.map((m) => ({ name: names.get(m.user_id) ?? m.first_name, total: m.total, count: m.count })),
    categories: data.categories.map((c) => ({
      label: categoryLabel(c.category),
      total: c.total,
      previousTotal: previousByKey.get(c.category) ?? 0,
    })),
  };
}
