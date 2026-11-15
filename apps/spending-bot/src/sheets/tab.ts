// One month's tab ("2026-10") as Google Sheets batchUpdate requests. Pure: no I/O.
//
// Layout: the expense table at A1 (frozen header, basic filter), sorted by member then date,
// and the per-member summary from column G. The summary never sits above the table, so the
// table's range stays fixed for filters, pivot tables and charts built on it.

import { categoryLabel } from "../ai/categories";
import { plainDisplayNames, type MemberName } from "../report/format";
import type { SheetRequest, TabInfo } from "./google";

export interface SheetExpense extends MemberName {
  amount: number;
  note: string;
  spent_on: string;
  category: string | null;
}

/** Titles of the tabs the bot owns. It never touches any other tab. */
export const MONTH_TAB_TITLE = /^\d{4}-\d{2}$/;

export const TABLE_HEADERS = ["Ngày", "Thành viên", "Số tiền", "Loại", "Ghi chú"] as const;
export const SUMMARY_HEADERS = ["Thành viên", "Tổng", "Số khoản"] as const;
export const GROUP_LABEL = "Cả nhóm";
/** Column widths in pixels, A to I. Column F is the gap between the table and the summary. */
const COLUMN_WIDTHS = [96, 150, 110, 130, 260, 24, 150, 110, 80];
const PROTECTION_NOTE = "Bot tự cập nhật tab này. Sửa ở đây sẽ bị ghi đè ở lần cập nhật sau.";

type Cell = Record<string, unknown>;

const HEADER_BACKGROUND = { rgbColor: { red: 241 / 255, green: 243 / 255, blue: 244 / 255 } };
const RULE = { style: "SOLID", colorStyle: { rgbColor: { red: 189 / 255, green: 193 / 255, blue: 198 / 255 } } };
const HEADER = { textFormat: { bold: true }, backgroundColorStyle: HEADER_BACKGROUND };
const NUMBER_HEADER = { ...HEADER, horizontalAlignment: "RIGHT" };
const DATE = { numberFormat: { type: "DATE", pattern: "dd/mm/yyyy" }, horizontalAlignment: "LEFT" };
const AMOUNT = { numberFormat: { type: "NUMBER", pattern: "#,##0" } };
const NOTE = { wrapStrategy: "CLIP" };
const GROUP_ROW = { textFormat: { bold: true }, borders: { top: RULE } };
const BLANK: Cell = {};

export interface MonthTabPlan {
  /** The tab's Google sheetId. */
  sheetId: number;
  requests: SheetRequest[];
  /** The spreadsheet's tabs once `requests` are applied. */
  tabs: TabInfo[];
}

/**
 * Requests that rewrite the tab titled `month` from scratch, creating it if needed.
 * A new tab goes left of the older month tabs, so the newest month comes first.
 */
export function planMonthTab(month: string, expenses: SheetExpense[], tabs: TabInfo[]): MonthTabPlan {
  const rows = monthRows(expenses);
  const gridProperties = { rowCount: rows.length, columnCount: COLUMN_WIDTHS.length, frozenRowCount: 1 };
  const existing = tabs.find((t) => t.title === month);
  const sheetId = existing?.sheetId ?? freeSheetId(tabs, month);
  const index = existing?.index ?? newTabIndex(tabs, month);

  const requests: SheetRequest[] = existing
    ? [
        // The filter is set again below; clearing it first lets the grid shrink freely.
        { clearBasicFilter: { sheetId } },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties },
            fields: "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount",
          },
        },
      ]
    : [{ addSheet: { properties: { sheetId, title: month, index, gridProperties } } }];
  requests.push(
    // fields "*" with the whole tab as the range: every cell not written here is cleared.
    { updateCells: { range: { sheetId }, rows: rows.map((values) => ({ values })), fields: "*" } },
    ...COLUMN_WIDTHS.map((pixelSize, column) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: column, endIndex: column + 1 },
        properties: { pixelSize },
        fields: "pixelSize",
      },
    })),
    {
      setBasicFilter: {
        filter: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: 1 + expenses.length,
            startColumnIndex: 0,
            endColumnIndex: TABLE_HEADERS.length,
          },
        },
      },
    },
  );
  if (!existing?.protected) {
    requests.push({
      addProtectedRange: { protectedRange: { range: { sheetId }, description: PROTECTION_NOTE, warningOnly: true } },
    });
  }

  const after = existing
    ? tabs.map((t) => (t.sheetId === sheetId ? { ...t, protected: true } : t))
    : [
        ...tabs.map((t) => (t.index >= index ? { ...t, index: t.index + 1 } : t)),
        { sheetId, title: month, index, protected: true },
      ];
  return { sheetId, requests, tabs: after };
}

/**
 * The tab's cells, row by row, nine columns (A-I): the expense table in A-E, a blank column,
 * then the summary in G-I. Names are shown as in /summary.
 */
export function monthRows(expenses: SheetExpense[]): Cell[][] {
  const names = plainDisplayNames([...new Map(expenses.map((e) => [e.user_id, e])).values()]);
  const nameOf = (e: SheetExpense) => names.get(e.user_id) ?? e.first_name;
  const collator = new Intl.Collator("vi");

  const table = expenses
    .map((e, order) => ({ e, order, name: nameOf(e) }))
    .sort(
      (a, b) =>
        collator.compare(a.name, b.name) ||
        a.e.user_id - b.e.user_id ||
        compareText(a.e.spent_on, b.e.spent_on) ||
        a.order - b.order,
    )
    .map(({ e, name }) => [
      numberCell(sheetsDate(e.spent_on), DATE),
      textCell(name),
      numberCell(e.amount, AMOUNT),
      textCell(categoryLabel(e.category)),
      e.note ? textCell(e.note, NOTE) : BLANK,
    ]);

  const members = memberTotals(expenses);
  const total = expenses.reduce((sum, e) => sum + e.amount, 0);
  const summary = [
    ...members.map((m) => [textCell(nameOf(m.first)), numberCell(m.total, AMOUNT), numberCell(m.count)]),
    [textCell(GROUP_LABEL, GROUP_ROW), numberCell(total, { ...AMOUNT, ...GROUP_ROW }), numberCell(expenses.length, GROUP_ROW)],
  ];

  const header = [
    ...TABLE_HEADERS.map((h) => textCell(h, h === "Số tiền" ? NUMBER_HEADER : HEADER)),
    BLANK,
    ...SUMMARY_HEADERS.map((h) => textCell(h, h === "Thành viên" ? HEADER : NUMBER_HEADER)),
  ];
  const height = Math.max(table.length, summary.length);
  const body = Array.from({ length: height }, (_, i) => [
    ...(table[i] ?? blanks(TABLE_HEADERS.length)),
    BLANK,
    ...(summary[i] ?? blanks(SUMMARY_HEADERS.length)),
  ]);
  return [header, ...body];
}

/** "2026-10-08" -> 46303: Sheets stores dates as days since 1899-12-30. */
export function sheetsDate(ymd: string): number {
  const [year, month, day] = ymd.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / 86_400_000 + 25_569;
}

/** Totals per member, highest first, ties by first name: the order /summary uses. */
function memberTotals(expenses: SheetExpense[]): { first: SheetExpense; total: number; count: number }[] {
  const byMember = new Map<number, { first: SheetExpense; total: number; count: number }>();
  for (const e of expenses) {
    const m = byMember.get(e.user_id) ?? { first: e, total: 0, count: 0 };
    m.total += e.amount;
    m.count += 1;
    byMember.set(e.user_id, m);
  }
  return [...byMember.values()].sort(
    (a, b) => b.total - a.total || compareText(a.first.first_name, b.first.first_name) || a.first.user_id - b.first.user_id,
  );
}

/** "2026-10" -> 202610, or the next free id: deterministic, and stable once created. */
function freeSheetId(tabs: TabInfo[], month: string): number {
  const taken = new Set(tabs.map((t) => t.sheetId));
  let id = Number(month.replace("-", ""));
  while (taken.has(id)) id++;
  return id;
}

/** Left of the first older month tab; else right of the newer ones; else after every other tab. */
function newTabIndex(tabs: TabInfo[], month: string): number {
  const monthTabs = tabs.filter((t) => MONTH_TAB_TITLE.test(t.title)).sort((a, b) => a.index - b.index);
  const older = monthTabs.find((t) => t.title < month);
  if (older) return older.index;
  const last = monthTabs.at(-1);
  return last ? last.index + 1 : tabs.length;
}

function textCell(value: string, format?: object): Cell {
  return format ? { userEnteredValue: { stringValue: value }, userEnteredFormat: format } : { userEnteredValue: { stringValue: value } };
}

function numberCell(value: number, format?: object): Cell {
  return format ? { userEnteredValue: { numberValue: value }, userEnteredFormat: format } : { userEnteredValue: { numberValue: value } };
}

function blanks(count: number): Cell[] {
  return Array.from({ length: count }, () => BLANK);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
