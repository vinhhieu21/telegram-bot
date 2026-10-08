import { HELP_MESSAGE } from "../report/format";
import { reply, type CommandContext } from "./context";

export async function help(ctx: CommandContext): Promise<void> {
  await reply(ctx, HELP_MESSAGE);
}
