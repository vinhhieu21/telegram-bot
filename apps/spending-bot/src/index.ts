// fetch() = Telegram webhook (any POST) and the Mini App (GET /app/, /api/month), scheduled() = cron jobs.

import { createLlm } from "./ai/llm";
import { syncCommandMenu } from "./commands/menu";
import { DAILY_CRON, MONTHLY_CRON } from "./crons";
import { markUpdateProcessed } from "./db";
import { runDailyJob } from "./jobs/daily";
import { runMonthlyJob } from "./jobs/monthly";
import { handleUpdate } from "./router";
import { sheetConfig } from "./sheets/sync";
import { Telegram, type TgUpdate } from "./telegram";
import { handleWebRequest } from "./web/server";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method !== "POST") {
      return handleWebRequest(request, {
        db: env.DB,
        tg: new Telegram(env.BOT_TOKEN),
        assets: env.ASSETS,
        botToken: env.BOT_TOKEN,
        allowedChatId: parseChatId(env.ALLOWED_CHAT_ID),
        now: new Date(),
      });
    }
    if (!timingSafeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", env.WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    // From here on always answer 200, so Telegram never retries and duplicates entries.
    try {
      const update = await request.json<TgUpdate>();
      const now = new Date();
      if (!(await markUpdateProcessed(env.DB, update.update_id, now.toISOString()))) {
        return new Response("ok");
      }
      const tg = new Telegram(env.BOT_TOKEN);
      const allowedChatId = parseChatId(env.ALLOWED_CHAT_ID);
      // In the background, alongside the update: one D1 read, and a Telegram call only when the menu changed.
      ctx.waitUntil(syncCommandMenu(env.DB, tg, allowedChatId, now).catch((err: unknown) => console.error("command menu sync failed", err)));
      await handleUpdate(update, {
        db: env.DB,
        tg,
        allowedChatId,
        botUsername: env.BOT_USERNAME,
        now,
        llm: createLlm(env),
        sheet: sheetConfig(env),
        defer: (task) =>
          ctx.waitUntil(task().catch((err: unknown) => console.error("background task failed", err))),
      });
    } catch (err) {
      console.error("webhook failed", err);
    }
    return new Response("ok");
  },

  async scheduled(controller, env): Promise<void> {
    const chatId = parseChatId(env.ALLOWED_CHAT_ID);
    if (chatId === null) {
      console.warn("ALLOWED_CHAT_ID not set; skipping cron", controller.cron);
      return;
    }
    const tg = new Telegram(env.BOT_TOKEN);
    const now = new Date(controller.scheduledTime);
    const llm = createLlm(env);
    const sheet = sheetConfig(env);

    try {
      if (controller.cron === DAILY_CRON) await runDailyJob(env.DB, tg, chatId, now, llm, sheet);
      else if (controller.cron === MONTHLY_CRON) await runMonthlyJob(env.DB, tg, chatId, now, llm, sheet);
      else console.warn("unknown cron", controller.cron);
    } catch (err) {
      console.error(`cron ${controller.cron} failed`, err);
    }
  },
} satisfies ExportedHandler<Env>;

function parseChatId(value: string | undefined): number | null {
  if (!value || !/^-?\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

function timingSafeEqual(a: string, b: string): boolean {
  if (!b) return false;
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}
