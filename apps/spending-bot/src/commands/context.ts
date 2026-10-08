import type { Telegram, TgMessage, TgUser } from "../telegram";

export interface CommandContext {
  db: D1Database;
  tg: Telegram;
  chatId: number;
  message: TgMessage;
  user: TgUser;
  /** Text after the command name, untrimmed. */
  args: string;
  now: Date;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void>;

export function reply(ctx: CommandContext, text: string): Promise<boolean> {
  return ctx.tg.sendMessage(ctx.chatId, text, ctx.message.message_id);
}
