import { describe, expect, it } from "vitest";

import {
  createPromptSchema,
  resultsQuerySchema,
  updatePromptSchema,
} from "./validation";

const valid = {
  name: "best crm tools",
  prompt: "What are the best CRM tools?",
  engines: ["chatgpt"],
};

describe("createPromptSchema", () => {
  it("applies the documented defaults", () => {
    const parsed = createPromptSchema.parse(valid);
    expect(parsed).toMatchObject({
      country: "US",
      runsPerDay: 1,
      enabled: true,
    });
  });

  // cloro expects an upper-case country code; accepting "us" and passing
  // it through would fail at submission time instead of here.
  it("upper-cases the country", () => {
    expect(createPromptSchema.parse({ ...valid, country: "gb" }).country).toBe(
      "GB",
    );
  });

  it("requires at least one engine and rejects unknown ones", () => {
    expect(
      createPromptSchema.safeParse({ ...valid, engines: [] }).success,
    ).toBe(false);
    expect(
      createPromptSchema.safeParse({ ...valid, engines: ["bing"] }).success,
    ).toBe(false);
  });

  it("keeps runsPerDay within what the scheduler can honour", () => {
    expect(
      createPromptSchema.safeParse({ ...valid, runsPerDay: 0 }).success,
    ).toBe(false);
    expect(
      createPromptSchema.safeParse({ ...valid, runsPerDay: 25 }).success,
    ).toBe(false);
    expect(
      createPromptSchema.safeParse({ ...valid, runsPerDay: 24 }).success,
    ).toBe(true);
  });

  it("rejects an empty prompt or name", () => {
    expect(createPromptSchema.safeParse({ ...valid, name: "" }).success).toBe(
      false,
    );
    expect(createPromptSchema.safeParse({ ...valid, prompt: "" }).success).toBe(
      false,
    );
  });

  it("rejects a country that is not two letters", () => {
    expect(
      createPromptSchema.safeParse({ ...valid, country: "USA" }).success,
    ).toBe(false);
  });
});

describe("updatePromptSchema", () => {
  it("accepts a single field", () => {
    expect(updatePromptSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
  });

  it("rejects an empty patch", () => {
    expect(updatePromptSchema.safeParse({}).success).toBe(false);
  });
});

describe("resultsQuerySchema", () => {
  it("defaults the limit and coerces query strings", () => {
    const parsed = resultsQuerySchema.parse({});
    expect(parsed.limit).toBe(50);

    const coerced = resultsQuerySchema.parse({
      limit: "10",
      from: "2026-01-01",
    });
    expect(coerced.limit).toBe(10);
    expect(coerced.from).toBeInstanceOf(Date);
  });

  it("caps the limit so a query cannot pull the whole table", () => {
    expect(resultsQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
  });

  it("only allows the response payload through an explicit opt-in", () => {
    expect(resultsQuerySchema.parse({}).include).toBeUndefined();
    expect(resultsQuerySchema.parse({ include: "response" }).include).toBe(
      "response",
    );
    expect(
      resultsQuerySchema.safeParse({ include: "everything" }).success,
    ).toBe(false);
  });

  it("rejects a promptId that is not a uuid", () => {
    expect(resultsQuerySchema.safeParse({ promptId: "abc" }).success).toBe(
      false,
    );
  });
});
