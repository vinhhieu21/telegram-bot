import { categorizePending } from "../ai/categorize";
import { insertExpense, userTotal } from "../db";
import { parseAdd } from "../parse/add";
import { ADD_ERRORS, addedMessage } from "../report/format";
import { currentMonthIct, monthRange, todayIct } from "../time";
import { reply, type CommandContext } from "./context";

export async function add(ctx: CommandContext): Promise<void> {
  const today = todayIct(ctx.now);
  const parsed = parseAdd(ctx.args, today);
  if (!parsed.ok) {
    await reply(ctx, ADD_ERRORS[parsed.reason]);
    return;
  }

  await insertExpense(
    ctx.db,
    {
      chatId: ctx.chatId,
      userId: ctx.user.id,
      amount: parsed.amount,
      note: parsed.note,
      spentOn: parsed.spentOn,
      messageId: ctx.message.message_id,
    },
    ctx.now.toISOString(),
  );

  const month = currentMonthIct(ctx.now);
  const { from, to } = monthRange(month);
  const monthTotal = await userTotal(ctx.db, ctx.chatId, ctx.user.id, from, to);
  await reply(
    ctx,
    addedMessage({
      expense: { amount: parsed.amount, note: parsed.note, spent_on: parsed.spentOn },
      name: ctx.user.first_name,
      today,
      month,
      monthTotal,
    }),
  );

  // After the reply, so the LLM never delays it. Picks up this expense plus any earlier misses.
  const { llm } = ctx;
  if (llm) {
    const nowIso = ctx.now.toISOString();
    ctx.defer(() => categorizePending(ctx.db, llm, ctx.chatId, nowIso));
  }
}
