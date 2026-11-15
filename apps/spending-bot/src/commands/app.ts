import { APP_MESSAGE, APP_BUTTON } from "../report/format";
import type { CommandContext } from "./context";

/**
 * /app: a button that opens the Mini App. Telegram only allows Mini App buttons in private chats,
 * so in the group it is a t.me link to the bot's Main Mini App (set up in BotFather, see README).
 */
export async function app(ctx: CommandContext): Promise<void> {
  await ctx.tg.sendMessage(ctx.chatId, APP_MESSAGE, ctx.message.message_id, {
    text: APP_BUTTON,
    url: `https://t.me/${ctx.botUsername}?startapp`,
  });
}
