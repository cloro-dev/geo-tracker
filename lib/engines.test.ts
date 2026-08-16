import { describe, expect, it } from "vitest";

import { ENGINES, buildPayload, isEngine, toTaskType } from "./engines";

describe("toTaskType", () => {
  it("maps every engine to a cloro task type", () => {
    for (const engine of ENGINES) {
      expect(toTaskType(engine)).toMatch(/^[A-Z_]+$/);
    }
  });

  it("converts the hyphenated slug to an underscored task type", () => {
    expect(toTaskType("google-news")).toBe("GOOGLE_NEWS");
  });
});

describe("buildPayload", () => {
  it("sends `prompt` to the AI engines", () => {
    expect(buildPayload("chatgpt", "who sells CRMs?", "US")).toEqual({
      prompt: "who sells CRMs?",
      country: "US",
    });
  });

  // The google endpoints reject a body that carries `prompt`, so this
  // mapping is the difference between a run working and every google
  // result coming back as a validation failure.
  it("sends `query` to the google engines", () => {
    for (const engine of ["google", "google-news"] as const) {
      expect(buildPayload(engine, "crm tools", "GB")).toEqual({
        query: "crm tools",
        country: "GB",
      });
    }
  });

  it("never sends both fields", () => {
    for (const engine of ENGINES) {
      const payload = buildPayload(engine, "x", "US");
      expect("prompt" in payload && "query" in payload).toBe(false);
    }
  });
});

describe("isEngine", () => {
  it("accepts known slugs and rejects everything else", () => {
    expect(isEngine("perplexity")).toBe(true);
    expect(isEngine("bing")).toBe(false);
    expect(isEngine("")).toBe(false);
  });
});
