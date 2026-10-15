// The engines a prompt can track.
export const ENGINES = [
  "chatgpt",
  "gemini",
  "copilot",
  "perplexity",
  "aimode",
  "google",
  "google-news",
] as const;

export type Engine = (typeof ENGINES)[number];

// The engines that can appear in stored results. cloro discontinued Grok,
// but Grok results from before that stay readable.
export const RESULT_ENGINES = [...ENGINES, "grok"] as const;

const TASK_TYPES: Record<Engine, string> = {
  chatgpt: "CHATGPT",
  gemini: "GEMINI",
  copilot: "COPILOT",
  perplexity: "PERPLEXITY",
  aimode: "AIMODE",
  google: "GOOGLE",
  "google-news": "GOOGLE_NEWS",
};

// Google engines take a `query` field; AI engines take `prompt`.
const QUERY_ENGINES: ReadonlySet<Engine> = new Set(["google", "google-news"]);

export function toTaskType(engine: Engine): string {
  return TASK_TYPES[engine];
}

export function buildPayload(
  engine: Engine,
  prompt: string,
  country: string,
): Record<string, string> {
  return QUERY_ENGINES.has(engine)
    ? { query: prompt, country }
    : { prompt, country };
}

export function isEngine(value: string): value is Engine {
  return (ENGINES as readonly string[]).includes(value);
}
