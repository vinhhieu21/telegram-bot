import type { Llm } from "../ai/llm";
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
  /** null when LLM_MODEL is empty. */
  llm: Llm | null;
  /** Runs `task` after the reply is sent (ctx.waitUntil); errors are logged, never shown. */
  defer: (task: () => Promise<unknown>) => void;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void>;

export function reply(ctx: CommandContext, text: string): Promise<boolean> {
  return ctx.tg.sendMessage(ctx.chatId, text, ctx.message.message_id);
}
