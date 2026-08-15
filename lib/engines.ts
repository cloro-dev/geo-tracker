export const ENGINES = [
  "chatgpt",
  "gemini",
  "copilot",
  "perplexity",
  "grok",
  "aimode",
  "google",
  "google-news",
] as const;

export type Engine = (typeof ENGINES)[number];

const TASK_TYPES: Record<Engine, string> = {
  chatgpt: "CHATGPT",
  gemini: "GEMINI",
  copilot: "COPILOT",
  perplexity: "PERPLEXITY",
  grok: "GROK",
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
