// The Worker keeps Telegram's "/" command menu in step with src/commands/menu.ts by itself.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_MENU, commandMenuState, syncCommandMenu } from "../src/commands/menu";
import { getBotState, setBotState } from "../src/db";
import worker from "../src/index";
import { Telegram } from "../src/telegram";

const GROUP = -100123; // ALLOWED_CHAT_ID in vitest.config.ts
const NOW = new Date("2026-11-16T03:00:00Z");

let calls: { method: string; body: Record<string, unknown> }[];
let setMyCommandsFails: boolean;
let nextUpdateId: number;

beforeEach(async () => {
  calls = [];
  setMyCommandsFails = false;
  nextUpdateId = 1;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = String(input instanceof Request ? input.url : input).split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body)) });
    if (method === "setMyCommands" && setMyCommandsFails) return Response.json({ ok: false, description: "Too Many Requests" }, { status: 429 });
    return Response.json({ ok: true, result: true });
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.prepare("DELETE FROM bot_state").run(); // test/setup.ts marks the menu as registered
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function post(text: string): Promise<void> {
  const ctx = createExecutionContext();
  const id = nextUpdateId++;
  const update = {
    update_id: id,
    message: { message_id: id, from: { id: 1, is_bot: false, first_name: "An" }, chat: { id: GROUP, type: "supergroup" }, date: NOW.getTime() / 1000, text },
  };
  const res = await worker.fetch(
    new Request("https://bot.example/", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
      body: JSON.stringify(update),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
}

const menuCalls = () => calls.filter((c) => c.method === "setMyCommands");

describe("command menu", () => {
  it("is registered for the group after the first update, and not again while it is unchanged", async () => {
    await post("/help");
    expect(menuCalls()).toEqual([{ method: "setMyCommands", body: { commands: COMMAND_MENU, scope: { type: "chat", chat_id: GROUP } } }]);
    expect(calls.some((c) => c.method === "sendMessage")).toBe(true); // the update itself is still answered

    await post("/help");
    await post("hello");
    expect(menuCalls()).toHaveLength(1);
  });

  it("lists every command the bot answers, /app included", () => {
    expect(COMMAND_MENU.map((c) => c.command)).toEqual(["add", "check", "groupcheck", "budget", "summary", "groupsummary", "undo", "daily", "app", "help"]);
  });

  it("is registered again when the code's menu differs from the last one registered", async () => {
    await setBotState(env.DB, "command_menu", JSON.stringify({ commands: COMMAND_MENU.filter((c) => c.command !== "app"), scope: { type: "chat", chat_id: GROUP } }), NOW.toISOString());
    await post("/help");
    expect(menuCalls()).toHaveLength(1);
    expect(await getBotState(env.DB, "command_menu")).toBe(commandMenuState(GROUP));
  });

  it("goes to all group chats until ALLOWED_CHAT_ID is set, then moves to the group", async () => {
    const tg = new Telegram("test-token");
    await syncCommandMenu(env.DB, tg, null, NOW);
    expect(menuCalls().map((c) => c.body.scope)).toEqual([{ type: "all_group_chats" }]);
    await syncCommandMenu(env.DB, tg, GROUP, NOW);
    expect(menuCalls().map((c) => c.body.scope)).toEqual([{ type: "all_group_chats" }, { type: "chat", chat_id: GROUP }]);
  });

  it("is retried after the next update when Telegram refuses it", async () => {
    setMyCommandsFails = true;
    await post("/help");
    expect(await getBotState(env.DB, "command_menu")).toBeNull();

    setMyCommandsFails = false;
    await post("/help");
    expect(menuCalls()).toHaveLength(2);
    expect(await getBotState(env.DB, "command_menu")).toBe(commandMenuState(GROUP));
  });

  it("is not touched by requests that fail the webhook secret", async () => {
    const res = await worker.fetch(new Request("https://bot.example/", { method: "POST", body: "{}" }), env, createExecutionContext());
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
