// Minimal LLM client. Callers treat every failure (quota, timeout, bad output) as
// "no answer" and fall back to the plain, SQL-only behaviour.

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** Ask for a JSON object; the caller still validates it. */
  json?: boolean;
}

export interface Llm {
  /** Returns the model's text. Throws on any failure. */
  complete(req: LlmRequest): Promise<string>;
}

const TIMEOUT_MS = 20_000;

/** Workers AI over the `AI` binding. Free plan: requests fail once the daily allowance is used up. */
export class WorkersAiLlm implements Llm {
  constructor(
    private readonly ai: Ai,
    private readonly model: string,
  ) {}

  async complete(req: LlmRequest): Promise<string> {
    const run = this.ai.run(this.model as keyof AiModels, {
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxTokens,
      temperature: 0.2,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
    } as never);
    return extractText(await withTimeout(run, TIMEOUT_MS));
  }
}

/** null when LLM_MODEL is empty: the bot then runs without categories and commentary. */
export function createLlm(env: Pick<Env, "AI" | "LLM_MODEL">): Llm | null {
  const model = env.LLM_MODEL?.trim();
  return model ? new WorkersAiLlm(env.AI, model) : null;
}

/** Workers AI models answer as `{ response }` or as an OpenAI-style chat completion. */
export function extractText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const o = output as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
    if (typeof o.response === "string") return o.response;
    // JSON mode can return the parsed object instead of a string.
    if (o.response && typeof o.response === "object") return JSON.stringify(o.response);
    const content = o.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
  }
  throw new Error("LLM returned no text");
}

/** Parses the first JSON object in the text; models sometimes wrap it in ```json fences. */
export function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("LLM output has no JSON object");
  const value: unknown = JSON.parse(text.slice(start, end + 1));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("LLM output is not a JSON object");
  return value as Record<string, unknown>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
