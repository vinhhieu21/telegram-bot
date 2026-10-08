// Pure date-token extraction from an /add note. Default is today (ICT).

import { addDays, validYmd } from "../time";

export type DateResult = { ok: true; spentOn: string; note: string } | { ok: false; reason: "invalid_date" };

// Whitespace-delimited, since \b does not treat Vietnamese letters as word characters.
const YESTERDAY = /(?<=^|\s)(?:hôm qua|hom qua|hqua)(?=\s|$)/i;
const DAY_MONTH = /(?<=^|\s)(\d{1,2})\/(\d{1,2})(?=\s|$)/;

/**
 * Finds an optional date token in `note`, removes it, and returns the expense date.
 * `today` is the current ICT date as YYYY-MM-DD. Never returns a future date.
 */
export function extractDate(note: string, today: string): DateResult {
  const text = note.normalize("NFC");

  const yesterday = YESTERDAY.exec(text);
  if (yesterday) {
    return { ok: true, spentOn: addDays(today, -1), note: removeMatch(text, yesterday) };
  }

  const dm = DAY_MONTH.exec(text);
  if (dm) {
    const day = Number(dm[1]);
    const month = Number(dm[2]);
    const year = Number(today.slice(0, 4));
    let spentOn = validYmd(year, month, day);
    if (spentOn !== null && spentOn > today) spentOn = validYmd(year - 1, month, day);
    if (spentOn === null) return { ok: false, reason: "invalid_date" };
    return { ok: true, spentOn, note: removeMatch(text, dm) };
  }

  return { ok: true, spentOn: today, note: collapse(text) };
}

function removeMatch(text: string, match: RegExpExecArray): string {
  return collapse(text.slice(0, match.index) + text.slice(match.index + match[0].length));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
