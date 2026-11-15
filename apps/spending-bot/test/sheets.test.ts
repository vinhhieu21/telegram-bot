// Google Sheets sync end to end: Telegram updates and cron runs go in; Telegram messages and
// Google calls come out. The fake Google signs nothing in without a valid service-account JWT,
// applies a batchUpdate atomically, and refuses what Google refuses (writes outside the grid,
// duplicate tabs, unknown requests), so a bad plan fails here before it fails on the real Sheet.

import { applyD1Migrations, createExecutionContext, createScheduledController, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outOfDateSheetMonths, upsertMember } from "../src/db";
import { DAILY_CRON, MONTHLY_CRON } from "../src/crons";
import worker from "../src/index";
import type { TabInfo } from "../src/sheets/google";
import { MONTH_TAB_TITLE, planMonthTab, sheetsDate } from "../src/sheets/tab";
import type { TgUpdate, TgUser } from "../src/telegram";

const GROUP = -100123;
const ADMIN = 42;
const SHEET_ID = "test-sheet";
const SHEET_URL = "https://docs.google.com/spreadsheets/d/test-sheet/edit";
const SA_EMAIL = "spending-bot@test-project.iam.gserviceaccount.com";
const AN: TgUser = { id: 1, is_bot: false, first_name: "An" };
const HIEU: TgUser = { id: 2, is_bot: false, first_name: "Hiếu", last_name: "Bùi" };
const HIEU_TRAN: TgUser = { id: 3, is_bot: false, first_name: "Hiếu", last_name: "Trần" };
const PERMISSION_DENIED = { status: 403, reason: "PERMISSION_DENIED", message: "The caller does not have permission" };
const HEADER_ROW = ["Ngày", "Thành viên", "Số tiền", "Loại", "Ghi chú", "", "Thành viên", "Tổng", "Số khoản"];

/** Request and cell JSON. Loosely typed on purpose: the fake checks its shape the way Google does. */
type Json = Record<string, any>;

interface FakeTab {
  sheetId: number;
  title: string;
  index: number;
  rowCount: number;
  columnCount: number;
  frozenRowCount: number;
  rows: Json[][];
  columnWidths: Record<number, number>;
  filter: Json | null;
  protectedRanges: Json[];
}

interface GoogleFailure {
  status: number;
  reason: string;
  message: string;
}

/** The owner's tab in the real Sheet. Google gives a spreadsheet's first tab id 0. */
const INTRO_TAB: FakeTab = {
  sheetId: 0,
  title: "Giới thiệu",
  index: 0,
  rowCount: 1000,
  columnCount: 26,
  frozenRowCount: 0,
  rows: [[{ userEnteredValue: { stringValue: "Chi tiêu của nhóm, mỗi tháng một tab." } }]],
  columnWidths: { 0: 400 },
  filter: null,
  protectedRanges: [],
};

let spreadsheet: FakeTab[];
/** Every call out of the Worker, in order: "telegram sendMessage <chat>", "google token", "google get", "google batchUpdate". */
let calls: string[];
let messages: { chat_id: number; text: string }[];
let batchUpdates: Json[][];
let issuedTokens: Set<string>;
let jwts: { header: Json; claims: Json }[];
/** The next Sheets API calls fail with these, one each. */
let sheetsFailures: GoogleFailure[];
/** Every Sheets API call fails with this while set. */
let sheetsDown: GoogleFailure | null;
let adminUnreachable: boolean;
/** Runs once, while the next batchUpdate is in flight. */
let duringBatchUpdate: (() => Promise<void>) | null;
/** Requests the fake refused. Always a bug: tests inject failures with sheetsFailures/sheetsDown instead. */
let refused: string[];
let nextUpdateId: number;
let testEnv: Env;

let publicKey: CryptoKey;
let serviceAccountKey: string;

beforeAll(async () => {
  const keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  publicKey = keys.publicKey;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
  const base64 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  // The shape of a key downloaded from Google Cloud.
  serviceAccountKey = JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    private_key_id: "0123456789abcdef",
    private_key: pem,
    client_email: SA_EMAIL,
    client_id: "100000000000000000000",
    token_uri: "https://oauth2.googleapis.com/token",
  });
});

beforeEach(() => {
  spreadsheet = [structuredClone(INTRO_TAB)];
  calls = [];
  messages = [];
  batchUpdates = [];
  issuedTokens = new Set();
  jwts = [];
  sheetsFailures = [];
  sheetsDown = null;
  adminUnreachable = false;
  duringBatchUpdate = null;
  refused = [];
  nextUpdateId = 1;
  testEnv = { ...env, GOOGLE_SHEET_ID: SHEET_ID, GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountKey, ADMIN_USER_ID: String(ADMIN) };

  vi.spyOn(env.AI, "run").mockImplementation((async (_model: string, input: { messages: { content: string }[] }) => {
    const [system, user] = input.messages.map((m) => m.content) as [string, string];
    return { response: fakeAi(system, user) };
  }) as never);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T03:00:00Z")); // 10:00 ICT
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(refused).toEqual([]);
});

/** Workers AI stub: categorisation by keyword, a fixed line for the monthly commentary. */
function fakeAi(system: string, user: string): string {
  if (!system.includes("phân loại")) return "Cả nhóm chi chủ yếu cho ăn uống.";
  const answer: Record<string, string> = {};
  for (const [, n, note] of user.matchAll(/^(\d+)\. (.*)$/gm)) {
    answer[n!] = /cafe|phở/.test(note!) ? "an_uong" : /grab|xăng/.test(note!) ? "di_chuyen" : "khac";
  }
  return JSON.stringify(answer);
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  switch (url.hostname) {
    case "api.telegram.org":
      return telegram(url, init);
    case "oauth2.googleapis.com":
      return googleToken(init);
    case "sheets.googleapis.com":
      return googleSheets(url, init);
    default:
      throw new Error(`unexpected fetch to ${url.hostname}`);
  }
}

function telegram(url: URL, init?: RequestInit): Response {
  const method = url.pathname.split("/").pop();
  const body = JSON.parse(String(init?.body)) as { chat_id: number; text?: string };
  calls.push(`telegram ${method} ${body.chat_id}`);
  if (body.chat_id === ADMIN && adminUnreachable) {
    return Response.json(
      { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
      { status: 403 },
    );
  }
  if (method === "sendMessage") messages.push({ chat_id: body.chat_id, text: String(body.text) });
  return Response.json({ ok: true, result: true });
}

/** Google's OAuth token endpoint: accepts only a JWT signed with the service account's key. */
async function googleToken(init?: RequestInit): Promise<Response> {
  calls.push("google token");
  const form = new URLSearchParams(String(init?.body));
  const [header = "", claims = "", signature = ""] = (form.get("assertion") ?? "").split(".");
  const signed = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    fromBase64url(signature),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || !signed) {
    refused.push("token request without a valid JWT");
    return Response.json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, { status: 400 });
  }
  jwts.push({ header: jsonOf(header), claims: jsonOf(claims) });
  const token = `token-${issuedTokens.size + 1}`;
  issuedTokens.add(token);
  return Response.json({ access_token: token, expires_in: 3599, token_type: "Bearer" });
}

async function googleSheets(url: URL, init?: RequestInit): Promise<Response> {
  const isGet = (init?.method ?? "GET") === "GET";
  const name = isGet ? "get" : "batchUpdate";
  const failure = sheetsFailures.shift() ?? sheetsDown;
  if (failure) {
    calls.push(`google ${name} ${failure.status}`);
    return googleError(failure);
  }
  calls.push(`google ${name}`);

  const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
  if (!token || !issuedTokens.has(token)) return refuse(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
  if (url.pathname !== `/v4/spreadsheets/${SHEET_ID}${isGet ? "" : ":batchUpdate"}`) {
    return refuse(404, "NOT_FOUND", `no such path ${url.pathname}`);
  }
  if (isGet) return Response.json({ sheets: byIndex(spreadsheet).map(describeTab) });

  const { requests } = JSON.parse(String(init?.body)) as { requests: Json[] };
  const draft = structuredClone(spreadsheet);
  try {
    requests.forEach((request, i) => applyRequest(draft, request, i));
  } catch (err) {
    return refuse(400, "INVALID_ARGUMENT", err instanceof Error ? err.message : String(err));
  }
  spreadsheet = draft;
  batchUpdates.push(requests);
  const hook = duringBatchUpdate;
  duringBatchUpdate = null;
  await hook?.();
  return Response.json({ spreadsheetId: SHEET_ID, replies: requests.map(() => ({})) });
}

function refuse(status: number, reason: string, message: string): Response {
  refused.push(`${status} ${message}`);
  return googleError({ status, reason, message });
}

function googleError({ status, reason, message }: GoogleFailure): Response {
  return Response.json({ error: { code: status, message, status: reason } }, { status });
}

/** A tab as spreadsheets.get describes it. Like Google, leaves out fields whose value is 0. */
function describeTab(tab: FakeTab): Json {
  const properties: Json = { title: tab.title };
  if (tab.sheetId !== 0) properties.sheetId = tab.sheetId;
  if (tab.index !== 0) properties.index = tab.index;
  if (tab.protectedRanges.length === 0) return { properties };
  return { properties, protectedRanges: tab.protectedRanges.map((_, i) => ({ protectedRangeId: 1000 + i })) };
}

/** Applies one batchUpdate request to `tabs`, or throws Google's complaint about it. */
function applyRequest(tabs: FakeTab[], request: Json, i: number): void {
  const kinds = Object.keys(request);
  if (kinds.length !== 1) throw new Error(`requests[${i}] has ${kinds.length} kinds`);
  const kind = kinds[0]!;
  const body = request[kind] as Json;
  const where = `requests[${i}].${kind}`;
  const tabWithId = (sheetId: unknown): FakeTab => {
    const tab = tabs.find((t) => t.sheetId === (sheetId ?? 0));
    if (!tab) throw new Error(`${where}: No grid with id: ${String(sheetId)}`);
    return tab;
  };

  switch (kind) {
    case "addSheet": {
      const { sheetId, title, index = tabs.length, gridProperties = {} } = body.properties as Json;
      if (tabs.some((t) => t.sheetId === sheetId)) throw new Error(`${where}: sheet id ${sheetId} is already in use`);
      if (tabs.some((t) => t.title === title)) throw new Error(`${where}: A sheet with the name "${title}" already exists`);
      if (index > tabs.length) throw new Error(`${where}: index ${index} is past the last tab`);
      for (const t of tabs) if (t.index >= index) t.index++;
      const tab: FakeTab = {
        sheetId,
        title,
        index,
        rowCount: gridProperties.rowCount ?? 1000,
        columnCount: gridProperties.columnCount ?? 26,
        frozenRowCount: gridProperties.frozenRowCount ?? 0,
        rows: [],
        columnWidths: {},
        filter: null,
        protectedRanges: [],
      };
      if (tab.frozenRowCount >= tab.rowCount) throw new Error(`${where}: You can't freeze all visible rows on the sheet.`);
      tabs.push(tab);
      return;
    }
    case "updateSheetProperties": {
      const { properties, fields } = body;
      if (fields !== "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount") {
        throw new Error(`${where}: unexpected fields ${fields}`);
      }
      const tab = tabWithId(properties.sheetId);
      const { rowCount, columnCount, frozenRowCount } = properties.gridProperties as Json;
      if (frozenRowCount >= rowCount) throw new Error(`${where}: You can't freeze all visible rows on the sheet.`);
      Object.assign(tab, { rowCount, columnCount, frozenRowCount });
      tab.rows = tab.rows.slice(0, rowCount).map((row) => row.slice(0, columnCount));
      return;
    }
    case "clearBasicFilter":
      tabWithId(body.sheetId).filter = null;
      return;
    case "updateCells": {
      const { range, rows, fields } = body;
      if (Object.keys(range).join() !== "sheetId" || fields !== "*") throw new Error(`${where}: expected the whole tab with fields "*"`);
      const tab = tabWithId(range.sheetId);
      if (rows.length > tab.rowCount || rows.some((row: Json) => row.values.length > tab.columnCount)) {
        throw new Error(`${where}: Range exceeds grid limits.`);
      }
      tab.rows = rows.map((row: Json) => row.values);
      return;
    }
    case "updateDimensionProperties": {
      const { range, properties, fields } = body;
      const tab = tabWithId(range.sheetId);
      if (range.dimension !== "COLUMNS" || fields !== "pixelSize") throw new Error(`${where}: expected column widths`);
      if (range.endIndex > tab.columnCount) throw new Error(`${where}: Range exceeds grid limits.`);
      for (let c = range.startIndex; c < range.endIndex; c++) tab.columnWidths[c] = properties.pixelSize;
      return;
    }
    case "setBasicFilter": {
      const { range } = body.filter;
      const tab = tabWithId(range.sheetId);
      if (range.endRowIndex > tab.rowCount || range.endColumnIndex > tab.columnCount) {
        throw new Error(`${where}: Range exceeds grid limits.`);
      }
      tab.filter = range;
      return;
    }
    case "addProtectedRange":
      tabWithId(body.protectedRange.range.sheetId).protectedRanges.push(body.protectedRange);
      return;
    default:
      throw new Error(`${where}: not a request the bot should send`);
  }
}

function fromBase64url(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

function jsonOf(base64url: string): Json {
  return JSON.parse(new TextDecoder().decode(fromBase64url(base64url))) as Json;
}

function byIndex(tabs: FakeTab[]): FakeTab[] {
  return [...tabs].sort((a, b) => a.index - b.index);
}

function messageUpdate(text: string, from: TgUser): TgUpdate {
  const id = nextUpdateId++;
  return {
    update_id: id,
    message: { message_id: 1000 + id, from, chat: { id: GROUP, type: "supergroup" }, date: Math.floor(Date.now() / 1000), text },
  };
}

function editUpdate(original: TgUpdate, text: string): TgUpdate {
  return { update_id: nextUpdateId++, edited_message: { ...original.message!, text, edit_date: Math.floor(Date.now() / 1000) } };
}

/** Delivers the update and waits for its background work (categories, the sync) to finish. */
async function post(update: TgUpdate): Promise<void> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://bot.example/", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
      body: JSON.stringify(update),
    }),
    testEnv,
    ctx,
  );
  expect(res.status).toBe(200);
  await waitOnExecutionContext(ctx);
}

async function send(text: string, from: TgUser = AN): Promise<TgUpdate> {
  const update = messageUpdate(text, from);
  await post(update);
  return update;
}

/** Runs a cron job with the clock at its scheduled time, as in production. */
async function runCron(cron: string, isoTime: string): Promise<void> {
  vi.setSystemTime(new Date(isoTime));
  await worker.scheduled(createScheduledController({ cron, scheduledTime: new Date(isoTime) }), testEnv);
}

function tab(title: string): FakeTab {
  const found = spreadsheet.find((t) => t.title === title);
  if (!found) throw new Error(`no tab "${title}" in ${tabTitles().join(", ")}`);
  return found;
}

function tabTitles(): string[] {
  return byIndex(spreadsheet).map((t) => t.title);
}

/** The tab's cells as text, every row and column of its grid. Dates as dd/mm/yyyy, numbers plain. */
function cells(title: string): string[][] {
  const { rows, rowCount, columnCount } = tab(title);
  return Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => cellText(rows[r]?.[c])));
}

function cellText(cell: Json | undefined): string {
  const value = cell?.userEnteredValue as Json | undefined;
  if (!value) return "";
  if (typeof value.stringValue === "string") return value.stringValue;
  if (cell?.userEnteredFormat?.numberFormat?.type === "DATE") {
    return new Date((value.numberValue - 25_569) * 86_400_000).toISOString().slice(0, 10).split("-").reverse().join("/");
  }
  return String(value.numberValue);
}

/** The expense table (A-E): the header, then one row per expense. */
function table(title: string): string[][] {
  return cells(title)
    .map((row) => row.slice(0, 5))
    .filter((row) => row.some(Boolean));
}

/** The per-member summary (G-I): the header, the members, then the group's row. */
function summary(title: string): string[][] {
  return cells(title)
    .map((row) => row.slice(6, 9))
    .filter((row) => row.some(Boolean));
}

function googleCalls(): string[] {
  return calls.filter((c) => c.startsWith("google"));
}

function requestKinds(requests: Json[]): string[] {
  return requests.map((r) => Object.keys(r)[0]!);
}

function adminMessages(): string[] {
  return messages.filter((m) => m.chat_id === ADMIN).map((m) => m.text);
}

async function syncRows() {
  const { results } = await env.DB.prepare(
    "SELECT month, version = synced_version AS in_sync, lease_until, tab_id FROM sheet_sync ORDER BY month",
  ).all();
  return results;
}

async function sheetHealth() {
  return env.DB.prepare("SELECT failing_since, last_error, alerted FROM sheet_health").first();
}

async function insertExpense(userId: number, spentOn: string, messageId: number, note = "x"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO expenses (chat_id, user_id, amount, note, spent_on, created_at, message_id)
     VALUES (?, ?, 1000, ?, ?, '2026-10-08T03:00:00.000Z', ?)`,
  )
    .bind(GROUP, userId, note, spentOn, messageId)
    .run();
}

describe("month tabs", () => {
  it("are written once after /add, after the reply and with the category", async () => {
    await send("/add 50k cafe");

    expect(calls).toEqual([`telegram sendMessage ${GROUP}`, "google token", "google get", "google batchUpdate"]);
    expect(tabTitles()).toEqual(["Giới thiệu", "2026-10"]);
    expect(cells("2026-10")).toEqual([
      HEADER_ROW,
      ["08/10/2026", "An", "50000", "Ăn uống", "cafe", "", "An", "50000", "1"],
      ["", "", "", "", "", "", "Cả nhóm", "50000", "1"],
    ]);
    expect(await syncRows()).toEqual([{ month: "2026-10", in_sync: 1, lease_until: null, tab_id: 202610 }]);
  });

  it("are laid out for reading and filtering, and protected with a warning", async () => {
    await send("/add 50k cafe");

    const written = tab("2026-10");
    expect(written).toMatchObject({ sheetId: 202610, rowCount: 3, columnCount: 9, frozenRowCount: 1 });
    expect(written.filter).toEqual({ sheetId: 202610, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 5 });
    expect(written.columnWidths).toEqual({ 0: 96, 1: 150, 2: 110, 3: 130, 4: 260, 5: 24, 6: 150, 7: 110, 8: 80 });
    expect(written.protectedRanges).toEqual([
      {
        range: { sheetId: 202610 },
        description: "Bot tự cập nhật tab này. Sửa ở đây sẽ bị ghi đè ở lần cập nhật sau.",
        warningOnly: true,
      },
    ]);
    const [header, expense, group] = written.rows as [Json[], Json[], Json[]];
    expect(header[0]!.userEnteredFormat).toMatchObject({ textFormat: { bold: true } });
    expect(header[2]!.userEnteredFormat).toMatchObject({ textFormat: { bold: true }, horizontalAlignment: "RIGHT" });
    expect(expense[0]).toEqual({
      userEnteredValue: { numberValue: 46303 },
      userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dd/mm/yyyy" }, horizontalAlignment: "LEFT" },
    });
    expect(expense[2]!.userEnteredFormat).toEqual({ numberFormat: { type: "NUMBER", pattern: "#,##0" } });
    expect(group[6]!.userEnteredFormat).toMatchObject({ textFormat: { bold: true }, borders: { top: { style: "SOLID" } } });

    await send("/add 20k grab");
    expect(requestKinds(batchUpdates[1]!)).toEqual([
      "clearBasicFilter",
      "updateSheetProperties",
      "updateCells",
      ...Array<string>(9).fill("updateDimensionProperties"),
      "setBasicFilter",
    ]);
    expect(tab("2026-10").protectedRanges).toHaveLength(1);
  });

  it("sort by member then date, total per member, and tell apart members with the same first name", async () => {
    await send("/add 50k cafe");
    await send("/add 20k grab 05/10");
    await send("/add 100k phở 07/10", HIEU);
    await send("/add 30k xăng", HIEU_TRAN);
    await send("/add 10k", HIEU_TRAN);

    expect(table("2026-10")).toEqual([
      ["Ngày", "Thành viên", "Số tiền", "Loại", "Ghi chú"],
      ["05/10/2026", "An", "20000", "Di chuyển", "grab"],
      ["08/10/2026", "An", "50000", "Ăn uống", "cafe"],
      ["07/10/2026", "Hiếu Bùi", "100000", "Ăn uống", "phở"],
      ["08/10/2026", "Hiếu Trần", "30000", "Di chuyển", "xăng"],
      ["08/10/2026", "Hiếu Trần", "10000", "Khác", ""],
    ]);
    expect(summary("2026-10")).toEqual([
      ["Thành viên", "Tổng", "Số khoản"],
      ["Hiếu Bùi", "100000", "1"],
      ["An", "70000", "2"],
      ["Hiếu Trần", "40000", "2"],
      ["Cả nhóm", "210000", "5"],
    ]);
    expect(tab("2026-10").filter).toMatchObject({ endRowIndex: 6 });
    expect(cells("2026-10").every((row) => row[5] === "")).toBe(true);
  });

  it("follow an edit that moves an expense to another month, and stay when a month empties", async () => {
    const cafe = await send("/add 50k cafe");
    await send("/add 20k grab");

    calls = [];
    await post(editUpdate(cafe, "/add 50k cafe 30/09"));
    expect(calls).toEqual([
      `telegram sendMessage ${GROUP}`,
      "google token",
      "google get",
      "google batchUpdate",
      "google batchUpdate",
    ]);
    expect(tabTitles()).toEqual(["Giới thiệu", "2026-10", "2026-09"]);
    expect(table("2026-10").slice(1)).toEqual([["08/10/2026", "An", "20000", "Di chuyển", "grab"]]);
    expect(table("2026-09").slice(1)).toEqual([["30/09/2026", "An", "50000", "Ăn uống", "cafe"]]);

    await send("/undo");
    expect(cells("2026-10")).toEqual([HEADER_ROW, ["", "", "", "", "", "", "Cả nhóm", "0", "0"]]);
    expect(tab("2026-10").filter).toMatchObject({ endRowIndex: 1 });
    expect(table("2026-09")).toHaveLength(2);
  });

  it("go newest first, after the owner's own tabs, which the bot never touches", async () => {
    spreadsheet.push({ ...structuredClone(INTRO_TAB), sheetId: 555, title: "Biểu đồ", index: 1 });
    const ownerTabs = structuredClone(spreadsheet);

    await send("/add 50k cafe");
    await send("/add 10k a 30/09");
    vi.setSystemTime(new Date("2026-11-02T03:00:00Z"));
    await send("/add 10k b");
    expect(tabTitles()).toEqual(["Giới thiệu", "Biểu đồ", "2026-11", "2026-10", "2026-09"]);

    // The owner drags their tab to the end. A month older than all others still goes after the months.
    for (const t of spreadsheet) t.index = MONTH_TAB_TITLE.test(t.title) ? t.index - 1 : t.title === "Biểu đồ" ? 4 : t.index;
    await send("/add 10k c 15/08");
    expect(tabTitles()).toEqual(["Giới thiệu", "2026-11", "2026-10", "2026-09", "2026-08", "Biểu đồ"]);

    for (const owned of ownerTabs) expect(tab(owned.title)).toEqual({ ...owned, index: tab(owned.title).index });
  });

  it("are written again when the month changes during the write", async () => {
    duringBatchUpdate = async () => {
      // Another member's /add lands meanwhile. Its own sync finds the month taken and leaves it to this one.
      await upsertMember(env.DB, HIEU, new Date().toISOString());
      await insertExpense(HIEU.id, "2026-10-08", 999, "xăng");
    };
    await send("/add 50k cafe");

    expect(batchUpdates).toHaveLength(2);
    expect(table("2026-10").slice(1)).toEqual([
      ["08/10/2026", "An", "50000", "Ăn uống", "cafe"],
      ["08/10/2026", "Hiếu", "1000", "Chưa phân loại", "xăng"],
    ]);
    expect(await syncRows()).toEqual([{ month: "2026-10", in_sync: 1, lease_until: null, tab_id: 202610 }]);
  });

  it("are left to the sync writing them until its lease runs out", async () => {
    await send("/add 50k cafe");
    await env.DB.prepare("UPDATE sheet_sync SET lease_until = '2026-10-08T03:01:00.000Z'").run();

    calls = [];
    await send("/add 20k grab");
    expect(calls).toEqual([`telegram sendMessage ${GROUP}`]);
    expect(await syncRows()).toMatchObject([{ in_sync: 0 }]);

    vi.setSystemTime(new Date("2026-10-08T03:01:00Z"));
    await send("/summary");
    expect(table("2026-10")).toHaveLength(3);
    expect(await syncRows()).toEqual([{ month: "2026-10", in_sync: 1, lease_until: null, tab_id: 202610 }]);
  });

  it("are all written in one sign-in when several months are out of date", async () => {
    await upsertMember(env.DB, AN, new Date().toISOString());
    await insertExpense(AN.id, "2026-08-10", 1);
    await insertExpense(AN.id, "2026-09-10", 2);
    await insertExpense(AN.id, "2026-10-01", 3);
    await send("/help");

    expect(googleCalls()).toEqual(["google token", "google get", "google batchUpdate", "google batchUpdate", "google batchUpdate"]);
    expect(tabTitles()).toEqual(["Giới thiệu", "2026-10", "2026-09", "2026-08"]);
    const iat = Math.floor(Date.now() / 1000);
    expect(jwts).toEqual([
      {
        header: { alg: "RS256", typ: "JWT" },
        claims: {
          iss: SA_EMAIL,
          scope: "https://www.googleapis.com/auth/spreadsheets",
          aud: "https://oauth2.googleapis.com/token",
          iat,
          exp: iat + 3600,
        },
      },
    ]);
  });

  it("are not written when GOOGLE_SHEET_ID is empty", async () => {
    testEnv = { ...testEnv, GOOGLE_SHEET_ID: "" };
    await send("/add 50k cafe");
    await runCron(DAILY_CRON, "2026-10-08T14:00:00Z");
    expect(calls).toEqual([`telegram sendMessage ${GROUP}`]);
  });
});

describe("failures", () => {
  it("leave the month out of date, and the next command writes it", async () => {
    sheetsFailures = [PERMISSION_DENIED];
    await send("/add 50k cafe");

    expect(messages.map((m) => m.chat_id)).toEqual([GROUP]); // the reply, nothing else
    expect(tabTitles()).toEqual(["Giới thiệu"]);
    expect(await syncRows()).toEqual([{ month: "2026-10", in_sync: 0, lease_until: null, tab_id: null }]);
    expect(await sheetHealth()).toEqual({
      failing_since: "2026-10-08T03:00:00.000Z",
      last_error: "403 PERMISSION_DENIED: The caller does not have permission",
      alerted: 0,
    });

    await send("/summary");
    expect(table("2026-10").slice(1)).toEqual([["08/10/2026", "An", "50000", "Ăn uống", "cafe"]]);
    expect(await sheetHealth()).toBeNull();
    expect(adminMessages()).toEqual([]); // fixed before the night, so nobody needs to hear about it
  });

  it("are told to the admin once at night, and the recovery once", async () => {
    sheetsDown = PERMISSION_DENIED;
    await send("/add 50k cafe");
    await runCron(DAILY_CRON, "2026-10-08T14:00:00Z");
    await runCron(DAILY_CRON, "2026-10-09T14:00:00Z");
    expect(adminMessages()).toEqual([
      "<b>Google Sheets không cập nhật được</b>\n" +
        `Từ 08/10, bot không ghi được chi tiêu vào <a href="${SHEET_URL}">bảng tính</a>. ` +
        "Bot vẫn thử lại sau mỗi lệnh và mỗi tối, và sẽ báo khi cập nhật lại được.\n" +
        "Lỗi: <code>403 PERMISSION_DENIED: The caller does not have permission</code>",
    ]);

    sheetsDown = null;
    vi.setSystemTime(new Date("2026-10-10T03:00:00Z"));
    await send("/summary");
    await runCron(DAILY_CRON, "2026-10-10T14:00:00Z");
    expect(adminMessages().slice(1)).toEqual([`<a href="${SHEET_URL}">Google Sheets</a> đã cập nhật lại bình thường.`]);
    expect(table("2026-10")).toHaveLength(2);
  });

  it("are told to the admin again the next night when the message could not be delivered", async () => {
    sheetsDown = PERMISSION_DENIED;
    adminUnreachable = true;
    await send("/add 50k cafe");
    await runCron(DAILY_CRON, "2026-10-08T14:00:00Z");
    expect(calls.filter((c) => c === `telegram sendMessage ${ADMIN}`)).toHaveLength(1);

    adminUnreachable = false;
    await runCron(DAILY_CRON, "2026-10-09T14:00:00Z");
    await runCron(DAILY_CRON, "2026-10-10T14:00:00Z");
    expect(adminMessages()).toHaveLength(1);
    expect(adminMessages()[0]).toContain("Từ 08/10, bot không ghi được");
  });

  it("are only logged without ADMIN_USER_ID", async () => {
    testEnv = { ...testEnv, ADMIN_USER_ID: "" };
    sheetsDown = PERMISSION_DENIED;
    await send("/add 50k cafe");
    await runCron(DAILY_CRON, "2026-10-08T14:00:00Z");
    sheetsDown = null;
    await runCron(DAILY_CRON, "2026-10-09T14:00:00Z");

    expect(messages.map((m) => m.chat_id)).toEqual([GROUP]);
    expect(await sheetHealth()).toBeNull();
    expect(table("2026-10")).toHaveLength(2);
  });

  it("include an unusable service account key, found without calling Google", async () => {
    testEnv = { ...testEnv, GOOGLE_SERVICE_ACCOUNT_KEY: "" };
    await send("/add 50k cafe");
    expect(googleCalls()).toEqual([]);
    expect(await sheetHealth()).toMatchObject({ last_error: "GOOGLE_SERVICE_ACCOUNT_KEY is missing or not JSON" });
  });

  it("are retried within the call when Google is briefly unavailable", async () => {
    sheetsFailures = [{ status: 503, reason: "UNAVAILABLE", message: "The service is currently unavailable." }];
    await send("/add 50k cafe");
    expect(googleCalls()).toEqual(["google token", "google get 503", "google get", "google batchUpdate"]);
    expect(await sheetHealth()).toBeNull();
  });
});

describe("monthly summary", () => {
  it("ends with a link to the month's tab", async () => {
    vi.setSystemTime(new Date("2026-09-20T03:00:00Z"));
    await send("/add 50k cafe");
    await runCron(MONTHLY_CRON, "2026-10-01T02:00:00Z");

    const text = messages.at(-1)!.text;
    expect(text).toMatch(/^<b>Tổng kết tháng 9\/2026<\/b>/);
    expect(text.split("\n").slice(-2)).toEqual(["", `Chi tiết tháng 9: <a href="${SHEET_URL}#gid=202609">Google Sheets</a>`]);
  });

  it("says so when the month's tab could not be updated", async () => {
    vi.setSystemTime(new Date("2026-09-20T03:00:00Z"));
    sheetsDown = PERMISSION_DENIED;
    await send("/add 50k cafe");
    await runCron(MONTHLY_CRON, "2026-10-01T02:00:00Z");

    expect(messages.at(-1)!.text.split("\n").slice(-2)).toEqual([
      "",
      "<i>Google Sheets chưa cập nhật được tháng 9, bot sẽ thử lại sau.</i>",
    ]);
  });
});

describe("sheet_sync bookkeeping", () => {
  const outOfDate = () => outOfDateSheetMonths(env.DB, GROUP, 100);
  const markAllSynced = () => env.DB.prepare("UPDATE sheet_sync SET synced_version = version").run();
  const t = "2026-10-08T03:00:00.000Z";

  it("starts with every month that has live expenses out of date, for the first sync", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => !m.name.startsWith("0005_")));
    await upsertMember(env.DB, AN, t);
    await insertExpense(AN.id, "2026-08-01", 1);
    await insertExpense(AN.id, "2026-09-15", 2);
    await insertExpense(AN.id, "2026-10-01", 3);
    await insertExpense(AN.id, "2026-10-02", 4);
    await env.DB.prepare("UPDATE expenses SET deleted_at = ? WHERE message_id = 1").bind(t).run();

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await outOfDate()).toEqual(["2026-10", "2026-09"]);
  });

  it("marks a month out of date on every change its tab shows, and only then", async () => {
    await upsertMember(env.DB, AN, t);
    await insertExpense(AN.id, "2026-10-01", 1);
    expect(await outOfDate()).toEqual(["2026-10"]);

    const change = async (sql: string) => {
      await markAllSynced();
      await env.DB.prepare(sql).run();
      return outOfDate();
    };
    expect(await change("UPDATE expenses SET category = 'khac'")).toEqual(["2026-10"]);
    expect(await change("UPDATE expenses SET amount = 2000")).toEqual(["2026-10"]);
    expect(await change("UPDATE expenses SET note = 'y'")).toEqual(["2026-10"]);
    expect(await change("UPDATE expenses SET updated_at = '2026-10-08T04:00:00.000Z', edit_date = 1")).toEqual([]);
    expect(await change("UPDATE expenses SET spent_on = '2026-09-30'")).toEqual(["2026-10", "2026-09"]);
    expect(await change("UPDATE expenses SET deleted_at = '2026-10-08T04:00:00.000Z'")).toEqual(["2026-09"]);
  });

  it("marks the months a member is listed in when their name changes", async () => {
    await upsertMember(env.DB, AN, t);
    await upsertMember(env.DB, HIEU, t);
    await insertExpense(AN.id, "2026-08-01", 1);
    await insertExpense(AN.id, "2026-09-15", 2);
    await insertExpense(AN.id, "2026-10-01", 3);
    await insertExpense(HIEU.id, "2026-10-02", 4);
    await env.DB.prepare("UPDATE expenses SET deleted_at = ? WHERE message_id = 1").bind(t).run();
    await markAllSynced();

    await upsertMember(env.DB, { ...AN, username: "an_moi" }, "2026-10-08T04:00:00.000Z"); // every command does this
    expect(await outOfDate()).toEqual([]);
    await upsertMember(env.DB, { ...AN, first_name: "Ân" }, t);
    expect(await outOfDate()).toEqual(["2026-10", "2026-09"]);

    await markAllSynced();
    await upsertMember(env.DB, { id: HIEU.id, is_bot: false, first_name: "Hiếu" }, t);
    expect(await outOfDate()).toEqual(["2026-10"]);
  });
});

describe("planMonthTab", () => {
  const tabs: TabInfo[] = [
    { sheetId: 0, title: "Giới thiệu", index: 0, protected: false },
    { sheetId: 7, title: "2026-10", index: 1, protected: true },
  ];

  it("counts dates as Sheets does, in days since 1899-12-30", () => {
    expect(sheetsDate("1899-12-30")).toBe(0);
    expect(sheetsDate("2024-01-01")).toBe(45292);
    expect(sheetsDate("2026-10-08")).toBe(46303);
  });

  it("rewrites an existing tab in place and keeps its protection", () => {
    const plan = planMonthTab("2026-10", [], tabs);
    expect(plan.sheetId).toBe(7);
    expect(plan.tabs).toEqual(tabs);
    expect(requestKinds(plan.requests)).not.toContain("addSheet");
    expect(requestKinds(plan.requests)).not.toContain("addProtectedRange");
  });

  it("gives a new tab the month as its id, or the next free one", () => {
    expect(planMonthTab("2026-11", [], tabs).sheetId).toBe(202611);
    expect(planMonthTab("2026-11", [], [...tabs, { sheetId: 202611, title: "Biểu đồ", index: 2, protected: false }]).sheetId).toBe(
      202612,
    );
  });
});
