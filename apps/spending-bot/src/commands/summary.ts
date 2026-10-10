import { categoryTotals, groupTotal, memberTotals } from "../db";
import { USAGE, summaryMessage, type CategoryTotal, type MemberTotal } from "../report/format";
import { currentMonthIct, monthRange, previousMonth, type YearMonth } from "../time";
import { reply, type CommandContext } from "./context";

export async function summary(ctx: CommandContext): Promise<void> {
  const month = parseMonthArgs(ctx.args, currentMonthIct(ctx.now));
  if (month === null) {
    await reply(ctx, USAGE.summary);
    return;
  }
  await reply(ctx, await buildSummary(ctx.db, ctx.chatId, month));
}

export interface SummaryData {
  month: YearMonth;
  members: MemberTotal[];
  previousTotal: number;
  categories: CategoryTotal[];
  previousCategories: CategoryTotal[];
}

/** Shared with the monthly cron job. */
export async function loadSummary(db: D1Database, chatId: number, month: YearMonth): Promise<SummaryData> {
  const { from, to } = monthRange(month);
  const prev = monthRange(previousMonth(month));
  const [members, previousTotal, categories, previousCategories] = await Promise.all([
    memberTotals(db, chatId, from, to),
    groupTotal(db, chatId, prev.from, prev.to),
    categoryTotals(db, chatId, from, to),
    categoryTotals(db, chatId, prev.from, prev.to),
  ]);
  return { month, members, previousTotal, categories, previousCategories };
}

export async function buildSummary(db: D1Database, chatId: number, month: YearMonth): Promise<string> {
  return summaryMessage(await loadSummary(db, chatId, month));
}

/** "" -> current month, "9" -> September this year, "9 2025" -> September 2025. */
export function parseMonthArgs(args: string, current: YearMonth): YearMonth | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return current;
  if (tokens.length > 2 || !tokens.every((t) => /^\d+$/.test(t))) return null;

  const month = Number(tokens[0]);
  const year = tokens[1] === undefined ? current.year : Number(tokens[1]);
  if (month < 1 || month > 12 || year < 2000 || year > 9999) return null;
  return { year, month };
}
