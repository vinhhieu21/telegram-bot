// The Mini App: its page, its API (auth, membership, the month's data) and the /app command.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBudget } from "../src/db";
import worker from "../src/index";
import type { MonthResponse } from "../src/web/api";
import { INIT_DATA_MAX_AGE_S, verifyInitData } from "../src/web/auth";

const GROUP = -100123; // ALLOWED_CHAT_ID in vitest.config.ts
const OTHER_CHAT = -100999;
const BOT_TOKEN = "test-token";
const NOW = new Date("2026-11-16T03:00:00Z"); // 10:00 ICT, 16/11

const AN = { id: 1, first_name: "An", last_name: "Lê" };
const HIEU = { id: 2, first_name: "Hiếu", last_name: "Bùi" };
const HIEU_2 = { id: 3, first_name: "Hiếu", last_name: "Trần" };
const OUTSIDER = { id: 99, first_name: "Mallory", last_name: null };

/** getChatMember answers by user id; unknown ids get Telegram's 400. "down" makes Telegram fail. */
let chatStatus: Record<number, string | "down">;
let telegramCalls: { method: string; body: Record<string, unknown> }[];

beforeEach(() => {
  chatStatus = { [AN.id]: "member", [HIEU.id]: "creator", [HIEU_2.id]: "administrator" };
  telegramCalls = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    telegramCalls.push({ method, body });
    if (method !== "getChatMember") return Response.json({ ok: true, result: true });
    expect(body.chat_id).toBe(GROUP);
    const status = chatStatus[body.user_id as number];
    if (status === "down") return Response.json({ ok: false, description: "Too Many Requests" }, { status: 429 });
    if (status === undefined) return Response.json({ ok: false, description: "Bad Request: user not found" }, { status: 400 });
    return Response.json({ ok: true, result: { status, user: { id: body.user_id } } });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- Helpers ----------------------------------------------------------------------------------

/** Init data exactly as Telegram builds it: sorted "key=value" lines, HMAC'd with a key derived from the token. */
async function signInitData(fields: Record<string, string>, token = BOT_TOKEN): Promise<string> {
  const enc = new TextEncoder();
  const hmac = async (key: BufferSource, data: string) =>
    new Uint8Array(
      await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(data)),
    );
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const hash = [...(await hmac(await hmac(enc.encode("WebAppData"), token), checkString))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function initDataFor(user: { id: number; first_name: string }, authDate = NOW): Promise<string> {
  return signInitData({
    auth_date: String(Math.floor(authDate.getTime() / 1000)),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify({ id: user.id, first_name: user.first_name, language_code: "vi" }),
    signature: "c2lnbmF0dXJl", // newer clients add this; it is part of the checked string
  });
}

async function get(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://bot.example${path}`, { method, headers, redirect: "manual" }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function api(user: { id: number; first_name: string } | null, query = ""): Promise<Response> {
  return get(`/api/month${query}`, user ? { Authorization: `tma ${await initDataFor(user)}` } : {});
}

async function addMember(m: { id: number; first_name: string; last_name: string | null }): Promise<void> {
  await env.DB.prepare("INSERT INTO members (user_id, first_name, last_name, updated_at) VALUES (?, ?, ?, ?)")
    .bind(m.id, m.first_name, m.last_name, NOW.toISOString())
    .run();
}

async function addExpense(e: { user: number; amount: number; date: string; note?: string; category?: string | null; chat?: number; deleted?: boolean }): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO expenses (chat_id, user_id, amount, note, spent_on, created_at, category, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(e.chat ?? GROUP, e.user, e.amount, e.note ?? "", e.date, NOW.toISOString(), e.category ?? null, e.deleted ? NOW.toISOString() : null)
    .first<{ id: number }>();
  return row!.id;
}

// --- Init data --------------------------------------------------------------------------------

describe("verifyInitData", () => {
  it("accepts init data signed with the bot token and returns the user", async () => {
    expect(await verifyInitData(await initDataFor(AN), BOT_TOKEN, NOW)).toEqual({ ok: true, user: { id: AN.id, first_name: "An" } });
  });

  it("rejects init data signed with another bot's token", async () => {
    const data = await signInitData({ auth_date: String(NOW.getTime() / 1000), user: JSON.stringify({ id: 1 }) }, "other-token");
    expect(await verifyInitData(data, BOT_TOKEN, NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects init data whose user was changed after signing", async () => {
    const params = new URLSearchParams(await initDataFor(AN));
    params.set("user", JSON.stringify({ id: HIEU.id, first_name: "Hiếu" }));
    expect(await verifyInitData(params.toString(), BOT_TOKEN, NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a missing or malformed hash, and an empty bot token", async () => {
    const params = new URLSearchParams(await initDataFor(AN));
    const hash = params.get("hash")!;
    params.delete("hash");
    expect(await verifyInitData(params.toString(), BOT_TOKEN, NOW)).toMatchObject({ ok: false });
    params.set("hash", hash.slice(1));
    expect(await verifyInitData(params.toString(), BOT_TOKEN, NOW)).toMatchObject({ ok: false });
    expect(await verifyInitData("", BOT_TOKEN, NOW)).toMatchObject({ ok: false });
    expect(await verifyInitData(await initDataFor(AN), "", NOW)).toMatchObject({ ok: false });
  });

  it("expires after INIT_DATA_MAX_AGE_S", async () => {
    const old = new Date(NOW.getTime() - INIT_DATA_MAX_AGE_S * 1000);
    expect(await verifyInitData(await initDataFor(AN, old), BOT_TOKEN, NOW)).toMatchObject({ ok: true });
    const older = new Date(old.getTime() - 1000);
    expect(await verifyInitData(await initDataFor(AN, older), BOT_TOKEN, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects signed init data without a user", async () => {
    const data = await signInitData({ auth_date: String(NOW.getTime() / 1000) });
    expect(await verifyInitData(data, BOT_TOKEN, NOW)).toEqual({ ok: false, reason: "invalid" });
  });
});

// --- API access -------------------------------------------------------------------------------

describe("GET /api/month access", () => {
  it("needs Telegram init data", async () => {
    const res = await api(null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(telegramCalls).toEqual([]);
  });

  it("refuses forged init data without asking Telegram", async () => {
    const res = await get("/api/month", { Authorization: `tma ${await signInitData({ auth_date: "1", user: '{"id":1}' }, "guess")}` });
    expect(res.status).toBe(401);
    expect(telegramCalls).toEqual([]);
  });

  it("tells an expired session apart, so the page can say to reopen", async () => {
    const old = new Date(NOW.getTime() - (INIT_DATA_MAX_AGE_S + 60) * 1000);
    const res = await get("/api/month", { Authorization: `tma ${await initDataFor(AN, old)}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "expired" });
  });

  it("refuses a Telegram user who is not in the group, and one who left or was kicked", async () => {
    await addMember(AN);
    await addExpense({ user: AN.id, amount: 50_000, date: "2026-11-02" });
    let res = await api(OUTSIDER);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_member" });

    chatStatus[AN.id] = "left";
    expect((await api(AN)).status).toBe(403);
    chatStatus[AN.id] = "kicked";
    expect((await api(AN)).status).toBe(403);
    chatStatus[AN.id] = "restricted"; // without is_member: no longer in the group
    expect((await api(AN)).status).toBe(403);
  });

  it("answers 503 when Telegram cannot confirm membership", async () => {
    chatStatus[AN.id] = "down";
    const res = await api(AN);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("rejects malformed and future months", async () => {
    for (const month of ["2026-13", "2026-1", "nov", "2026-12", "2027-01"]) {
      const res = await api(AN, `?month=${month}`);
      expect(res.status, month).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_month" });
    }
  });

  it("is never cached", async () => {
    const res = await api(AN);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

// --- API data ---------------------------------------------------------------------------------

describe("GET /api/month data", () => {
  beforeEach(async () => {
    for (const m of [AN, HIEU, HIEU_2]) await addMember(m);
  });

  it("returns the month's live expenses in this group, newest day first", async () => {
    const lunch = await addExpense({ user: AN.id, amount: 50_000, date: "2026-11-02", note: "phở", category: "an_uong" });
    const grab = await addExpense({ user: HIEU.id, amount: 120_000, date: "2026-11-10", note: "grab", category: "di_chuyen" });
    const later = await addExpense({ user: AN.id, amount: 30_000, date: "2026-11-02", note: "cafe" });
    await addExpense({ user: AN.id, amount: 999_000, date: "2026-11-05", deleted: true });
    await addExpense({ user: AN.id, amount: 777_000, date: "2026-11-05", chat: OTHER_CHAT });
    await addExpense({ user: AN.id, amount: 10_000, date: "2026-10-31" }); // previous month

    const body = await (await api(AN)).json<MonthResponse>();
    expect(body.month).toBe("2026-11");
    expect(body.currentMonth).toBe("2026-11");
    expect(body.today).toBe("2026-11-16");
    expect(body.viewerId).toBe(AN.id);
    expect(body.expenses).toEqual([
      { id: grab, userId: HIEU.id, amount: 120_000, note: "grab", date: "2026-11-10", category: "di_chuyen" },
      { id: later, userId: AN.id, amount: 30_000, note: "cafe", date: "2026-11-02", category: null },
      { id: lunch, userId: AN.id, amount: 50_000, note: "phở", date: "2026-11-02", category: "an_uong" },
    ]);
  });

  it("totals the previous month per member and category up to the same day, and starts the month list at the first expense", async () => {
    await addExpense({ user: AN.id, amount: 40_000, date: "2026-10-03", category: "an_uong" });
    await addExpense({ user: AN.id, amount: 60_000, date: "2026-10-16", category: "an_uong" });
    await addExpense({ user: AN.id, amount: 70_000, date: "2026-10-17", category: "an_uong" }); // after "today" (16/11) a month ago
    await addExpense({ user: HIEU.id, amount: 25_000, date: "2026-10-12" });
    await addExpense({ user: HIEU.id, amount: 5_000, date: "2026-09-12" });
    await addExpense({ user: HIEU.id, amount: 1_000, date: "2026-08-01", deleted: true });

    const body = await (await api(HIEU)).json<MonthResponse>();
    expect(body.expenses).toEqual([]);
    expect(body.firstMonth).toBe("2026-09");
    expect(body.previousThrough).toBe("2026-10-16");
    expect([...body.previous].sort((a, b) => a.userId - b.userId)).toEqual([
      { userId: AN.id, category: "an_uong", total: 100_000 },
      { userId: HIEU.id, category: null, total: 25_000 },
    ]);
  });

  it("compares a past month with the whole month before it", async () => {
    await addExpense({ user: AN.id, amount: 40_000, date: "2026-09-03" });
    await addExpense({ user: AN.id, amount: 60_000, date: "2026-09-30" });
    const body = await (await api(AN, "?month=2026-10")).json<MonthResponse>();
    expect(body.previousThrough).toBe("2026-09-30");
    expect(body.previous).toEqual([{ userId: AN.id, category: null, total: 100_000 }]);
  });

  it("compares the end of a long month with the whole of a shorter one", async () => {
    vi.setSystemTime(new Date("2026-03-31T03:00:00Z"));
    await addExpense({ user: AN.id, amount: 60_000, date: "2026-02-28" });
    const body = await (await get("/api/month", { Authorization: `tma ${await initDataFor(AN, new Date("2026-03-31T03:00:00Z"))}` })).json<MonthResponse>();
    expect(body.month).toBe("2026-03");
    expect(body.previousThrough).toBe("2026-02-28");
    expect(body.previous).toEqual([{ userId: AN.id, category: null, total: 60_000 }]);
  });

  it("serves a past month by ?month=", async () => {
    await addExpense({ user: AN.id, amount: 5_000, date: "2026-09-12", note: "trà đá" });
    const body = await (await api(AN, "?month=2026-09")).json<MonthResponse>();
    expect(body.month).toBe("2026-09");
    expect(body.expenses.map((e) => e.note)).toEqual(["trà đá"]);
  });

  it("names members like the bot does: last names only where first names clash, plus the viewer", async () => {
    await addExpense({ user: HIEU.id, amount: 10_000, date: "2026-11-01" });
    await addExpense({ user: HIEU_2.id, amount: 10_000, date: "2026-10-01" });
    const body = await (await api(AN)).json<MonthResponse>();
    expect(body.members.sort((a, b) => a.id - b.id)).toEqual([
      { id: AN.id, name: "An" },
      { id: HIEU.id, name: "Hiếu Bùi" },
      { id: HIEU_2.id, name: "Hiếu Trần" },
    ]);
  });

  it("names a group member who never used the bot from their Telegram profile", async () => {
    chatStatus[42] = "member";
    const body = await (await api({ id: 42, first_name: "Mai" })).json<MonthResponse>();
    expect(body.members).toEqual([{ id: 42, name: "Mai" }]);
    expect(body.firstMonth).toBe("2026-11");
  });

  it("includes the group budget", async () => {
    expect((await (await api(AN)).json<MonthResponse>()).budget).toBeNull();
    await setBudget(env.DB, GROUP, 5_000_000, "2026-11", 0, NOW.toISOString());
    expect((await (await api(AN)).json<MonthResponse>()).budget).toBe(5_000_000);
  });
});

// --- Page and routing -------------------------------------------------------------------------

describe("the page", () => {
  it("serves the built index.html at /app/, referencing its hashed script and stylesheet", async () => {
    const res = await get("/app/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    const script = /src="(main\.[0-9a-f]{10}\.js)"/.exec(html)?.[1];
    const style = /href="(style\.[0-9a-f]{10}\.css)"/.exec(html)?.[1];
    expect(script).toBeDefined();
    expect(style).toBeDefined();
    expect((await get(`/app/${script}`)).status).toBe(200);
    expect((await get(`/app/${style}`)).status).toBe(200);
  });

  it("redirects /app to /app/", async () => {
    const res = await get("/app");
    expect([301, 307, 308]).toContain(res.status);
    expect(new URL(res.headers.get("location")!, "https://bot.example").pathname).toBe("/app/");
  });

  it("serves nothing outside /app/ and /api/month", async () => {
    for (const path of ["/", "/index.html", "/api/other", "/_headers"]) expect((await get(path)).status, path).toBe(404);
    expect((await get("/app/", {}, "DELETE")).status).toBe(404);
  });

  it("keeps every POST for the webhook, which still checks its secret", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://bot.example/api/month", { method: "POST", body: "{}" }), env, ctx);
    expect(res.status).toBe(401);
  });
});

describe("/app", () => {
  it("replies in the group with a button that opens the Main Mini App", async () => {
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("https://bot.example/", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
        body: JSON.stringify({
          update_id: 1,
          message: { message_id: 7, from: { id: AN.id, is_bot: false, first_name: "An" }, chat: { id: GROUP, type: "supergroup" }, date: NOW.getTime() / 1000, text: "/app" },
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(telegramCalls).toEqual([
      {
        method: "sendMessage",
        body: expect.objectContaining({
          chat_id: GROUP,
          text: "Biểu đồ chi tiêu của nhóm theo ngày, theo loại và theo thành viên.",
          reply_parameters: { message_id: 7, allow_sending_without_reply: true },
          reply_markup: { inline_keyboard: [[{ text: "Mở ứng dụng", url: "https://t.me/spending_test_bot?startapp" }]] },
        }),
      },
    ]);
  });
});
