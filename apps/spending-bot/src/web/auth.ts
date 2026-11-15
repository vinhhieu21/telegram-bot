// Telegram Mini App authentication: the init data Telegram hands the page is signed with a key
// derived from the bot token, so the Worker can trust the user id in it without any login.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

/** How long a Mini App session stays valid. Reopening the app issues fresh init data. */
export const INIT_DATA_MAX_AGE_S = 24 * 60 * 60;

export interface WebAppUser {
  id: number;
  first_name: string;
}

export type InitDataResult = { ok: true; user: WebAppUser } | { ok: false; reason: "invalid" | "expired" };

export async function verifyInitData(initData: string, botToken: string, now: Date): Promise<InitDataResult> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash) || !botToken) return { ok: false, reason: "invalid" };
  params.delete("hash");

  // Every other field, "signature" included, sorted by key, as "key=value" lines.
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), botToken);
  const expected = await hmac(secret, checkString);
  if (!crypto.subtle.timingSafeEqual(expected, hexBytes(hash))) return { ok: false, reason: "invalid" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, reason: "invalid" };
  if (now.getTime() / 1000 - authDate > INIT_DATA_MAX_AGE_S) return { ok: false, reason: "expired" };

  const user = parseUser(params.get("user"));
  return user ? { ok: true, user } : { ok: false, reason: "invalid" };
}

function parseUser(json: string | null): WebAppUser | null {
  if (!json) return null;
  try {
    const user = JSON.parse(json) as Partial<WebAppUser>;
    if (typeof user.id !== "number" || !Number.isSafeInteger(user.id)) return null;
    return { id: user.id, first_name: typeof user.first_name === "string" ? user.first_name : "" };
  } catch {
    return null;
  }
}

async function hmac(key: BufferSource, message: string): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
