import { undoLastExpense } from "../db";
import { undoneMessage } from "../report/format";
import { reply, type CommandContext } from "./context";

export async function undo(ctx: CommandContext): Promise<void> {
  const removed = await undoLastExpense(ctx.db, ctx.chatId, ctx.user.id, ctx.now.toISOString());
  await reply(ctx, removed ? undoneMessage(removed) : "Bạn không có khoản chi nào để xoá.");
}
