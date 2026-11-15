// The "/" command menu Telegram shows in the group. The Worker registers it itself (it holds the
// bot token), after a webhook update, whenever this list or ALLOWED_CHAT_ID differs from what it
// registered last, so a deploy that changes the commands needs no manual setup step.

import { getBotState, setBotState } from "../db";
import type { BotCommand, BotCommandScope, Telegram } from "../telegram";

export const COMMAND_MENU: BotCommand[] = [
  { command: "add", description: "Ghi khoản chi: /add 50k cafe sáng" },
  { command: "check", description: "Tổng chi của bạn từ đầu tháng" },
  { command: "groupcheck", description: "Tổng chi của cả nhóm từ đầu tháng" },
  { command: "budget", description: "Ngân sách tháng của nhóm: /budget 5tr" },
  { command: "summary", description: "Tổng kết tháng của bạn: /summary 9" },
  { command: "groupsummary", description: "Tổng kết tháng của cả nhóm: /groupsummary 9" },
  { command: "undo", description: "Xoá khoản chi gần nhất, hoặc trả lời tin /add để xoá khoản đó" },
  { command: "daily", description: "Bật/tắt tổng kết hằng ngày: /daily on" },
  { command: "app", description: "Mở biểu đồ chi tiêu" },
  { command: "help", description: "Hướng dẫn" },
];

const STATE_KEY = "command_menu";

/** Until the group is known the menu goes to every group chat; then only to that group. */
function menuScope(allowedChatId: number | null): BotCommandScope {
  return allowedChatId === null ? { type: "all_group_chats" } : { type: "chat", chat_id: allowedChatId };
}

/** What bot_state holds once this menu is registered for this scope. */
export function commandMenuState(allowedChatId: number | null): string {
  return JSON.stringify({ commands: COMMAND_MENU, scope: menuScope(allowedChatId) });
}

/** Registers the menu when it changed. A failed call is logged and retried after the next update. */
export async function syncCommandMenu(db: D1Database, tg: Telegram, allowedChatId: number | null, now: Date): Promise<void> {
  const wanted = commandMenuState(allowedChatId);
  if ((await getBotState(db, STATE_KEY)) === wanted) return;
  if (!(await tg.setMyCommands(COMMAND_MENU, menuScope(allowedChatId)))) return;
  await setBotState(db, STATE_KEY, wanted, now.toISOString());
  console.log("command menu registered");
}
