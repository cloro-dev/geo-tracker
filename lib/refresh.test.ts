import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  closeDatabase,
  hasDatabase,
  resetTables,
} from "../test/db";
import { getDb } from "./db";
import {
  brands,
  extractionState,
  prompts,
  resultBrandMentions,
  results,
  resultSources,
} from "./db/schema";
import { EXTRACTION_STAMP } from "./extract";
import { markAllForReextraction, refreshDerived } from "./refresh";

const describeDb = hasDatabase ? describe : describe.skip;

/** A ChatGPT-shaped payload: prose plus a source rail. */
function answer(text: string, urls: string[] = []) {
  return {
    success: true,
    result: {
      text,
      sources: urls.map((url, index) => ({
        position: index + 1,
        url,
        label: `S${index}`,
      })),
    },
  };
}

async function seedPrompt(): Promise<string> {
  const [row] = await getDb()
    .insert(prompts)
    .values({ name: "p", prompt: "best crm", engines: ["chatgpt"] })
    .returning({ id: prompts.id });
  return row.id;
}

async function seedResult(
  promptId: string,
  response: unknown,
  status: "completed" | "failed" | "pending" = "completed",
): Promise<string> {
  const [row] = await getDb()
    .insert(results)
    .values({
      promptId,
      engine: "chatgpt",
      status,
      response,
      completedAt: new Date(),
    })
    .returning({ id: results.id });
  return row.id;
}

async function seedBrand(
  name: string,
  extra: { domains?: string[]; aliases?: string[] } = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(brands)
    .values({
      name,
      domains: extra.domains ?? [],
      aliases: extra.aliases ?? [],
    })
    .returning({ id: brands.id });
  return row.id;
}

describeDb("refreshDerived", () => {
  beforeAll(applyMigrations);
  beforeEach(resetTables);
  afterAll(closeDatabase);

  it("writes sources and one mention row per brand", async () => {
    const promptId = await seedPrompt();
    const resultId = await seedResult(
      promptId,
      answer("Acme leads the field.", ["https://acme.io/a", "https://b.com/x"]),
    );
    await seedBrand("Acme", { domains: ["acme.io"] });
    await seedBrand("Globex");

    const summary = await refreshDerived();
    expect(summary).toMatchObject({ extracted: 1, sources: 2, skipped: false });

    const db = getDb();
    const sources = await db
      .select()
      .from(resultSources)
      .where(eq(resultSources.resultId, resultId));
    expect(sources.map((s) => s.domain).sort()).toEqual(["acme.io", "b.com"]);

    const mentions = await db
      .select()
      .from(resultBrandMentions)
      .where(eq(resultBrandMentions.resultId, resultId));
    expect(mentions).toHaveLength(2);
    expect(mentions.find((m) => m.mentioned)?.cited).toBe(true);
  });

  it("does nothing at all when no brand is configured", async () => {
    const promptId = await seedPrompt();
    await seedResult(promptId, answer("Acme leads.", ["https://acme.io/a"]));

    expect(await refreshDerived()).toMatchObject({
      extracted: 0,
      skipped: true,
    });

    // Crucially the result is NOT marked extracted, so configuring a brand
    // later still picks it up.
    const [row] = await getDb().select().from(results);
    expect(row.extractionRevision).toBeNull();
  });

  it("leaves pending and failed results alone", async () => {
    const promptId = await seedPrompt();
    await seedResult(promptId, null, "pending");
    await seedResult(promptId, answer("Acme"), "failed");
    await seedBrand("Acme");

    expect(await refreshDerived()).toMatchObject({ extracted: 0 });
  });

  it("is idempotent: a second pass has nothing to do", async () => {
    const promptId = await seedPrompt();
    await seedResult(promptId, answer("Acme", ["https://acme.io/a"]));
    await seedBrand("Acme");

    await refreshDerived();
    expect(await refreshDerived()).toMatchObject({ extracted: 0 });

    const sources = await getDb().select().from(resultSources);
    expect(sources).toHaveLength(1);
  });

  it("stamps the revision it derived a row at", async () => {
    const promptId = await seedPrompt();
    await seedResult(promptId, answer("Acme"));
    await seedBrand("Acme");
    await refreshDerived();

    const [row] = await getDb().select().from(results);
    expect(row.extractionRevision).toBe(EXTRACTION_STAMP);
  });

  it("rebuilds rather than accumulating when a result is re-extracted", async () => {
    const promptId = await seedPrompt();
    await seedResult(promptId, answer("Acme", ["https://acme.io/a"]));
    await seedBrand("Acme");
    await refreshDerived();

    await markAllForReextraction();
    await refreshDerived();

    expect(await getDb().select().from(resultSources)).toHaveLength(1);
    expect(await getDb().select().from(resultBrandMentions)).toHaveLength(1);
  });

  it("reopens the history once when the extraction rules change", async () => {
    const promptId = await seedPrompt();
    await seedResult(promptId, answer("Acme"));
    await seedBrand("Acme");
    await refreshDerived();

    // The stamp now matches, so nothing is reopened on later ticks.
    expect(await refreshDerived()).toMatchObject({ reopened: 0 });

    // Simulate a deploy that changed the rules: the stored stamp no longer
    // agrees with the code's.
    await getDb().update(extractionState).set({ stamp: -1 });

    const summary = await refreshDerived();
    expect(summary.reopened).toBe(1);
    expect(summary.extracted).toBe(1);

    // And it settles: the next tick reopens nothing.
    expect(await refreshDerived()).toMatchObject({ reopened: 0, extracted: 0 });
  });

  it("re-opens history so a newly added brand is scored on old answers", async () => {
    const promptId = await seedPrompt();
    await seedResult(promptId, answer("Acme and Globex both rank."));
    await seedBrand("Acme");
    await refreshDerived();

    await seedBrand("Globex");
    // Adding a brand alone changes nothing — the results are already
    // stamped. This is exactly why the brand-writing path has to call it.
    expect(await refreshDerived()).toMatchObject({ extracted: 0 });

    expect(await markAllForReextraction()).toBe(1);
    await refreshDerived();

    const mentions = await getDb().select().from(resultBrandMentions);
    expect(mentions).toHaveLength(2);
    expect(mentions.every((m) => m.mentioned)).toBe(true);
  });

  it("ignores a disabled brand", async () => {
    const promptId = await seedPrompt();
    await seedResult(promptId, answer("Acme"));
    const brandId = await seedBrand("Acme");
    await getDb()
      .update(brands)
      .set({ enabled: false })
      .where(eq(brands.id, brandId));

    expect(await refreshDerived()).toMatchObject({ skipped: true });
  });

  it("stops on the time budget and reports there is more to do", async () => {
    const promptId = await seedPrompt();
    await seedResult(promptId, answer("Acme"));
    await seedResult(promptId, answer("Acme"));
    await seedBrand("Acme");

    // Clock jumps past the budget right after the batch starts: the first
    // reading is the start time, every later one is well past it.
    let calls = 0;
    const summary = await refreshDerived({
      now: () => (calls++ === 0 ? 0 : 60_000),
    });

    // One result still got done: the budget defers work, it never stalls
    // the queue completely.
    expect(summary).toMatchObject({ extracted: 1, more: true });

    // And the rest is still queued for the next tick.
    expect(await refreshDerived()).toMatchObject({ extracted: 1 });
    expect(await refreshDerived()).toMatchObject({ extracted: 0 });
  });

  it("survives a result whose response is not the shape we expect", async () => {
    const promptId = await seedPrompt();
    await seedResult(promptId, { unexpected: true });
    await seedResult(promptId, answer("Acme"));
    await seedBrand("Acme");

    expect(await refreshDerived()).toMatchObject({ extracted: 2 });
    const mentions = await getDb().select().from(resultBrandMentions);
    expect(mentions).toHaveLength(2);
    expect(mentions.filter((m) => m.mentioned)).toHaveLength(1);
  });

  it("drops derived rows with the result they came from", async () => {
    const promptId = await seedPrompt();
    const resultId = await seedResult(
      promptId,
      answer("Acme", ["https://a.io/x"]),
    );
    await seedBrand("Acme");
    await refreshDerived();

    await getDb().delete(results).where(eq(results.id, resultId));

    expect(await getDb().select().from(resultSources)).toHaveLength(0);
    expect(await getDb().select().from(resultBrandMentions)).toHaveLength(0);
  });
});
