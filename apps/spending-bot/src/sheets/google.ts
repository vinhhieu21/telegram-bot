// Google Sheets API v4 over plain fetch, signed in as a service account: a JWT signed with
// WebCrypto (RS256) is exchanged for an access token (Google's server-to-server OAuth flow).

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_LIFETIME_S = 3600;
/** Per attempt, so a hung call can never outlive a sync's lease (src/sheets/sync.ts). */
const REQUEST_TIMEOUT_MS = 10_000;
/** Backoff before retrying rate limits, server errors and network failures, as Google asks. */
const RETRY_DELAYS_MS = [500, 2000];
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

/** One request of spreadsheets.batchUpdate, as JSON. */
export type SheetRequest = Record<string, unknown>;

export interface TabInfo {
  sheetId: number;
  title: string;
  index: number;
  /** Whether the tab has a protected range (the bot adds one to each of its tabs). */
  protected: boolean;
}

/** A failed Google call. `status` is the HTTP status, or 0 when there was no usable response. */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

/** "https://docs.google.com/.../edit#gid=123": opens the spreadsheet, on tab `tabId` if given. */
export function spreadsheetUrl(spreadsheetId: string, tabId?: number): string {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
  return tabId === undefined ? url : `${url}#gid=${tabId}`;
}

/** One spreadsheet. Signs in on first use and reuses the token for the object's lifetime (one sync pass). */
export class GoogleSheets {
  private token: Promise<string> | undefined;

  constructor(
    /** The service account's JSON key, as downloaded from Google Cloud. */
    private readonly serviceAccountKey: string,
    private readonly spreadsheetId: string,
  ) {}

  async tabs(): Promise<TabInfo[]> {
    const fields = "sheets(properties(sheetId,title,index),protectedRanges(protectedRangeId))";
    const body = (await this.call(`?fields=${encodeURIComponent(fields)}`)) as {
      sheets?: { properties?: { sheetId?: number; title?: string; index?: number }; protectedRanges?: unknown[] }[];
    };
    // Google leaves out fields whose value is 0, such as the id and index of a spreadsheet's first tab.
    return (body.sheets ?? []).map((sheet) => ({
      sheetId: sheet.properties?.sheetId ?? 0,
      title: sheet.properties?.title ?? "",
      index: sheet.properties?.index ?? 0,
      protected: (sheet.protectedRanges?.length ?? 0) > 0,
    }));
  }

  /** Applies `requests` atomically: all of them or none. */
  async batchUpdate(requests: SheetRequest[]): Promise<void> {
    await this.call(":batchUpdate", JSON.stringify({ requests }));
  }

  private async call(suffix: string, jsonBody?: string): Promise<unknown> {
    this.token ??= fetchAccessToken(this.serviceAccountKey);
    const headers: Record<string, string> = { authorization: `Bearer ${await this.token}` };
    if (jsonBody !== undefined) headers["content-type"] = "application/json";
    return request(`${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}${suffix}`, {
      method: jsonBody === undefined ? "GET" : "POST",
      headers,
      body: jsonBody,
    });
  }
}

async function fetchAccessToken(serviceAccountKey: string): Promise<string> {
  const key = parseServiceAccountKey(serviceAccountKey);
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + TOKEN_LIFETIME_S })),
  ].join(".");

  let signingKey: CryptoKey;
  try {
    signingKey = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(key.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new GoogleApiError(0, "GOOGLE_SERVICE_ACCOUNT_KEY has an unreadable private_key");
  }
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(unsigned));

  const body = (await request(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64url(signature)}`,
    }).toString(),
  })) as { access_token?: unknown };
  if (typeof body.access_token !== "string") throw new GoogleApiError(0, "Google sign-in returned no access token");
  return body.access_token;
}

function parseServiceAccountKey(json: string): { client_email: string; private_key: string } {
  let key: unknown;
  try {
    key = JSON.parse(json);
  } catch {
    throw new GoogleApiError(0, "GOOGLE_SERVICE_ACCOUNT_KEY is missing or not JSON");
  }
  const { client_email, private_key } = (key ?? {}) as Record<string, unknown>;
  if (typeof client_email !== "string" || typeof private_key !== "string") {
    throw new GoogleApiError(0, "GOOGLE_SERVICE_ACCOUNT_KEY has no client_email or private_key");
  }
  return { client_email, private_key };
}

/** fetch with a timeout, retries for transient failures, and Google's error message on failure. */
async function request(url: string, init: RequestInit): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const retryDelay = RETRY_DELAYS_MS[attempt];
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (retryDelay !== undefined) {
        await sleep(retryDelay);
        continue;
      }
      throw new GoogleApiError(0, `Google request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) return res.json();

    const detail = await errorDetail(res);
    if (TRANSIENT_STATUSES.has(res.status) && retryDelay !== undefined) {
      await sleep(retryDelay);
      continue;
    }
    throw new GoogleApiError(res.status, detail);
  }
}

/** "403 PERMISSION_DENIED: The caller does not have permission", from either API's error shape. */
async function errorDetail(res: Response): Promise<string> {
  const text = await res.text();
  let reason = "";
  try {
    const { error, error_description } = JSON.parse(text) as {
      error?: string | { status?: string; message?: string };
      error_description?: string;
    };
    if (typeof error === "string") reason = error_description ? `${error}: ${error_description}` : error;
    else if (error) reason = [error.status, error.message].filter(Boolean).join(": ");
  } catch {
    reason = text;
  }
  return `${res.status} ${reason}`.trim().slice(0, 300);
}

function base64url(data: string | ArrayBuffer): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PEM ("-----BEGIN PRIVATE KEY-----...") to the DER bytes WebCrypto imports. */
function pemToDer(pem: string): ArrayBuffer {
  const binary = atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
