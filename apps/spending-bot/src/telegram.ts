// Minimal Telegram Bot API client over plain fetch.

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  /** Set on edited messages: Unix time of the edit. */
  edit_date?: number;
  /** Forum topics: the topic id, which is the id of the topic's opening message. */
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: TgMessage;
}

export interface TgChatMemberUpdated {
  chat: TgChat;
  from: TgUser;
  new_chat_member: { status: string; user: TgUser };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  my_chat_member?: TgChatMemberUpdated;
}

const MEMBER_STATUSES = new Set(["creator", "administrator", "member"]);

export class Telegram {
  constructor(private readonly token: string) {}

  /**
   * Sends an HTML message, optionally with one link button under it.
   * Returns false (and logs) on failure instead of throwing.
   */
  async sendMessage(chatId: number, text: string, replyTo?: number, button?: { text: string; url: string }): Promise<boolean> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    };
    if (replyTo !== undefined) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    if (button) body.reply_markup = { inline_keyboard: [[button]] };
    return this.call("sendMessage", body);
  }

  async leaveChat(chatId: number): Promise<boolean> {
    return this.call("leaveChat", { chat_id: chatId });
  }

  /**
   * Whether the user is in the chat now. null when Telegram could not say (network, 5xx, rate limit).
   * A user Telegram has never seen in the chat is a 400, which counts as "not a member".
   */
  async isChatMember(chatId: number, userId: number): Promise<boolean | null> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/getChatMember`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, user_id: userId }),
      });
      if (res.status === 400) return false;
      if (!res.ok) {
        console.error("telegram getChatMember failed", res.status, await res.text());
        return null;
      }
      const { result } = await res.json<{ result: { status: string; is_member?: boolean } }>();
      return MEMBER_STATUSES.has(result.status) || (result.status === "restricted" && result.is_member === true);
    } catch (err) {
      console.error("telegram getChatMember error", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async setMyCommands(commands: BotCommand[], scope: BotCommandScope): Promise<boolean> {
    return this.call("setMyCommands", { commands, scope });
  }

  private async call(method: string, body: unknown): Promise<boolean> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      // Never log the URL: it contains the bot token.
      console.error(`telegram ${method} failed`, res.status, await res.text());
    } catch (err) {
      console.error(`telegram ${method} error`, err instanceof Error ? err.message : String(err));
    }
    return false;
  }
}

export interface BotCommand {
  command: string;
  description: string;
}

export type BotCommandScope = { type: "all_group_chats" } | { type: "chat"; chat_id: number };
