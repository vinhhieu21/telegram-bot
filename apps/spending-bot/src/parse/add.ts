// Pure parser for the full `/add <amount> [note] [date]` argument string.

import { parseAmount } from "./amount";
import { extractDate } from "./date";

export type AddResult =
  | { ok: true; amount: number; note: string; spentOn: string }
  | { ok: false; reason: "missing" | "invalid" | "needs_unit" | "out_of_range" | "invalid_date" };

export function parseAdd(args: string, today: string): AddResult {
  const trimmed = args.trim();
  if (trimmed === "") return { ok: false, reason: "missing" };

  const [amountToken = "", ...rest] = trimmed.split(/\s+/);
  const amount = parseAmount(amountToken);
  if (!amount.ok) return amount;

  const date = extractDate(rest.join(" "), today);
  if (!date.ok) return date;

  return { ok: true, amount: amount.amount, note: date.note, spentOn: date.spentOn };
}
