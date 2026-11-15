// Keeps one Google Sheet tab per month ("2026-10") in step with the expenses.
//
// Triggers (migrations/0005) bump sheet_sync.version whenever a month's data changes. A sync
// pass rewrites each out-of-date tab and records the version it wrote. A month is leased while
// its tab is written, so two passes never write the same tab at once; the holder writes again
// if the month changed meanwhile. Passes run after every command and from the cron jobs.

import {
  claimSheetAlert,
  claimSheetMonth,
  clearSheetFailure,
  finishSheetMonth,
  outOfDateSheetMonths,
  recordSheetFailure,
  releaseSheetMonth,
  sheetMonthExpenses,
  sheetMonthState,
  unclaimSheetAlert,
} from "../db";
import { sheetFailingMessage, sheetLinkLine, sheetRecoveredMessage } from "../report/format";
import type { Telegram } from "../telegram";
import { monthKey, monthRange, todayIct, type YearMonth } from "../time";
import { GoogleSheets, spreadsheetUrl, type TabInfo } from "./google";
import { planMonthTab } from "./tab";

export interface SheetConfig {
  spreadsheetId: string;
  /** The service account's JSON key (secret GOOGLE_SERVICE_ACCOUNT_KEY). Checked on first use. */
  serviceAccountKey: string;
  /** Telegram user told when the Sheet stops updating and when it recovers. null = only logged. */
  adminUserId: number | null;
}

/** Longer than a whole pass can take (Google calls time out after 10 s), so a live holder never loses it. */
const LEASE_MS = 2 * 60 * 1000;
/** Bounds the Google calls per pass; older months wait for the next pass. */
const MONTHS_PER_PASS = 12;
/** Rewrites of one month per pass while it keeps changing under us. */
const ROUNDS_PER_MONTH = 5;

/** null when GOOGLE_SHEET_ID is empty (the feature is off). */
export function sheetConfig(env: {
  GOOGLE_SHEET_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_KEY?: string;
  ADMIN_USER_ID?: string;
}): SheetConfig | null {
  const spreadsheetId = env.GOOGLE_SHEET_ID?.trim();
  if (!spreadsheetId) return null;
  const admin = env.ADMIN_USER_ID?.trim() ?? "";
  return {
    spreadsheetId,
    serviceAccountKey: env.GOOGLE_SERVICE_ACCOUNT_KEY ?? "",
    adminUserId: /^\d+$/.test(admin) ? Number(admin) : null,
  };
}

/**
 * Brings every out-of-date month tab of the chat up to date. Never throws for Google errors:
 * it records them (for the nightly alert) and returns the message, or null when all went well.
 * Tells the admin when a failure they were told about is over.
 */
export async function syncSheet(
  db: D1Database,
  tg: Telegram,
  config: SheetConfig,
  chatId: number,
): Promise<{ error: string | null }> {
  const months = await outOfDateSheetMonths(db, chatId, MONTHS_PER_PASS);
  const sheets = new GoogleSheets(config.serviceAccountKey, config.spreadsheetId);
  let tabs: TabInfo[] | null = null;
  for (const month of months) {
    try {
      tabs = await syncMonth(db, sheets, chatId, month, tabs);
    } catch (err) {
      // Stop here: the next pass (next command or tonight's cron) retries this and the rest.
      const error = err instanceof Error ? err.message : String(err);
      console.error(`sheet sync of ${month} failed`, error);
      await recordSheetFailure(db, chatId, error, new Date().toISOString());
      return { error };
    }
  }

  const cleared = await clearSheetFailure(db, chatId);
  if (cleared?.alerted && config.adminUserId !== null) {
    await tg.sendMessage(config.adminUserId, sheetRecoveredMessage(spreadsheetUrl(config.spreadsheetId)));
  }
  return { error: null };
}

/**
 * The daily cron's pass. If the Sheet is still failing after it, tells the admin, once per
 * failure; a message that could not be delivered is retried the next night.
 */
export async function nightlySheetSync(db: D1Database, tg: Telegram, config: SheetConfig, chatId: number): Promise<void> {
  const { error } = await syncSheet(db, tg, config, chatId);
  if (error === null) return;

  const failure = await claimSheetAlert(db, chatId);
  if (!failure) return;
  if (config.adminUserId === null) {
    console.error("Google Sheet keeps failing to update and ADMIN_USER_ID is empty:", failure.last_error);
    return;
  }
  const text = sheetFailingMessage({
    since: todayIct(new Date(failure.failing_since)),
    error: failure.last_error,
    url: spreadsheetUrl(config.spreadsheetId),
  });
  if (!(await tg.sendMessage(config.adminUserId, text))) await unclaimSheetAlert(db, chatId);
}

/**
 * The monthly summary's last line: a link to the month's tab after a final sync, or a note
 * that the tab is behind. undefined when the month has no tab (it never had an expense).
 */
export async function monthSheetLine(
  db: D1Database,
  tg: Telegram,
  config: SheetConfig,
  chatId: number,
  month: YearMonth,
): Promise<string | undefined> {
  await syncSheet(db, tg, config, chatId);
  const state = await sheetMonthState(db, chatId, monthKey(month));
  if (!state) return undefined;
  const url = state.inSync && state.tabId !== null ? spreadsheetUrl(config.spreadsheetId, state.tabId) : null;
  return sheetLinkLine(month, url);
}

/**
 * Writes one month's tab, unless another pass holds the month. `tabs` is the spreadsheet's tab
 * list, read once per pass. Returns the list as it is after the writes.
 */
async function syncMonth(
  db: D1Database,
  sheets: GoogleSheets,
  chatId: number,
  month: string,
  tabs: TabInfo[] | null,
): Promise<TabInfo[] | null> {
  let lease = leaseUntil();
  let version = await claimSheetMonth(db, chatId, month, lease, new Date().toISOString());
  if (version === null) return tabs;

  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const { from, to } = monthRange({ year, month: monthNumber });
  try {
    for (let round = 0; round < ROUNDS_PER_MONTH; round++) {
      // Read after claiming `version`, so the data written is never older than the version recorded.
      const expenses = await sheetMonthExpenses(db, chatId, from, to);
      tabs ??= await sheets.tabs();
      const plan = planMonthTab(month, expenses, tabs);
      await sheets.batchUpdate(plan.requests);
      tabs = plan.tabs;

      const renewed = leaseUntil();
      const next = await finishSheetMonth(db, chatId, month, version, plan.sheetId, lease, renewed);
      if (next === null) return tabs;
      version = next;
      lease = renewed;
    }
  } catch (err) {
    await releaseSheetMonth(db, chatId, month, lease);
    throw err;
  }
  // Still changing after several rewrites: leave it to the next pass.
  await releaseSheetMonth(db, chatId, month, lease);
  return tabs;
}

function leaseUntil(): string {
  return new Date(Date.now() + LEASE_MS).toISOString();
}
