// The Mini App's API contract, shared by the Worker (src/web/server.ts) and the page (web/main.ts).
// Type-only: the page imports it with `import type`, so nothing here ends up in its bundle.

export interface MonthResponse {
  /** "YYYY-MM", the month shown. */
  month: string;
  /** Earliest month with expenses ("YYYY-MM"), or the current month when there are none. */
  firstMonth: string;
  /** Current ICT month and day, so the page never trusts the phone's clock. */
  currentMonth: string;
  today: string;
  /** The Telegram user who opened the app. */
  viewerId: number;
  /** Everyone with an expense in this month or the previous one, plus the viewer. */
  members: ApiMember[];
  /** The group's monthly budget in VND, or null when none is set. */
  budget: number | null;
  /** The month's live expenses, newest day first. */
  expenses: ApiExpense[];
  /** The previous month, totalled per member and category, for the "vs last month" figures. */
  previous: ApiTotal[];
  /**
   * Last day (YYYY-MM-DD) that `previous` covers: the previous month's last day, or for the current
   * month the same day of the previous month, so a half month is not compared with a whole one.
   */
  previousThrough: string;
}

export interface ApiMember {
  id: number;
  /** First name, plus last name when two members share a first name. */
  name: string;
}

export interface ApiExpense {
  id: number;
  userId: number;
  amount: number;
  note: string;
  /** "YYYY-MM-DD" (ICT). */
  date: string;
  /** A key of CATEGORIES, or null while uncategorised. */
  category: string | null;
}

export interface ApiTotal {
  userId: number;
  category: string | null;
  total: number;
}

export interface ApiError {
  error: ApiErrorCode;
}

/**
 * unauthorized: no or bad Telegram init data (opened outside Telegram, or tampered with).
 * expired: init data older than the allowed age; reopening the app fixes it.
 * not_member: a valid Telegram user who is not in the group.
 * bad_month: the month parameter is malformed or in the future.
 * unavailable: Telegram could not confirm membership; try again.
 */
export type ApiErrorCode = "unauthorized" | "expired" | "not_member" | "bad_month" | "unavailable";
