// The Mini App: GET /app/* serves the page (static assets), GET /api/month serves its data.
// Read-only. Only members of the group, as Telegram says right now, can read anything.

import { firstExpenseDate, getBudget, memberCategoryTotals, rangeExpenses, rangeMembers } from "../db";
import { plainDisplayNames } from "../report/format";
import type { Telegram } from "../telegram";
import { currentMonthIct, monthKey, monthRange, previousMonth, todayIct, type YearMonth } from "../time";
import type { ApiError, ApiErrorCode, MonthResponse } from "./api";
import { verifyInitData } from "./auth";

export interface WebDeps {
  db: D1Database;
  tg: Telegram;
  assets: Fetcher;
  botToken: string;
  /** null until ALLOWED_CHAT_ID is set: then nobody is a member. */
  allowedChatId: number | null;
  now: Date;
}

/** Path the page is served under; the Mini App URL is this on the Worker's origin. */
export const APP_PATH = "/app/";

export async function handleWebRequest(request: Request, deps: WebDeps): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not found", { status: 404 });
  if (url.pathname === "/api/month") return monthApi(request, url, deps);
  if (url.pathname === "/app" || url.pathname.startsWith(APP_PATH)) return deps.assets.fetch(request);
  return new Response("Not found", { status: 404 });
}

async function monthApi(request: Request, url: URL, deps: WebDeps): Promise<Response> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("tma ")) return apiError("unauthorized");
  const auth = await verifyInitData(header.slice(4), deps.botToken, deps.now);
  if (!auth.ok) return apiError(auth.reason === "expired" ? "expired" : "unauthorized");

  if (deps.allowedChatId === null) return apiError("not_member");
  const member = await deps.tg.isChatMember(deps.allowedChatId, auth.user.id);
  if (member === null) return apiError("unavailable");
  if (!member) return apiError("not_member");

  const current = currentMonthIct(deps.now);
  const month = parseMonthParam(url.searchParams.get("month"), current);
  if (!month) return apiError("bad_month");

  const chatId = deps.allowedChatId;
  const { from, to } = monthRange(month);
  const today = todayIct(deps.now);
  const prev = monthRange(previousMonth(month));
  // Mid-month, half a month against a whole one would always look like a drop: compare the same days.
  const sameDay = `${prev.from.slice(0, 8)}${today.slice(8)}`;
  const prevTo = monthKey(month) === monthKey(current) && sameDay < prev.to ? sameDay : prev.to;
  const [expenses, previous, members, budget, first] = await Promise.all([
    rangeExpenses(deps.db, chatId, from, to),
    memberCategoryTotals(deps.db, chatId, prev.from, prevTo),
    rangeMembers(deps.db, chatId, prev.from, to, auth.user.id),
    getBudget(deps.db, chatId),
    firstExpenseDate(deps.db, chatId),
  ]);

  // A viewer who never used a command is not in `members` yet; Telegram's first name stands in.
  const known = members.some((m) => m.user_id === auth.user.id);
  const named = plainDisplayNames(known ? members : [...members, { user_id: auth.user.id, first_name: auth.user.first_name, last_name: null }]);

  const body: MonthResponse = {
    month: monthKey(month),
    firstMonth: first ? first.slice(0, 7) : monthKey(current),
    currentMonth: monthKey(current),
    today,
    viewerId: auth.user.id,
    members: [...named].map(([id, name]) => ({ id, name })),
    budget,
    expenses: expenses.map((e) => ({ id: e.id, userId: e.user_id, amount: e.amount, note: e.note, date: e.spent_on, category: e.category })),
    previous: previous.map((p) => ({ userId: p.user_id, category: p.category, total: p.total })),
    previousThrough: prevTo,
  };
  return json(body, 200);
}

/** null (absent) -> current month; "YYYY-MM" up to the current month; anything else -> null. */
export function parseMonthParam(value: string | null, current: YearMonth): YearMonth | null {
  if (value === null) return current;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) return null;
  const month = { year: Number(match[1]), month: Number(match[2]) };
  return monthKey(month) <= monthKey(current) ? month : null;
}

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  expired: 401,
  not_member: 403,
  bad_month: 400,
  unavailable: 503,
};

function apiError(error: ApiErrorCode): Response {
  const body: ApiError = { error };
  return json(body, ERROR_STATUS[error]);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    // Members' spending: never cached anywhere, and never readable cross-origin.
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
