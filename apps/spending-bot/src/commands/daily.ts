import { getDailyEnabled, setDailyEnabled } from "../db";
import { USAGE } from "../report/format";
import { reply, type CommandContext } from "./context";

export async function daily(ctx: CommandContext): Promise<void> {
  const arg = ctx.args.trim().toLowerCase();

  if (arg === "") {
    const enabled = await getDailyEnabled(ctx.db, ctx.chatId);
    await reply(ctx, `Tổng kết hằng ngày (21:00) đang ${enabled ? "bật" : "tắt"}.\n${USAGE.daily}`);
    return;
  }
  if (arg !== "on" && arg !== "off") {
    await reply(ctx, USAGE.daily);
    return;
  }

  await setDailyEnabled(ctx.db, ctx.chatId, arg === "on");
  await reply(ctx, arg === "on" ? "Đã bật tổng kết hằng ngày lúc 21:00." : "Đã tắt tổng kết hằng ngày.");
}
